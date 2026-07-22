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

	constructor(private readonly options: HyprlandCursorRecordingSessionOptions) {
		this.socketPath = options.socketPath ?? resolveHyprlandSocketPath();
	}

	async start(): Promise<void> {
		this.samples = [];
		this.lastPosition = null;
		this.startTimeMs = this.options.startTimeMs ?? Date.now();
		await this.captureSample();
		this.interval = setInterval(() => {
			void this.captureSample();
		}, this.options.sampleIntervalMs);
	}

	async stop(): Promise<CursorRecordingData> {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}

		return {
			version: 2,
			provider: "none",
			samples: this.samples,
			assets: [],
		};
	}

	private async captureSample() {
		if (this.isSampling || !this.socketPath) {
			return;
		}
		this.isSampling = true;
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
				timeMs: Math.max(0, Date.now() - this.startTimeMs),
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
