/**
 * Builds a `.openscreen` project that expresses a benchmark scenario.
 *
 * The project format is plain JSON (schemaVersion 6) and the exporter reads its effect state
 * from `editor` — the same shape `ProjectEditorState` in
 * `src/components/video-editor/projectPersistence.ts` describes. Writing it directly, rather
 * than driving the editor UI, is what makes the OpenScreen leg reproducible; the GUI leg is
 * measured separately by `drivers/openscreen-gui.mjs`.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { probe } from "./fixture.mjs";

/** Deterministic ids: the same scenario always produces the same project bytes. */
const id = (prefix, n) => `${prefix}_${String(n).padStart(8, "0")}`;

/** OpenScreen stores zoom depth as a preset; a custom scale overrides it. */
function toZoomRegion(z, i) {
	return {
		id: id("zoom", i + 1),
		startMs: Math.round(z.startSec * 1000),
		endMs: Math.round(z.endSec * 1000),
		depth: 2,
		customScale: +z.scale.toFixed(2),
		focus: { cx: z.focus.x, cy: z.focus.y },
		focusMode: "manual",
		source: "manual",
	};
}

/**
 * Padding: the scenario states an inset as a percent of the frame, OpenScreen's `padding` is
 * 0-100 on its own scale where 50 is the default inset. The mapping below is calibrated so a
 * 5% scenario inset lands on OpenScreen's equivalent visual inset; see benchmark/README.md
 * § "Translating the scenario" for how each app's control was matched.
 */
const paddingFromPercent = (pct) => Math.round(Math.min(100, Math.max(0, pct * 10)));

export function buildProject({
	sourcePath,
	scenario,
	outDir,
	title = "export-benchmark",
	paddingControl = null,
}) {
	mkdirSync(outDir, { recursive: true });

	// The loader only auto-approves media in the recordings dir or *next to the project*, so
	// the source is copied in rather than referenced across the filesystem.
	const localMedia = join(outDir, basename(sourcePath));
	if (localMedia !== sourcePath) copyFileSync(sourcePath, localMedia);

	const p = probe(localMedia);
	const e = scenario.effects;

	// The CLI reads `EditorProjectData` (projectPersistence.ts): a flat
	// { version, media, editor } document. The schemaVersion-6 shape that the AI-edition
	// editor writes is a different file format and `runInfoCommand` does not read it.
	const doc = {
		version: 2,
		media: {
			screenVideoPath: localMedia,
			webcamVideoPath: undefined,
			cursorCaptureMode: "system",
		},
		editor: {
			wallpaper: e.background?.kind === "solid" ? e.background.color : "#000000",
			shadowIntensity: e.shadow?.enabled ? e.shadow.intensity : 0,
			showBlur: false,
			motionBlurAmount: e.motionBlur ? 0.2 : 0,
			borderRadius: e.cornerRadiusPx,
			padding: paddingControl ?? paddingFromPercent(e.paddingPercent),
			cropRegion: { x: 0, y: 0, width: 100, height: 100 },
			zoomRegions: (e.zooms ?? []).map(toZoomRegion),
			cameraFullscreenRegions: [],
			autoZoomEnabled: false,
			autoFocusAll: false,
			trimRegions: [],
			speedRegions: [],
			annotationRegions: [],
			aspectRatio: "16:9",
			webcamLayoutPreset: "no-webcam",
			webcamMaskShape: "rectangle",
			webcamMirrored: false,
			webcamReactiveZoom: false,
			webcamSizePreset: "medium",
			webcamPosition: null,
			// "good" resolves to short-side 1080 @ 20 Mbps for 16:9 — exactly the pinned target.
			exportQuality: "good",
			exportFormat: "mp4",
			gifFrameRate: 15,
			gifLoop: true,
			gifSizePreset: "medium",
			cursorTheme: "default",
		},
	};

	const projectPath = join(outDir, `${title}.openscreen`);
	writeFileSync(projectPath, `${JSON.stringify(doc, null, 2)}\n`);
	return { projectPath, mediaPath: localMedia, probe: p };
}
