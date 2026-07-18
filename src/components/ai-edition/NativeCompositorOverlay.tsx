import { useEffect, useMemo, useRef } from "react";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { setCurrentNativeViewId, setNativeScene, useNativeCompositorView } from "@/native";
import { buildSceneDescription } from "@/native/sceneDescription";

/**
 * POC Option A — monte une fenêtre D3D11 native (compositeur poc-d3d, via
 * `compositor_view.node`) par-dessus la zone preview, positionnée sur ce `<div>`
 * placeholder et pilotée par `useNativeCompositorView`. La fenêtre native rend
 * le compositing ; le `<div>` ne sert qu'à donner sa géométrie (le hook sync le
 * rect natif au resize/scroll).
 *
 * F3 : les sources natives (screen + webcam) sont résolues depuis l'**asset primaire
 * du document courant** — donc ce que l'éditeur affiche réellement. (On lisait avant
 * `getCurrentRecordingSession()` = le dernier *enregistré*, qui pouvait pointer sur un
 * ancien clip → on voyait « l'ancien clip » sous le blur.) Pas d'asset / pas de doc →
 * fallback fixture. Le hook recrée la vue si le chemin screen change (changement de projet).
 *
 * Aucun contrôle ici : paramètres via l'inspector (`setNativeParam`), lecture via
 * `useNativePlaybackSync`, export via la vraie modale (`ExportDialog`).
 *
 * Opt-in via le flag Vite `VITE_NATIVE_COMPOSITOR=1`.
 */
export function NativeCompositorOverlay({ enabled }: { enabled: boolean }) {
	const mountRef = useRef<HTMLDivElement>(null);
	const document = useProjectStore((s) => s.document);

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
