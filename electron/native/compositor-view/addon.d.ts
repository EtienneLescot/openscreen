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
	setParam(id: number, key: string, value: CompositorParamValue): void;
	setPlaying(id: number, playing: boolean): void;
	/** Seeks the view to `seconds` (app playhead-driven). */
	presentTime(id: number, seconds: number): void;
	destroyView(id: number): void;
	/** Renders the fixture to `outPath` (C8), auto-pausing live previews. */
	export(outPath: string): Promise<ExportStats>;
	/** Renders the real timeline (ordered clips + trims) to `outPath`, auto-pausing previews. */
	exportMulti(clips: ClipInput[], outPath: string): Promise<ExportStats>;
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
