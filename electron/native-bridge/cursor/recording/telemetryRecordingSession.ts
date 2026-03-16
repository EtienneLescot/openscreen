import { type Rectangle, screen } from "electron";
import type { CursorRecordingData, CursorRecordingSample } from "../../../../src/native/contracts";
import type { CursorRecordingSession } from "./session";

interface TelemetryRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export class TelemetryRecordingSession implements CursorRecordingSession {
	private samples: CursorRecordingSample[] = [];
	private interval: NodeJS.Timeout | null = null;
	private startTimeMs = 0;

	constructor(private readonly options: TelemetryRecordingSessionOptions) {}

	async start(): Promise<void> {
		this.samples = [];
		this.startTimeMs = Date.now();
		this.captureSample();
		this.interval = setInterval(() => {
			this.captureSample();
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

	private captureSample() {
		const cursor = screen.getCursorScreenPoint();
		const display = this.options.getDisplayBounds() ?? screen.getDisplayNearestPoint(cursor).bounds;
		const width = Math.max(1, display.width);
		const height = Math.max(1, display.height);

		this.samples.push({
			timeMs: Math.max(0, Date.now() - this.startTimeMs),
			cx: clamp((cursor.x - display.x) / width, 0, 1),
			cy: clamp((cursor.y - display.y) / height, 0, 1),
			visible: true,
		});

		if (this.samples.length > this.options.maxSamples) {
			this.samples.shift();
		}
	}
}
