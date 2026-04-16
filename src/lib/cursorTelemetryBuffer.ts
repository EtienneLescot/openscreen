export interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
}

export interface CursorTelemetryBuffer {
	startSession(): void;
	push(point: CursorTelemetryPoint): void;
	endSession(): void;
	takeNextBatch(): CursorTelemetryPoint[];
	reset(): void;
	readonly activeCount: number;
	readonly pendingCount: number;
}

export interface CursorTelemetryBufferOptions {
	maxActiveSamples: number;
	maxPendingBatches?: number;
}

const DEFAULT_MAX_PENDING_BATCHES = 8;

export function createCursorTelemetryBuffer(
	options: CursorTelemetryBufferOptions,
): CursorTelemetryBuffer {
	const maxActive = options.maxActiveSamples;
	const maxPending = options.maxPendingBatches ?? DEFAULT_MAX_PENDING_BATCHES;

	let active: CursorTelemetryPoint[] = [];
	let pending: CursorTelemetryPoint[][] = [];

	return {
		startSession() {
			active = [];
		},
		push(point) {
			active.push(point);
			if (active.length > maxActive) {
				active.shift();
			}
		},
		endSession() {
			if (active.length > 0) {
				pending.push(active);
				while (pending.length > maxPending) {
					pending.shift();
				}
			}
			active = [];
		},
		takeNextBatch() {
			return pending.shift() ?? [];
		},
		reset() {
			active = [];
			pending = [];
		},
		get activeCount() {
			return active.length;
		},
		get pendingCount() {
			return pending.length;
		},
	};
}
