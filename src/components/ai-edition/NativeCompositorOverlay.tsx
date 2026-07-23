import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { resolveNativePosition } from "@/lib/ai-edition/timeline/timelineMap";
import {
	setActiveClip,
	setCurrentNativeViewId,
	setNativePlaying,
	setNativeScene,
	useNativeCompositorView,
} from "@/native";
import { buildSceneDescription, resolveVisibleClips } from "@/native/sceneDescription";
import {
	getWebcamNativeSize,
	getWebcamNativeSizeRevision,
	subscribeWebcamNativeSize,
} from "@/native/webcamSizeCache";

/**
 * POC Option A — preview rendue par le compositeur D3D11 natif (`compositor_view.node`),
 * streamée dans un `<canvas>` via `readFrame`. Le compositor tourne OFFSCREEN
 * (pas de fenêtre OS à parenter), donc il n'y a plus de problème de z-index
 * Chromium : le canvas EST un élément DOM, et toute la chaîne d'événements
 * (zoom-region drag handle, modales…) le gère naturellement. La géométrie
 * de rendu vient du `getBoundingClientRect()` du canvas (le hook sync le rect
 * natif au resize/scroll, et met à jour `canvas.width`/`height` pour
 * correspondre au buffer de pixels).
 *
 * F3 : la vue est amorcée avec les sources de l'**asset primaire du document courant**
 * (fallback fixture sans asset/document), puis `setActiveClip` remplace screen + webcam quand
 * le playhead entre dans un autre clip. Le hook recrée seulement la vue si le chemin screen
 * primaire change (changement de projet), pas à chaque frontière de clip.
 *
 * Aucun contrôle ici : paramètres via l'inspector (`setNativeParam`), lecture via
 * `useNativePlaybackSync`, export via la vraie modale (`ExportDialog`).
 *
 * Chemin unique : c'est le SEUL renderer de preview (plus de fallback web/CPU).
 * Monté par `PreviewCanvas` en premier enfant de `.previewFrame`, sous les
 * calques interactifs (zoom gimbal, annotations, drag webcam) qui restent des
 * éléments DOM cliquables au-dessus.
 */
export function NativeCompositorOverlay() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const previousActiveClipIdRef = useRef<string | null>(null);
	const document = useProjectStore((s) => s.document);
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);
	// ponytail: re-render whenever the webcam dim cache changes (the WebcamOverlay
	// mounts AFTER the first scene push and only knows the real dims once the <video>
	// fires loadedmetadata; subscribing here re-triggers the scene push so the native
	// compositor stops sizing its box for a hardcoded 4:3 once the real aspect arrives).
	const _webcamSizeRevision = useSyncExternalStore(
		subscribeWebcamNativeSize,
		getWebcamNativeSizeRevision,
		() => 0,
	);

	// `currentTimeSec` est en temps RAW/document (la règle où les trims occupent encore leur
	// place — même référentiel que le playhead V4 et l'overlay webcam web). Le natif, lui, joue
	// les segments COMPACTÉS (`resolveVisibleClips`, trims retirés) — le même flux que la SCÈNE
	// envoyée via `setNativeScene`. `resolveNativePosition` fait le pont : il mappe le playhead
	// RAW → temps source via le layout RAW (`document.timeline.clips`) PUIS localise le segment
	// compacté correspondant, d'où sortent le `clipIndex` natif et la bonne paire écran/webcam.
	// Sans ça (ancien `resolveNativePlaybackPosition(nativeClips, currentTimeSec)`), un playhead
	// RAW lu contre des clips compactés désignait le mauvais clip après un trim → mauvaise caméra
	// + décalage écran/cam.
	const nativeClips = useMemo(() => {
		if (!document) return [];
		return resolveVisibleClips(document);
	}, [document]);
	const activePosition = useMemo(
		() => resolveNativePosition(currentTimeSec, nativeClips, document?.timeline.clips ?? []),
		[nativeClips, currentTimeSec, document],
	);
	const activeClip = activePosition?.clip ?? null;

	// `null` = document pas encore chargé (on attend) ; `{}` = chargé sans asset (→ fixture) ;
	// `{screenPath,…}` = vraies sources de l'asset primaire.
	const sources = useMemo(() => {
		if (!document) {
			return null;
		}
		const primary =
			document.assets.find((a) => a.id === document.project.primaryAssetId) ?? document.assets[0];
		if (!primary?.originalPath) {
			return {};
		}
		return {
			screenPath: primary.originalPath,
			webcamPath:
				primary.cameraTrack?.visible && primary.cameraTrack.sourcePath
					? primary.cameraTrack.sourcePath
					: undefined,
			// sidecar convention (electron/ipc/handlers.ts readCursorRecordingFile) : la
			// télémétrie curseur vit à côté de la vidéo tant qu'elle n'a pas bougé. Absente →
			// le natif ignore juste le curseur (CursorTrack::load échoue silencieusement).
			cursorPath: `${primary.originalPath}.cursor.json`,
		};
	}, [document]);

	const ready = sources !== null;
	const { viewId } = useNativeCompositorView(canvasRef, {
		sources: sources ?? undefined,
	});

	// publie l'id de la vue active dans le store → l'inspector peut pousser des params
	// via setNativeParam sans connaître cet overlay.
	useEffect(() => {
		previousActiveClipIdRef.current = null;
		setCurrentNativeViewId(viewId);
		return () => setCurrentNativeViewId(null);
	}, [viewId]);

	// Pousse la scène (document → SceneDescription → JSON) au natif quand le document change,
	// la vue s'active, OU que la taille réelle de la webcam active vient d'être sondée (voir
	// `_webcamSizeRevision` ci-dessus) : le layout preset et cie pilotent le rendu (remplace le
	// layout fixture). Effet APRÈS celui du viewId ci-dessus → currentViewId est déjà publié
	// quand on pousse.
	// biome-ignore lint/correctness/useExhaustiveDependencies: size revision
	useEffect(() => {
		if (viewId === null || !document) {
			return;
		}
		try {
			const activeWebcamPath = sources && "webcamPath" in sources ? sources.webcamPath : undefined;
			const webcamSourceSize = activeWebcamPath ? getWebcamNativeSize(activeWebcamPath) : null;
			const scene = buildSceneDescription(document, webcamSourceSize);
			setNativeScene(JSON.stringify(scene));
		} catch (error) {
			console.warn("[compositor-view] build/push scene failed:", error);
		}
		// _webcamSizeRevision itself isn't read in the body — it's a dependency purely to
		// re-trigger this effect when the probed-size cache mutates; the actual value is
		// re-read fresh via getWebcamNativeSize() above on every run (biome flags this as
		// an "unnecessary" dependency, but removing it would mean a probed webcam size
		// arriving after mount never gets pushed to native).
	}, [viewId, document, sources, _webcamSizeRevision]);

	const activeClipId = activeClip?.id ?? null;
	const activeClipIndex = activePosition?.clipIndex ?? null;
	const activeSourceTimeSec = activePosition?.sourceTimeSec ?? null;
	const pendingTargetClipIdRef = useRef<string | null>(null);

	const playing = useProjectStore((s) => s.playing);

	// Change les décodeurs screen/webcam uniquement quand le playhead entre dans un autre clip.
	useEffect(() => {
		if (
			viewId === null ||
			!document ||
			!activeClipId ||
			!activeClip ||
			activeClipIndex === null ||
			activeSourceTimeSec === null
		) {
			return;
		}
		if (previousActiveClipIdRef.current === activeClipId) {
			return;
		}
		const asset = document.assets.find((candidate) => candidate.id === activeClip.assetId);
		if (!asset?.originalPath) {
			return;
		}
		const cam = asset.cameraTrack;
		const webcamPath = cam && cam.visible && cam.sourcePath ? cam.sourcePath : "";
		const targetClipId = activeClipId;
		pendingTargetClipIdRef.current = targetClipId;
		previousActiveClipIdRef.current = targetClipId;

		const isPlaying = playing;
		if (isPlaying) {
			setNativePlaying(false);
		}

		setActiveClip(
			viewId,
			asset.originalPath,
			webcamPath,
			cam ? (cam.startMs + cam.offsetMs) / 1000 : 0,
			activeClipIndex,
			activeSourceTimeSec,
		)
			.then(() => {
				if (pendingTargetClipIdRef.current !== targetClipId) {
					return;
				}
				if (isPlaying) {
					setNativePlaying(true);
				}
			})
			.catch((error: unknown) => {
				console.warn("[compositor-view] setActiveClip failed:", error);
				if (previousActiveClipIdRef.current === targetClipId) {
					previousActiveClipIdRef.current = null;
				}
			});
	}, [viewId, document, activeClipId, activeClip, activeClipIndex, activeSourceTimeSec, playing]);

	if (!ready) {
		return null;
	}

	// The canvas's CSS box (width: 100%; height: 100%) is what drives the
	// geometry; the hook manages the DRAWING BUFFER (canvas.width/height DOM
	// attrs) to match the offscreen render-target resolution, and paints each
	// pulled frame via `ctx.putImageData`. z-index 0: sits below the
	// interactive-only DOM layers (zoom gimbal, annotations, webcam drag
	// hitbox) that PreviewCanvas renders after it, but above nothing else —
	// the CPU-rendered video/webcam/blur pixels it replaces are hidden via CSS.
	return (
		<canvas
			ref={canvasRef}
			data-testid="native-compositor-mount"
			style={{ position: "absolute", inset: 0, zIndex: 0, width: "100%", height: "100%" }}
		/>
	);
}
