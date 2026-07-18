import { useRef, useState } from "react";
import { exportNative, useNativeCompositorView } from "@/native";

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
	const [exporting, setExporting] = useState(false);
	const [exportStatus, setExportStatus] = useState("");

	if (!enabled) {
		return null;
	}

	const runExport = async () => {
		setExporting(true);
		setExportStatus("Exporting… (preview paused)");
		try {
			const s = await exportNative();
			setExportStatus(`${s.fps.toFixed(1)} fps · ${s.wallS.toFixed(2)}s · ${s.frames} frames`);
		} catch (err) {
			setExportStatus("export failed");
			console.warn("[compositor-view] export failed:", err);
		} finally {
			setExporting(false);
		}
	};

	return (
		<>
			{/* placeholder : sert de géométrie à la fenêtre D3D native (le hook sync le rect).
			    Il est recouvert par la fenêtre native, donc on n'y met aucun contrôle. */}
			<div
				ref={mountRef}
				data-testid="native-compositor-mount"
				style={{ position: "absolute", inset: 0, zIndex: 5 }}
			/>
			{/* contrôles en position fixe hors de la zone preview → non recouverts par l'overlay natif */}
			<div
				style={{
					position: "fixed",
					top: 64,
					left: 16,
					zIndex: 99999,
					display: "flex",
					flexDirection: "column",
					gap: 6,
					background: "rgba(0,0,0,0.72)",
					color: "#fff",
					padding: "8px 10px",
					borderRadius: 8,
					font: "12px system-ui",
					pointerEvents: "auto",
				}}
			>
				<label style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
				<button
					type="button"
					disabled={exporting}
					onClick={runExport}
					style={{
						cursor: exporting ? "default" : "pointer",
						padding: "4px 8px",
						borderRadius: 5,
						border: "none",
						background: "#22dd88",
						color: "#000",
						font: "12px system-ui",
					}}
				>
					{exporting ? "Exporting…" : "Export (native)"}
				</button>
				{exportStatus && <div style={{ opacity: 0.9 }}>{exportStatus}</div>}
			</div>
		</>
	);
}
