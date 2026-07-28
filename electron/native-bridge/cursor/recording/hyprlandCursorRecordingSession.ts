import { type Rectangle, screen } from "electron";
import type { CursorRecordingData, CursorRecordingSample } from "../../../../src/native/contracts";
import { queryHyprlandCursorPos, resolveHyprlandSocketPath } from "./hyprlandCursorIpc";
import type { CursorRecordingSession } from "./session";

interface HyprlandCursorRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
	startTimeMs?: number;
	/** Overrides the resolved Hyprland socket path. Test-only. */
	socketPath?: string;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export class HyprlandCursorRecordingSession implements CursorRecordingSession {
	private samples: CursorRecordingSample[] = [];
	private interval: NodeJS.Timeout | null = null;
	private startTimeMs = 0;
	private isSampling = false;
	private lastPosition: { x: number; y: number } | null = null;
	private readonly socketPath: string | null;
	private captureInFlight: Promise<void> | null = null;

	constructor(private readonly options: HyprlandCursorRecordingSessionOptions) {
		this.socketPath = options.socketPath ?? resolveHyprlandSocketPath();
		if (!this.socketPath) {
			console.warn(
				"HyprlandCursorRecordingSession: could not resolve the Hyprland IPC socket path (HYPRLAND_INSTANCE_SIGNATURE/XDG_RUNTIME_DIR unset); cursor telemetry will be empty.",
			);
		}
	}

	async start(): Promise<void> {
		this.samples = [];
		this.lastPosition = null;
		this.startTimeMs = this.options.startTimeMs ?? Date.now();
		this.captureInFlight = this.captureSample();
		await this.captureInFlight;
		this.interval = setInterval(() => {
			if (this.isSampling) {
				// The previous capture (and captureInFlight) is still mid IPC-round-trip;
				// reassigning here would drop stop()'s only reference to it, so a skipped
				// tick would let stop() return before that capture -- and its sample --
				// actually lands.
				return;
			}
			this.captureInFlight = this.captureSample();
		}, this.options.sampleIntervalMs);
	}

	async stop(): Promise<CursorRecordingData> {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		// Wait out any capture that was already mid IPC-round-trip when stop() was
		// called, so its sample (if any) lands before we snapshot -- otherwise it'd
		// land after the caller already has (and may have serialized) the result.
		await this.captureInFlight;

		return {
			version: 2,
			provider: "none",
			samples: [...this.samples],
			assets: [],
		};
	}

	private async captureSample(): Promise<void> {
		if (this.isSampling || !this.socketPath) {
			return;
		}
		this.isSampling = true;
		// Stamp the sample with the time the query was *sent*, not when the response
		// came back. Stamping after the await biases every sample's timeMs later than
		// when the cursor was actually there by one IPC round-trip, which reads as a
		// constant lag between the cursor overlay and the recording during playback.
		const requestedAtMs = Date.now();
		try {
			const position = (await queryHyprlandCursorPos(this.socketPath)) ?? this.lastPosition;
			if (!position) {
				return;
			}
			this.lastPosition = position;

			const display =
				this.options.getDisplayBounds() ?? screen.getDisplayNearestPoint(position).bounds;
			const width = Math.max(1, display.width);
			const height = Math.max(1, display.height);

			this.samples.push({
				timeMs: Math.max(0, requestedAtMs - this.startTimeMs),
				cx: clamp((position.x - display.x) / width, 0, 1),
				cy: clamp((position.y - display.y) / height, 0, 1),
				visible: true,
			});

			if (this.samples.length > this.options.maxSamples) {
				this.samples.shift();
			}
		} finally {
			this.isSampling = false;
		}
	}
}
