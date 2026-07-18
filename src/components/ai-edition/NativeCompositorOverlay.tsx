import { useEffect, useRef } from "react";
import { setCurrentNativeViewId, useNativeCompositorView } from "@/native";

/**
 * POC Option A — monte une fenêtre D3D11 native (compositeur poc-d3d, via
 * `compositor_view.node`) par-dessus la zone preview, positionnée sur ce `<div>`
 * placeholder et pilotée par `useNativeCompositorView`. La fenêtre native rend
 * le compositing ; le `<div>` ne sert qu'à donner sa géométrie (le hook sync le
 * rect natif au resize/scroll).
 *
 * Aucun contrôle ici : les paramètres viennent de l'inspector (barre latérale) via
 * le store `nativeCompositorStore` (`setNativeParam`), la lecture via
 * `useNativePlaybackSync`, et l'export via la vraie modale (`ExportDialog`). Le
 * `<div>` est recouvert par la fenêtre native, donc on n'y met rien de cliquable.
 *
 * Opt-in via le flag Vite `VITE_NATIVE_COMPOSITOR=1` : par défaut le composant ne
 * rend rien et la preview web existante reste inchangée.
 */
export function NativeCompositorOverlay({ enabled }: { enabled: boolean }) {
	const mountRef = useRef<HTMLDivElement>(null);
	const { viewId } = useNativeCompositorView(mountRef, { enabled });

	// publie l'id de la vue active dans le store → l'inspector (autre composant) peut
	// pousser des params via setNativeParam sans connaître cet overlay.
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
