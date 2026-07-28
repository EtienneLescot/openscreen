import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { I18nProvider } from "./contexts/I18nContext";
import { clearStaleSourceCache } from "./lib/exporter/localSourceFile";
import "./hooks/rendererConsoleForwarder";
import "./index.css";

const windowType = new URLSearchParams(window.location.search).get("windowType") || "";

// The export bench replaces the UI entirely rather than rendering alongside it,
// so nothing competes with the export for the GPU or the main thread.
if (windowType === "bench") {
	void import("./bench/runBench").then((m) => m.runBench());
}

// Reclaim multi-GB OPFS source copies left behind by a previous session (they
// are only pruned opportunistically during the next large-file load otherwise).
// Nothing is referenced at startup, so everything stale is safe to remove.
if (!windowType) {
	window.setTimeout(() => {
		clearStaleSourceCache().catch(() => undefined);
	}, 5_000);
}
const showNotes = new URLSearchParams(window.location.search).get("showNotes") === "true";
if (
	showNotes ||
	windowType === "hud-overlay" ||
	windowType === "source-selector" ||
	windowType === "countdown-overlay"
) {
	document.body.style.background = "transparent";
	document.documentElement.style.background = "transparent";
	document.getElementById("root")?.style.setProperty("background", "transparent");
}

if (windowType !== "bench") {
	ReactDOM.createRoot(document.getElementById("root")!).render(
		<React.StrictMode>
			<I18nProvider>
				<App />
			</I18nProvider>
		</React.StrictMode>,
	);
}
