import { useRef, useState } from "react";
import { useNativeCompositorView } from "@/native";

/**
 * POC Option A — monte une fenêtre D3D11 native (compositeur poc-d3d, via
 * `compositor_view.node`) par-dessus la zone preview, positionnée sur ce `<div>`
 * placeholder et pilotée par `useNativeCompositorView`. La fenêtre native rend
 * le compositing ; le `<div>` ne sert qu'à donner sa géométrie (le hook sync le
 * rect natif au resize/scroll).
 *
 * Opt-in via le flag Vite `VITE_NATIVE_COMPOSITOR=1` : par défaut le composant ne
 * rend rien et la preview web existante reste inchangée.
 */
export function NativeCompositorOverlay({ enabled }: { enabled: boolean }) {
	const mountRef = useRef<HTMLDivElement>(null);
	const { setParam } = useNativeCompositorView(mountRef, { enabled });
	const [blur, setBlur] = useState(false);

	if (!enabled) {
		return null;
	}

	return (
		<>
			{/* placeholder : sert de géométrie à la fenêtre D3D native (le hook sync le rect).
			    Il est recouvert par la fenêtre native, donc on n'y met aucun contrôle. */}
			<div
				ref={mountRef}
				data-testid="native-compositor-mount"
				style={{ position: "absolute", inset: 0, zIndex: 5 }}
			/>
			{/* contrôle en position fixe hors de la zone preview → non recouvert par l'overlay natif */}
			<label
				style={{
					position: "fixed",
					top: 64,
					left: 16,
					zIndex: 99999,
					display: "flex",
					alignItems: "center",
					gap: 6,
					background: "rgba(0,0,0,0.7)",
					color: "#fff",
					padding: "5px 9px",
					borderRadius: 6,
					font: "12px system-ui",
					pointerEvents: "auto",
				}}
			>
				<input
					type="checkbox"
					checked={blur}
					onChange={(e) => {
						setBlur(e.target.checked);
						setParam("backgroundBlur", e.target.checked);
					}}
				/>
				Background blur (native)
			</label>
		</>
	);
}
