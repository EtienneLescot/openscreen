import { useEffect, useRef, useState } from "react";
import { setCurrentNativeViewId, useNativeCompositorView } from "@/native";

/**
 * POC Option A — monte une fenêtre D3D11 native (compositeur poc-d3d, via
 * `compositor_view.node`) par-dessus la zone preview, positionnée sur ce `<div>`
 * placeholder et pilotée par `useNativeCompositorView`. La fenêtre native rend
 * le compositing ; le `<div>` ne sert qu'à donner sa géométrie (le hook sync le
 * rect natif au resize/scroll).
 *
 * F3 : avant de créer la vue, on résout les vraies sources de l'enregistrement
 * (screen + webcam, deux fichiers H264 séparés) via la session courante, pour que
 * le natif compose TON clip et pas la fixture. Session absente (projet rechargé,
 * web pur) → fallback fixture. Enregistrement sans caméra → webcam fixture (le
 * compositeur compose toujours une webcam ; le no-webcam viendra avec les presets).
 *
 * Aucun contrôle ici : les paramètres viennent de l'inspector (barre latérale) via
 * le store `nativeCompositorStore` (`setNativeParam`), la lecture via
 * `useNativePlaybackSync`, l'export via la vraie modale (`ExportDialog`).
 *
 * Opt-in via le flag Vite `VITE_NATIVE_COMPOSITOR=1`.
 */
export function NativeCompositorOverlay({ enabled }: { enabled: boolean }) {
	const mountRef = useRef<HTMLDivElement>(null);
	// `null` = résolution en cours ; `{}` = résolu sans session (→ fixture) ;
	// `{screenPath,…}` = vraies sources. On attend la résolution avant de créer la
	// vue (sources lues une fois à la création) pour éviter un re-create fixture→réel.
	const [sources, setSources] = useState<{
		screenPath?: string;
		webcamPath?: string;
	} | null>(null);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const result = await window.electronAPI?.getCurrentRecordingSession?.();
				if (cancelled) {
					return;
				}
				const session = result?.success ? result.session : null;
				setSources(
					session?.screenVideoPath
						? { screenPath: session.screenVideoPath, webcamPath: session.webcamVideoPath }
						: {},
				);
			} catch {
				if (!cancelled) {
					setSources({});
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [enabled]);

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
