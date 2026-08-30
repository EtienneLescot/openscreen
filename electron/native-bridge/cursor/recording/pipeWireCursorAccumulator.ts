import type {
	CursorRecordingData,
	CursorRecordingSample,
	NativeCursorAsset,
} from "../../../../src/native/contracts";
import { clamp } from "../../../../src/utils/math";

/**
 * Turns the Linux helper's NDJSON stdout into `CursorRecordingData`.
 *
 * Extracted from `PipeWireCursorRecordingSession` because there are now two
 * callers and only one helper. The cursor-only session spawns the helper for
 * telemetry alone; the native capture session spawns it for video AND telemetry,
 * from the same portal session. Sharing this class is what keeps them from
 * drifting — and, more importantly, is what lets the second one exist at all:
 * `SelectSources` may be called once per portal session, so two processes would
 * mean two pickers, which is exactly the double-prompt this replaces.
 */

export interface PipeWireCursorAssetPayload {
	id: string;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
}

export type PipeWireHelperEvent =
	| { event: "ready"; timestampMs: number; pipewireVersion?: string | null }
	| {
			/** The picker has been answered. Fires before any pixel moves. */
			event: "source-selected";
			timestampMs: number;
			nodeId: number;
			sourceKind?: "monitor" | "window" | "virtual" | null;
			positionX?: number | null;
			positionY?: number | null;
	  }
	| {
			event: "stream-started";
			timestampMs: number;
			nodeId: number;
			width: number;
			height: number;
			/** What the compositor actually handed over. Absent on backends that
			 *  omit it — treat that as unknown, never as a screen. */
			sourceKind?: "monitor" | "window" | "virtual" | null;
	  }
	| {
			event: "cursor-sample";
			timestampMs: number;
			x: number;
			y: number;
			width: number;
			height: number;
			visible: boolean;
			assetId?: string;
			asset?: PipeWireCursorAssetPayload;
			/** `"click"` on the sample coinciding with a left-button press the
			 *  helper read from evdev; absent on a plain move (see the helper's
			 *  input.rs). The helper never emits the `"move"` default — that word
			 *  is filled in below so it lives in exactly one place. */
			interactionType?: "move" | "click";
	  }
	| {
			event: "audio-source";
			role: string;
			requested?: string | null;
			/** The PipeWire node the stream was linked to. `null` means the session
			 *  default was used, which is often NOT the device the user picked. */
			node?: string | null;
	  }
	| { event: "encoder-selection"; video: string; rejected?: string[] }
	| {
			event: "capture-started";
			timestampMs: number;
			path: string;
			width: number;
			height: number;
			fps: number;
	  }
	| {
			event: "capture-stopped";
			timestampMs: number;
			path: string;
			durationMs: number;
			frames: number;
			dropped: number;
			convertMs?: number;
			uploadMs?: number;
			encodeMs?: number;
	  }
	| { event: "warning"; code: string; message: string }
	| { event: "error"; code: string; message: string }
	| { event: "debug"; code: string; [key: string]: unknown };

/** Splits a stdout stream into whole NDJSON lines across chunk boundaries. */
export class NdjsonLineReader {
	private buffer = "";

	push(chunk: string, onLine: (line: string) => void) {
		this.buffer += chunk;
		const lines = this.buffer.split(/\r?\n/);
		// The last element is whatever came after the final newline — a partial
		// line, or "" when the chunk ended cleanly. Either way it is not ready.
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed) {
				onLine(trimmed);
			}
		}
	}

	reset() {
		this.buffer = "";
	}
}

export class PipeWireCursorAccumulator {
	private samples: CursorRecordingSample[] = [];
	private assets = new Map<string, NativeCursorAsset>();
	private startTimeMs = 0;

	constructor(private readonly maxSamples: number) {}

	reset(startTimeMs: number) {
		this.samples = [];
		this.assets.clear();
		this.startTimeMs = startTimeMs;
	}

	/**
	 * Re-bases every sample already collected onto a new time origin.
	 *
	 * Needed because the helper's cursor stream starts before its video does: the
	 * portal picker, the format negotiation and the encoder open all happen first,
	 * and only then does `capture-started` fire. Samples taken in between belong
	 * to the recording's negative time, so the origin moves to the video's and
	 * anything now before zero is dropped rather than clamped — a clamped sample
	 * would pin the pointer to wherever it happened to be during the picker.
	 */
	rebase(startTimeMs: number) {
		const shiftMs = startTimeMs - this.startTimeMs;
		this.startTimeMs = startTimeMs;
		if (shiftMs === 0) {
			return;
		}
		this.samples = this.samples
			.map((sample) => ({ ...sample, timeMs: sample.timeMs - shiftMs }))
			.filter((sample) => sample.timeMs >= 0);
	}

	addSample(payload: Extract<PipeWireHelperEvent, { event: "cursor-sample" }>) {
		this.rememberAsset(payload.asset);

		// Normalised against the stream's own dimensions, which the helper repeats
		// on every sample. Electron's display bounds are deliberately NOT used:
		// they are in DIPs, whereas the portal reports stream pixels, and the
		// portal's source is whatever the user picked in its own dialog, which
		// need not be the display the app thinks it is recording.
		const width = Math.max(1, payload.width);
		const height = Math.max(1, payload.height);

		this.samples.push({
			// Clamped, matching the behaviour this was extracted from: a sample
			// stamped a few milliseconds before the recording's own start is a
			// clock artefact, not a sample from before the recording.
			timeMs: Math.max(0, payload.timestampMs - this.startTimeMs),
			cx: clamp(payload.x / width, 0, 1),
			cy: clamp(payload.y / height, 0, 1),
			visible: payload.visible,
			// The portal never reports a button; the helper tags a sample "click"
			// only when it read a left-button press from evdev (needs the user in
			// the `input` group). Everything else — the common case — is a move.
			interactionType: payload.interactionType ?? "move",
			...(payload.assetId ? { assetId: payload.assetId } : {}),
		});

		if (this.samples.length > this.maxSamples) {
			this.samples.shift();
		}
	}

	private rememberAsset(asset: PipeWireCursorAssetPayload | undefined) {
		if (!asset?.id || this.assets.has(asset.id)) {
			return;
		}

		this.assets.set(asset.id, {
			id: asset.id,
			platform: "linux",
			imageDataUrl: asset.imageDataUrl,
			width: asset.width,
			height: asset.height,
			hotspotX: asset.hotspotX,
			hotspotY: asset.hotspotY,
			// The portal reports cursor bitmaps in stream pixels, the same space
			// the positions are in, so no extra scaling applies.
			scaleFactor: 1,
		});
	}

	/** Drops samples taken before zero, which `rebase` can produce. */
	get sampleCount() {
		return this.samples.length;
	}

	toRecordingData(): CursorRecordingData {
		return {
			version: 2,
			provider: this.assets.size > 0 ? "native" : "none",
			samples: this.samples,
			assets: [...this.assets.values()],
		};
	}
}
