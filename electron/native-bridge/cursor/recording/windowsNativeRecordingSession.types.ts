import type { Rectangle } from "electron";
import type { NativeCursorType } from "../../../../src/native/contracts";

export interface WindowsCursorSampleEvent {
	type: "sample";
	timestampMs: number;
	x: number;
	y: number;
	visible: boolean;
	handle: string | null;
	cursorType?: NativeCursorType | null;
	leftButtonDown?: boolean;
	bounds?: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null;
	asset?: WindowsCursorAssetPayload;
}

export interface WindowsCursorReadyEvent {
	type: "ready";
	timestampMs: number;
}

export interface WindowsCursorErrorEvent {
	type: "error";
	timestampMs: number;
	message: string;
}

export interface WindowsCursorAssetPayload {
	id: string;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	cursorType?: NativeCursorType | null;
}

export type WindowsCursorEvent =
	| WindowsCursorSampleEvent
	| WindowsCursorReadyEvent
	| WindowsCursorErrorEvent;

export interface WindowsNativeRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
	sourceId?: string | null;
	startTimeMs?: number;
}
