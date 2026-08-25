/**
 * Scenario definitions.
 *
 * A scenario is the *edit* that sits between the source clip and the export button, plus the
 * output the export must produce. It is declared once, app-agnostically, and each driver
 * translates it into its own app's controls. Anything a driver cannot express is reported as
 * an unsupported feature on that run rather than silently dropped — an app that skips the
 * shadow pass is not comparable to one that renders it, and the report has to say so.
 */

/** The output every app is pinned to. "Force identical output" is the whole point. */
/**
 * 60 fps rather than 30 is not a preference: OpenScreen's MP4 export path is fixed at 60
 * (`MP4_EXPORT_FPS`, src/cli/CliExportRunner.tsx), and every other app in the set can be told
 * to emit 60. It is therefore the only frame rate on which "force identical output" is
 * actually achievable — and it is what this category ships anyway, because the zoom and
 * cursor-smoothing effects it sells are what 60 fps is for.
 */
export const TARGET_OUTPUT = {
	container: "mp4",
	videoCodec: "h264",
	width: 1920,
	height: 1080,
	fps: 60,
	/** Tolerances used when verifying an export actually hit the target. */
	tolerance: { durationSec: 0.75, fpsPercent: 5 },
};

/**
 * Effects, in the vocabulary every app in this category shares. Values are chosen to sit on
 * each app's own presets where possible, so no driver has to type a number into a field that
 * only exists in one product.
 */
export const SCENARIOS = {
	/**
	 * The realistic product-demo export: the recording inset on a coloured background with
	 * rounded corners and a drop shadow, plus three zooms. This is what the category actually
	 * ships, and it exercises every stage of a compositor — background fill, transform, mask,
	 * blur, and animated scaling.
	 */
	"full-demo": {
		id: "full-demo",
		label:
			"Full demo (wallpaper, padding, radius, shadow, 3 zooms, motion blur, rendered cursor, webcam PiP)",
		effects: {
			/**
			 * An image, not a flat colour. A fill is one clear; a wallpaper is a texture fetch
			 * for every pixel of every frame, which is what these apps actually do.
			 */
			background: { kind: "image", asset: "wallpaper" },
			/** Inset of the recording inside the frame, as a percent of the frame's short side. */
			paddingPercent: 5,
			cornerRadiusPx: 40,
			shadow: { enabled: true, intensity: 0.2 },
			/**
			 * Zooms are given in seconds and as a scale factor so every app can express them.
			 * Focus is normalised (0..1) against the source frame.
			 */
			zooms: [
				{ startSec: 6, endSec: 12, scale: 1.8, focus: { x: 0.32, y: 0.38 } },
				{ startSec: 22, endSec: 29, scale: 2.2, focus: { x: 0.62, y: 0.55 } },
				{ startSec: 41, endSec: 48, scale: 1.6, focus: { x: 0.45, y: 0.7 } },
			],
			/** Blurs the composited frame along its motion — a full-frame pass per frame. */
			motionBlur: { enabled: true, amount: 0.5 },
			/**
			 * The pointer is rendered by the app from telemetry, not baked into the source: a
			 * themed sprite, positional smoothing, its own motion blur, and a click effect. This
			 * is a large share of what a demo export costs and the first version of this
			 * scenario measured none of it.
			 */
			cursor: {
				enabled: true,
				sizePercent: 150,
				smoothing: 0.7,
				motionBlur: true,
				clickEffects: true,
			},
			/**
			 * A second video stream to decode, scale, mask and shadow every frame. Apps that
			 * cannot place a camera inset will report `webcam` missing rather than skip it
			 * silently.
			 */
			webcam: {
				enabled: true,
				layout: "picture-in-picture",
				position: "bottom-right",
				sizePercent: 25,
				shape: "rounded",
				shadow: true,
			},
			captions: false,
		},
		output: TARGET_OUTPUT,
	},

	/**
	 * Trim-only passthrough. Not run by default, but kept because it is the only way to tell
	 * "their encoder is slow" apart from "their effects pipeline is slow", and it costs nothing
	 * to carry.
	 */
	passthrough: {
		id: "passthrough",
		label: "Passthrough (no effects, re-encode only)",
		effects: {
			background: null,
			paddingPercent: 0,
			cornerRadiusPx: 0,
			shadow: { enabled: false, intensity: 0 },
			zooms: [],
			motionBlur: { enabled: false, amount: 0 },
			cursor: { enabled: false },
			webcam: { enabled: false },
			captions: false,
		},
		output: TARGET_OUTPUT,
	},
};

export const DEFAULT_SCENARIO = "full-demo";

export function getScenario(id) {
	const s = SCENARIOS[id];
	if (!s) throw new Error(`Unknown scenario "${id}". Known: ${Object.keys(SCENARIOS).join(", ")}`);
	return s;
}

/**
 * Which scenario features a driver claims to implement. Drivers return this from `prepare()`
 * so the report can mark a run as full-fidelity or reduced.
 */
export const FEATURES = [
	"background",
	"padding",
	"cornerRadius",
	"shadow",
	"zooms",
	"motionBlur",
	"cursor",
	"webcam",
	"targetResolution",
	"targetFps",
];

/** Compare what a scenario asks for against what a driver said it applied. */
export function fidelity(scenario, applied) {
	const wanted = new Set();
	const e = scenario.effects;
	if (e.background) wanted.add("background");
	if (e.paddingPercent > 0) wanted.add("padding");
	if (e.cornerRadiusPx > 0) wanted.add("cornerRadius");
	if (e.shadow?.enabled) wanted.add("shadow");
	if (e.zooms?.length) wanted.add("zooms");
	if (e.motionBlur?.enabled) wanted.add("motionBlur");
	if (e.cursor?.enabled) wanted.add("cursor");
	if (e.webcam?.enabled) wanted.add("webcam");
	wanted.add("targetResolution");
	wanted.add("targetFps");

	const got = new Set(applied ?? []);
	const missing = [...wanted].filter((f) => !got.has(f));
	return {
		wanted: [...wanted],
		applied: [...got],
		missing,
		full: missing.length === 0,
		score: wanted.size === 0 ? 1 : +((wanted.size - missing.length) / wanted.size).toFixed(3),
	};
}
