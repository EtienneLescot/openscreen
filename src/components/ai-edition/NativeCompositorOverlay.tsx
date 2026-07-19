import { useEffect, useMemo, useRef } from "react";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	setActiveClip,
	setCurrentNativeViewId,
	setNativeScene,
	useNativeCompositorView,
} from "@/native";
import { buildSceneDescription } from "@/native/sceneDescription";

/**
 * POC Option A — monte une fenêtre D3D11 native (compositeur poc-d3d, via
 * `compositor_view.node`) par-dessus la zone preview, positionnée sur ce `<div>`
 * placeholder et pilotée par `useNativeCompositorView`. La fenêtre native rend
 * le compositing ; le `<div>` ne sert qu'à donner sa géométrie (le hook sync le
 * rect natif au resize/scroll).
 *
 * F3 : la vue est amorcée avec les sources de l'**asset primaire du document courant**
 * (fallback fixture sans asset/document), puis `setActiveClip` remplace screen + webcam quand
 * le playhead entre dans un autre clip. Le hook recrée seulement la vue si le chemin screen
 * primaire change (changement de projet), pas à chaque frontière de clip.
 *
 * Aucun contrôle ici : paramètres via l'inspector (`setNativeParam`), lecture via
 * `useNativePlaybackSync`, export via la vraie modale (`ExportDialog`).
 *
 * Opt-in via le flag Vite `VITE_NATIVE_COMPOSITOR=1`.
 */
export function NativeCompositorOverlay({ enabled }: { enabled: boolean }) {
	const mountRef = useRef<HTMLDivElement>(null);
	const previousActiveClipIdRef = useRef<string | null>(null);
	const document = useProjectStore((s) => s.document);
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);

	const orderedClips = useMemo(
		() =>
			document
				? [...document.timeline.clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec)
				: [],
		[document],
	);
	const activeClip = useMemo(() => {
		return (
			orderedClips.find((clip, index) => {
				const isLast = index === orderedClips.length - 1;
				return (
					currentTimeSec >= clip.timelineStartSec &&
					(currentTimeSec < clip.timelineEndSec ||
						(isLast && currentTimeSec <= clip.timelineEndSec))
				);
			}) ?? null
		);
	}, [orderedClips, currentTimeSec]);

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
			webcamPath: primary.cameraTrack?.sourcePath ?? undefined,
			// sidecar convention (electron/ipc/handlers.ts readCursorRecordingFile) : la
			// télémétrie curseur vit à côté de la vidéo tant qu'elle n'a pas bougé. Absente →
			// le natif ignore juste le curseur (CursorTrack::load échoue silencieusement).
			cursorPath: `${primary.originalPath}.cursor.json`,
		};
	}, [document]);

	const ready = sources !== null;
	const { viewId } = useNativeCompositorView(mountRef, {
		enabled: enabled && ready,
		sources: sources ?? undefined,
	});

	// publie l'id de la vue active dans le store → l'inspector peut pousser des params
	// via setNativeParam sans connaître cet overlay.
	useEffect(() => {
		previousActiveClipIdRef.current = null;
		setCurrentNativeViewId(viewId);
		return () => setCurrentNativeViewId(null);
	}, [viewId]);

	// Pousse la scène (document → SceneDescription → JSON) au natif quand le document change ou
	// la vue s'active : le layout preset et cie pilotent le rendu (remplace le layout fixture).
	// Effet APRÈS celui du viewId ci-dessus → currentViewId est déjà publié quand on pousse.
	useEffect(() => {
		if (viewId === null || !document) {
			return;
		}
		try {
			setNativeScene(JSON.stringify(buildSceneDescription(document)));
		} catch (error) {
			console.warn("[compositor-view] build/push scene failed:", error);
		}
	}, [viewId, document]);

	// Change les décodeurs screen/webcam uniquement quand le playhead entre dans un autre clip.
	// `currentTimeSec` est déjà rafraîchi par la boucle de lecture existante ; aucun timer dédié.
	useEffect(() => {
		if (viewId === null || !document) {
			return;
		}
		if (!activeClip) {
			previousActiveClipIdRef.current = null;
			return;
		}
		if (previousActiveClipIdRef.current === activeClip.id) {
			return;
		}
		const asset = document.assets.find((candidate) => candidate.id === activeClip.assetId);
		if (!asset?.originalPath) {
			return;
		}
		const cam = asset.cameraTrack;
		setActiveClip(
			viewId,
			asset.originalPath,
			cam?.sourcePath ?? asset.originalPath,
			cam ? (cam.startMs + cam.offsetMs) / 1000 : 0,
		).catch((error: unknown) => {
			console.warn("[compositor-view] setActiveClip failed:", error);
		});
		previousActiveClipIdRef.current = activeClip.id;
	}, [viewId, document, activeClip]);

	if (!enabled) {
		return null;
	}

	// placeholder : sert de géométrie à la fenêtre D3D native (le hook sync le rect).
	return (
		<div
			ref={mountRef}
			data-testid="native-compositor-mount"
			style={{ position: "absolute", inset: 0, zIndex: 5 }}
		/>
	);
}
