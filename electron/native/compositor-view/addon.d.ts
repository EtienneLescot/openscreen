/**
 * Type declarations for the Rust napi-rs native compositor addon
 * (`compositor_view.node`). Built separately and loaded by
 * `electron/native-bridge/services/compositorViewService.ts`. Until the
 * prebuilt `.node` binary is present the service logs once and falls back to
 * safe no-ops — the type contract here is the only contract renderer code
 * relies on.
 *
 * The compositor renders OFFSCREEN at the resolution given by `createView`'s
 * `rect.width` / `rect.height`; the renderer polls `readFrame` on a timer and
 * paints the result into an HTML `<canvas>`. There is no OS window — the rect
 * is purely a target preview resolution, and the `x` / `y` fields are
 * vestigial (ignored native-side; the TS side keeps them on the wire so the
 * `CompositorViewRect` shape is unchanged and existing callers don't need a
 * refactor for fields they never used).
 */

export interface CompositorViewRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type CompositorParamValue = boolean | number | string;

export interface ExportStats {
	frames: number;
	wallS: number;
	fps: number;
	/** Duration of the exported video (seconds) — distinct from `wallS` (real render time). */
	videoDurationS: number;
}

/** Output size/framerate/codec the app wants. All optional — omitted → 1920x1080 / first
 *  clip's fps / h264. `width`/`height` are rounded to the nearest even number (NV12 4:2:0). */
export interface ExportParamsInput {
	width?: number;
	height?: number;
	fps?: number;
	/** "h264" | "h265". Anything else (e.g. "vp9", no AMF hardware equivalent) fails the export
	 *  with a clear error instead of silently falling back to h264. */
	codec?: string;
}

/** One timeline clip for the native multiclip export (screen + webcam files + source trim). */
export interface ClipInput {
	screenPath: string;
	webcamPath: string;
	sourceStartSec: number;
	sourceEndSec: number;
	/** webcam source time = screen source time − this. */
	webcamOffsetSec: number;
}

export interface CompositorViewAddon {
	/** Allocates an offscreen compositor view sized to `rect.width`x`rect.height` (the
	 *  target preview resolution; `rect.x` / `rect.y` are vestigial and ignored native-side).
	 *  No HWND/native-window-handle is passed: there's no OS window to parent to. The
	 *  renderer reads frames back via `readFrame` and paints them into a canvas.
	 *
	 *  Optional screen/webcam/cursor paths (F3 — the app's real recording, two separate H264
	 *  files); omitted → the POC fixture. */
	createView(
		rect: CompositorViewRect,
		screenPath?: string,
		webcamPath?: string,
		cursorPath?: string,
	): number;
	setRect(id: number, rect: CompositorViewRect): void;
	/** Returns the most recently rendered frame as a raw pixel buffer (length =
	 *  `width * height * 4`). Byte order is RGBA per the new contract; if the
	 *  picture comes back with red/blue swapped once the real addon is
	 *  buildable, swap to `new ImageData(new Uint8ClampedArray(buffer), w, h)`
	 *  where the bytes are interpreted as BGRA, or ask the Rust side to match
	 *  RGBA on the wire. Returns `null` if no frame is ready yet.
	 *
	 *  TODO: confirm RGBA vs BGRA byte order against the real addon once it's
	 *  buildable. */
	readFrame(id: number): Buffer | null;
	setParam(id: number, key: string, value: CompositorParamValue): void;
	setPlaying(id: number, playing: boolean): void;
	/** Seeks the view to source-media `seconds` for the active clip. */
	presentTime(id: number, seconds: number): void;
	/** Installs the app scene (JSON `SceneDescription`) — layout preset etc. drive the render
	 *  instead of the fixture. Invalid JSON is ignored native-side. */
	setScene(id: number, sceneJson: string): void;
	setActiveClip(
		id: number,
		screenPath: string,
		webcamPath: string,
		webcamOffsetSec: number,
		clipIndex: number,
		sourceTimeSec: number,
	): void;
	destroyView(id: number): void;
	/** Renders the fixture to `outPath` (C8), auto-pausing live previews. `onProgress`
	 *  (frames encoded so far) is optional and called at most ~10/s from the render
	 *  thread — cheap: the encode loop already ticks a progress hook every frame, this
	 *  just forwards it (throttled) instead of the previous no-op. */
	export(outPath: string, onProgress?: (frames: number) => void): Promise<ExportStats>;
	/** Renders the real timeline (ordered clips + trims) to `outPath`, auto-pausing previews.
	 *  `sceneJson` — same `SceneDescription` as the live preview (background/layout/webcam/cursor/
	 *  effects); omitted or invalid → nothing configured is applied (not a masking fallback).
	 *  `params` — output size/fps/codec; omitted → 1920x1080/first clip's fps/h264.
	 *  `onProgress` (frames encoded so far) is optional, throttled to ~10/s. */
	exportMulti(
		clips: ClipInput[],
		outPath: string,
		sceneJson?: string,
		params?: ExportParamsInput,
		onProgress?: (frames: number) => void,
	): Promise<ExportStats>;
}

/**
 * The napi-rs addon is `require()`d from an absolute path resolved at runtime
 * (see `compositorViewService`). Declare the module shape here so the
 * `require()` return type can be constrained to `CompositorViewAddon` without
 * `any`. The wildcard pattern lets us match both the packaged
 * `electron/native/bin/<arch>/compositor_view.node` and the locally built
 * `electron/native/compositor-view/build/compositor_view.node` paths.
 */
declare module "*compositor_view.node" {
	const addon: CompositorViewAddon;
	export = addon;
}
