import { describe, expect, it } from "vitest";
import { type CursorTelemetryPoint, createCursorTelemetryBuffer } from "./cursorTelemetryBuffer";

function sample(tag: number): CursorTelemetryPoint {
	return { timeMs: tag, cx: tag / 10, cy: tag / 10 };
}

describe("createCursorTelemetryBuffer", () => {
	it("stores samples captured during an active session", () => {
		const buf = createCursorTelemetryBuffer({ maxActiveSamples: 10 });
		buf.startSession();
		for (let i = 0; i < 3; i++) buf.push(sample(i));
		buf.endSession();

		const batch = buf.takeNextBatch();
		expect(batch).toHaveLength(3);
		expect(batch[0]?.timeMs).toBe(0);
	});

	it("trims active samples past maxActiveSamples (ring behaviour)", () => {
		const buf = createCursorTelemetryBuffer({ maxActiveSamples: 2 });
		buf.startSession();
		buf.push(sample(1));
		buf.push(sample(2));
		buf.push(sample(3));
		buf.endSession();

		const batch = buf.takeNextBatch();
		expect(batch).toEqual([sample(2), sample(3)]);
	});

	it("preserves earlier pending batches when a new session starts before store", () => {
		const buf = createCursorTelemetryBuffer({ maxActiveSamples: 10 });

		// Recording 1
		buf.startSession();
		buf.push(sample(101));
		buf.push(sample(102));
		buf.endSession();

		// Recording 2 starts before recording 1's batch has been consumed
		buf.startSession();
		buf.push(sample(201));
		buf.endSession();

		const batch1 = buf.takeNextBatch();
		const batch2 = buf.takeNextBatch();
		expect(batch1.map((s) => s.timeMs)).toEqual([101, 102]);
		expect(batch2.map((s) => s.timeMs)).toEqual([201]);
	});

	it("returns an empty batch when nothing is pending", () => {
		const buf = createCursorTelemetryBuffer({ maxActiveSamples: 10 });
		expect(buf.takeNextBatch()).toEqual([]);
	});

	it("drops empty sessions instead of queuing empty batches", () => {
		const buf = createCursorTelemetryBuffer({ maxActiveSamples: 10 });
		buf.startSession();
		buf.endSession();
		expect(buf.pendingCount).toBe(0);
		expect(buf.takeNextBatch()).toEqual([]);
	});

	it("caps the pending queue at maxPendingBatches to bound memory", () => {
		const buf = createCursorTelemetryBuffer({ maxActiveSamples: 10, maxPendingBatches: 3 });

		for (let round = 1; round <= 5; round++) {
			buf.startSession();
			buf.push(sample(round));
			buf.endSession();
		}

		expect(buf.pendingCount).toBe(3);
		// Oldest two batches (rounds 1 and 2) should have been dropped
		expect(buf.takeNextBatch().map((s) => s.timeMs)).toEqual([3]);
		expect(buf.takeNextBatch().map((s) => s.timeMs)).toEqual([4]);
		expect(buf.takeNextBatch().map((s) => s.timeMs)).toEqual([5]);
	});

	it("starting a new session clears in-progress samples but keeps pending batches", () => {
		const buf = createCursorTelemetryBuffer({ maxActiveSamples: 10 });

		buf.startSession();
		buf.push(sample(1));
		buf.endSession();

		buf.startSession();
		buf.push(sample(99));
		// Simulate another startSession before endSession (e.g. rapid restart)
		buf.startSession();
		expect(buf.activeCount).toBe(0);
		expect(buf.pendingCount).toBe(1);

		const batch = buf.takeNextBatch();
		expect(batch.map((s) => s.timeMs)).toEqual([1]);
	});

	it("reset() clears both active and pending state", () => {
		const buf = createCursorTelemetryBuffer({ maxActiveSamples: 10 });
		buf.startSession();
		buf.push(sample(1));
		buf.endSession();
		buf.startSession();
		buf.push(sample(2));

		buf.reset();

		expect(buf.activeCount).toBe(0);
		expect(buf.pendingCount).toBe(0);
		expect(buf.takeNextBatch()).toEqual([]);
	});
});
