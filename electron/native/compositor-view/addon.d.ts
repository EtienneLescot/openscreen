/**
 * Type declarations for the Rust napi-rs native compositor addon
 * (`compositor_view.node`). Built separately and loaded by
 * `electron/native-bridge/services/compositorViewService.ts`. Until the
 * prebuilt `.node` binary is present the service logs once and falls back to
 * safe no-ops — the type contract here is the only contract renderer code
 * relies on.
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
	/** Optional screen/webcam/cursor paths (F3 — the app's real recording, two separate H264
	 *  files); omitted → the POC fixture. */
	createView(
		parentHandle: Buffer,
		rect: CompositorViewRect,
		screenPath?: string,
		webcamPath?: string,
		cursorPath?: string,
	): number;
	setRect(id: number, rect: CompositorViewRect): void;
	/** Shows/hides the overlay. It's a top-level window outside the Chromium surface, so CSS
	 *  z-index can't put a web modal in front of it — the app must hide it explicitly. */
	setViewVisible(id: number, visible: boolean): void;
	setParam(id: number, key: string, value: CompositorParamValue): void;
	setPlaying(id: number, playing: boolean): void;
	/** Seeks the view to `seconds` (app playhead-driven). */
	presentTime(id: number, seconds: number): void;
	/** Installs the app scene (JSON `SceneDescription`) — layout preset etc. drive the render
	 *  instead of the fixture. Invalid JSON is ignored native-side. */
	setScene(id: number, sceneJson: string): void;
	destroyView(id: number): void;
	/** Renders the fixture to `outPath` (C8), auto-pausing live previews. */
	export(outPath: string): Promise<ExportStats>;
	/** Renders the real timeline (ordered clips + trims) to `outPath`, auto-pausing previews.
	 *  `sceneJson` — same `SceneDescription` as the live preview (background/layout/webcam/cursor/
	 *  effects); omitted or invalid → nothing configured is applied (not a masking fallback).
	 *  `params` — output size/fps/codec; omitted → 1920x1080/first clip's fps/h264. */
	exportMulti(
		clips: ClipInput[],
		outPath: string,
		sceneJson?: string,
		params?: ExportParamsInput,
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
