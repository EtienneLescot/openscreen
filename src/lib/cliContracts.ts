// Shared request/response contracts between the CLI entry in the Electron main
// process (electron/cli/) and the hidden renderer runners (src/cli/). Keep this
// file dependency-free so both build targets can import it.

import type { ExportQuality, GifFrameRate, GifSizePreset } from "./exporter/types";

export type CliCursorCaptureMode = "editable-overlay" | "system";

export interface CliExportRequest {
	kind: "export";
	/** Absolute path to the .openscreen project file. */
	projectPath: string;
	/** Absolute output path; null = derive from projectPath + format. */
	outPath: string | null;
	/** null = use the format stored in the project. */
	format: "mp4" | "gif" | null;
	/** null = use the quality stored in the project. */
	quality: ExportQuality | null;
	gifFrameRate: GifFrameRate | null;
	gifSizePreset: GifSizePreset | null;
	/**
	 * Reference preview box used to scale annotation text and border radii the
	 * same way the editor's on-screen preview does. The composition is fitted
	 * into this box, mirroring the editor layout. Defaults to 1280x720.
	 */
	/**
	 * Add automatic zoom regions derived from cursor-dwell telemetry (same
	 * suggestion engine as the editor's magic wand) before rendering. Existing
	 * zoom regions are preserved; suggestions never overlap them.
	 */
	autoZoom: boolean;
	/** Absolute path to a voiceover audio file to mix into the export (MP4 only). */
	audioPath: string | null;
	/** "mix" layers the voiceover over the recording's audio; "replace" drops the original. */
	audioMode: "mix" | "replace";
	/** Delay before the voiceover starts, in seconds. */
	audioOffsetSec: number;
}

export interface CliRecordRequest {
	kind: "record";
	/** Index into the available screen sources (0 = primary display). */
	displayIndex: number;
	/** Case-insensitive substring match against window titles; overrides displayIndex. */
	windowTitle: string | null;
	mic: boolean;
	/** Microphone device label substring; null = system default. */
	micDevice: string | null;
	systemAudio: boolean;
	cursorMode: CliCursorCaptureMode;
	/** Auto-stop after this many milliseconds; null = stop via signal/stdin. */
	durationMs: number | null;
	/** When set, write a ready-to-export .openscreen project here after recording. */
	projectOut: string | null;
}

export interface CliSourcesRequest {
	kind: "sources";
}

export interface CliCaptionsRequest {
	kind: "captions";
	/** Absolute path to the .openscreen project file (updated in place). */
	projectPath: string;
	minWordsPerCaption: number;
	maxWordsPerCaption: number;
}

export type CliRequest =
	| CliExportRequest
	| CliRecordRequest
	| CliSourcesRequest
	| CliCaptionsRequest;

export interface CliSourcesResult {
	displays: { index: number; id: string; name: string }[];
	windows: { id: string; name: string }[];
	microphones: { label: string }[];
	/** True when microphone labels required a permission the user hasn't granted. */
	microphoneLabelsUnavailable: boolean;
}

export interface CliProgressEvent {
	percentage: number;
	currentFrame?: number;
	totalFrames?: number;
	estimatedTimeRemaining?: number;
	phase?: string;
}

export interface CliDoneResult {
	success: boolean;
	error?: string;
	warnings?: string[];
	/** Export: the written output file. */
	outputPath?: string;
	format?: string;
	width?: number;
	height?: number;
	/** Record: produced artifacts. */
	screenVideoPath?: string;
	webcamVideoPath?: string;
	cursorDataPath?: string;
	projectPath?: string;
	durationMs?: number;
	/**
	 * Record: a ready-to-save .openscreen project object built by the runner.
	 * The main process writes it to the --project path (renderer has no fs).
	 */
	projectData?: unknown;
	/** Sources: enumeration payload printed by the main process. */
	sources?: CliSourcesResult;
	/** Captions: number of caption annotations generated. */
	captionCount?: number;
}
