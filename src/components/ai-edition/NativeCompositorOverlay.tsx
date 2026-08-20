import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { noteUiProbeClipSwitch } from "@/lib/ai-edition/perf/uiFrameProbe";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { assetCameraSource } from "@/lib/ai-edition/timeline/camera";
import { resolveNativePosition } from "@/lib/ai-edition/timeline/timelineMap";
import {
	pushAllNativeParams,
	setActiveClip,
	setCurrentNativeViewId,
	setNativePlaying,
	setNativeScene,
	subscribeNativeCompositor,
	useIsCpuCompositor,
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
		// `undefined` rather than `""` here ONLY because `useNativeCompositorView`
		// treats the key's absence as "no webcam source"; the value still comes from
		// the one accessor, so it can never disagree with the scene or the export.
		return {
			screenPath: primary.originalPath,
			webcamPath: assetCameraSource(primary).path || undefined,
			// sidecar convention (electron/ipc/handlers.ts readCursorRecordingFile) : la
			// télémétrie curseur vit à côté de la vidéo tant qu'elle n'a pas bougé. Absente →
			// le natif ignore juste le curseur (CursorTrack::load échoue silencieusement).
			cursorPath: `${primary.originalPath}.cursor.json`,
		};
	}, [document]);

	const ready = sources !== null;
	const { viewId, error } = useNativeCompositorView(canvasRef, {
		sources: sources ?? undefined,
	});
	const t = useScopedT("editor");
	// No usable GPU: the preview still renders every effect, just slowly (~8 fps with
	// everything on). Nothing is disabled — the output stays identical to the GPU path —
	// so this is a notice, not a degradation warning.
	const cpuCompositor = useIsCpuCompositor();

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

	// SYNCHRO COMPLETE DES PARAMS, en un seul endroit.
	//
	// Avant, chaque groupe de params n'etait pousse que par l'effet de montage du
	// panneau qui le possede (VideoEffectsPane, LayoutPane, CursorPane). Or
	// l'inspecteur n'affiche qu'UN panneau a la fois, donc au chargement les
	// params curseur et layout n'avaient jamais ete pousses et l'addon restait
	// sur ses defauts compiles : un projet en taille de curseur 3.0 s'affichait a
	// 1.0 jusqu'a ce qu'on ouvre le panneau curseur, ou tout se remettait en
	// place -- ce qui donnait l'illusion que le panneau « activait » le curseur.
	//
	// Ici, l'overlay possede deja la vue et pousse deja la scene ; c'est le seul
	// point qui existe quel que soit le panneau affiche.
	//
	// Pas de garde sur `viewId` : `setNativeParam` memoise dans `lastParams` et
	// `setCurrentNativeViewId` le rejoue a l'activation, donc l'ordre de montage
	// n'a pas d'importance. Et ca ne peut pas lutter contre un drag de slider :
	// `setLive` passe par `setDocument`, donc `document` a deja la NOUVELLE
	// valeur a chaque tick -- la meme que celle que le handler vient de pousser.
	const settings = useMemo(() => getEditorSettings(document), [document]);
	useEffect(() => {
		const push = () => pushAllNativeParams(settings);
		push();
		return subscribeNativeCompositor(push);
	}, [settings]);

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
		const camera = assetCameraSource(asset);
		const targetClipId = activeClipId;
		// Sonde de fluidité (diagnostic) : sépare les mesures d'avant et d'après un
		// franchissement de clip, qui se sont déjà révélées non comparables.
		noteUiProbeClipSwitch(previousActiveClipIdRef.current, activeClipId);
		pendingTargetClipIdRef.current = targetClipId;
		previousActiveClipIdRef.current = targetClipId;

		// Pause native across the decoder swap. Deliberately NOT kept in a variable to
		// resume from later — see the `.then` below, which re-reads the live transport.
		if (playing) {
			setNativePlaying(false);
		}

		setActiveClip(
			viewId,
			asset.originalPath,
			camera.path,
			camera.offsetSec,
			activeClipIndex,
			activeSourceTimeSec,
		)
			.then(() => {
				if (pendingTargetClipIdRef.current !== targetClipId) {
					return;
				}
				// Re-read the transport NOW rather than trusting `isPlaying`, captured
				// before the await. Otherwise pausing *during* a clip transition is
				// silently undone: the in-flight `.then` resumes native playback on top
				// of the user's pause, and the preview plays on by itself. The store is
				// the single source of truth for "is the transport playing", so ask it
				// at the moment we'd act on it.
				if (useProjectStore.getState().playing) {
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

	// The render thread died — no D3D11 device on this host, a decoder that refused the
	// recording, etc. There is no second renderer to fall back to (the CPU and web preview
	// paths were removed on purpose), and WARP is not one either: it has no video decoder,
	// so it could not produce a single frame (see `crates/compositor/src/d3d.rs`). All we
	// can do is say so. The canvas would otherwise just stay black, which reads as "the app
	// is slow today" — the native message names the real cause and is worth surfacing raw,
	// since it is what a bug report needs.
	if (error) {
		return (
			<div
				data-testid="native-compositor-error"
				role="alert"
				style={{
					position: "absolute",
					inset: 0,
					zIndex: 0,
					display: "flex",
					flexDirection: "column",
					gap: "0.5rem",
					alignItems: "center",
					justifyContent: "center",
					padding: "1.5rem",
					textAlign: "center",
				}}
			>
				<strong>{t("errors.previewCompositorUnavailable")}</strong>
				<span style={{ maxWidth: "48ch", fontSize: "0.8125rem", opacity: 0.75 }}>{error}</span>
			</div>
		);
	}

	// The canvas's CSS box (width: 100%; height: 100%) is what drives the
	// geometry; the hook manages the DRAWING BUFFER (canvas.width/height DOM
	// attrs) to match the offscreen render-target resolution, and paints each
	// pulled frame via `ctx.putImageData`. z-index 0: sits below the
	// interactive-only DOM layers (zoom gimbal, annotations, webcam drag
	// hitbox) that PreviewCanvas renders after it, but above nothing else —
	// the CPU-rendered video/webcam/blur pixels it replaces are hidden via CSS.
	return (
		<>
			<canvas
				ref={canvasRef}
				data-testid="native-compositor-mount"
				style={{ position: "absolute", inset: 0, zIndex: 0, width: "100%", height: "100%" }}
			/>
			{cpuCompositor && (
				// Persistent rather than a toast: the question it answers ("why is this
				// choppy?") comes up whenever the user looks at the preview, not once at
				// mount. Kept small, low-contrast and pointer-events-none so it never
				// competes with the interactive layers PreviewCanvas stacks above.
				<output
					data-testid="native-compositor-cpu-notice"
					style={{
						position: "absolute",
						left: "50%",
						bottom: "0.75rem",
						transform: "translateX(-50%)",
						zIndex: 1,
						pointerEvents: "none",
						maxWidth: "min(90%, 46ch)",
						padding: "0.25rem 0.625rem",
						borderRadius: "999px",
						fontSize: "0.75rem",
						lineHeight: 1.3,
						textAlign: "center",
						background: "rgb(0 0 0 / 0.55)",
						color: "rgb(255 255 255 / 0.92)",
					}}
				>
					{t("cpuCompositor.notice")}
				</output>
			)}
		</>
	);
}
