import { describe, expect, it } from "vitest";
import { NdjsonLineReader, PipeWireCursorAccumulator } from "./pipeWireCursorAccumulator";

function sample(timestampMs: number, x: number, y: number, extra: Record<string, unknown> = {}) {
	return {
		event: "cursor-sample" as const,
		timestampMs,
		x,
		y,
		width: 1920,
		height: 1080,
		visible: true,
		...extra,
	};
}

describe("NdjsonLineReader", () => {
	it("reassembles a line split across chunks", () => {
		// The helper writes one JSON object per line and flushes per line, but a
		// pipe read can still land mid-line. Splitting on newline per chunk and
		// discarding the remainder would drop a sample every time that happened.
		const reader = new NdjsonLineReader();
		const lines: string[] = [];
		reader.push('{"event":"a"}\n{"ev', (line) => lines.push(line));
		expect(lines).toEqual(['{"event":"a"}']);
		reader.push('ent":"b"}\n', (line) => lines.push(line));
		expect(lines).toEqual(['{"event":"a"}', '{"event":"b"}']);
	});

	it("emits nothing for a chunk with no newline", () => {
		const reader = new NdjsonLineReader();
		const lines: string[] = [];
		reader.push('{"partial"', (line) => lines.push(line));
		expect(lines).toEqual([]);
	});

	it("drops a half-line on reset so a new recording cannot inherit it", () => {
		const reader = new NdjsonLineReader();
		const lines: string[] = [];
		reader.push('{"stale', (line) => lines.push(line));
		reader.reset();
		reader.push('{"event":"fresh"}\n', (line) => lines.push(line));
		expect(lines).toEqual(['{"event":"fresh"}']);
	});
});

describe("PipeWireCursorAccumulator", () => {
	it("normalises positions against the stream size the helper reports", () => {
		const accumulator = new PipeWireCursorAccumulator(100);
		accumulator.reset(1_000);
		accumulator.addSample(sample(1_500, 960, 540));

		const [point] = accumulator.toRecordingData().samples;
		expect(point.cx).toBeCloseTo(0.5, 5);
		expect(point.cy).toBeCloseTo(0.5, 5);
		expect(point.timeMs).toBe(500);
	});

	it("defaults a sample with no interaction to a move", () => {
		// The helper omits interactionType on the common case, so the accumulator
		// owns the "move" fallback. This is what the user not being in the `input`
		// group looks like: every sample arrives bare.
		const accumulator = new PipeWireCursorAccumulator(100);
		accumulator.reset(0);
		accumulator.addSample(sample(10, 5, 5));
		expect(accumulator.toRecordingData().samples[0].interactionType).toBe("move");
	});

	it("preserves a click the helper read from evdev", () => {
		const accumulator = new PipeWireCursorAccumulator(100);
		accumulator.reset(0);
		accumulator.addSample(sample(10, 5, 5, { interactionType: "click" }));
		accumulator.addSample(sample(20, 6, 6));
		const { samples } = accumulator.toRecordingData();
		expect(samples.map((s) => s.interactionType)).toEqual(["click", "move"]);
	});

	it("re-bases onto the video's start and drops what came before it", () => {
		// This is the single-session case. Cursor samples start flowing as soon
		// as the helper does, but the video's frame 0 is only stamped once the
		// user has answered the portal picker — an unbounded wait. Samples taken
		// during it belong to no part of the recording.
		const accumulator = new PipeWireCursorAccumulator(100);
		accumulator.reset(1_000);
		accumulator.addSample(sample(1_200, 100, 100)); // during the picker
		accumulator.addSample(sample(2_000, 200, 200)); // exactly at capture start
		accumulator.addSample(sample(2_500, 300, 300)); // after

		accumulator.rebase(2_000);

		const { samples } = accumulator.toRecordingData();
		expect(samples).toHaveLength(2);
		expect(samples[0].timeMs).toBe(0);
		expect(samples[1].timeMs).toBe(500);
	});

	it("leaves samples alone when the origin has not moved", () => {
		const accumulator = new PipeWireCursorAccumulator(100);
		accumulator.reset(1_000);
		accumulator.addSample(sample(1_400, 10, 10));
		accumulator.rebase(1_000);
		expect(accumulator.toRecordingData().samples[0].timeMs).toBe(400);
	});

	it("reports provider 'none' until a sprite arrives", () => {
		// The editor uses this to decide whether it has real cursor art to draw
		// or must fall back. A recording with positions but no bitmap is the
		// normal state for the first few frames.
		const accumulator = new PipeWireCursorAccumulator(100);
		accumulator.reset(0);
		accumulator.addSample(sample(10, 5, 5));
		expect(accumulator.toRecordingData().provider).toBe("none");

		accumulator.addSample(
			sample(20, 6, 6, {
				assetId: "abc",
				asset: {
					id: "abc",
					imageDataUrl: "data:image/png;base64,AAAA",
					width: 24,
					height: 24,
					hotspotX: 4,
					hotspotY: 2,
				},
			}),
		);
		const data = accumulator.toRecordingData();
		expect(data.provider).toBe("native");
		expect(data.assets).toHaveLength(1);
		expect(data.assets[0]).toMatchObject({ platform: "linux", hotspotX: 4, scaleFactor: 1 });
	});

	it("keeps the first sprite when the same id is sent again", () => {
		const accumulator = new PipeWireCursorAccumulator(100);
		accumulator.reset(0);
		const asset = {
			id: "same",
			imageDataUrl: "data:image/png;base64,FIRST",
			width: 24,
			height: 24,
			hotspotX: 1,
			hotspotY: 1,
		};
		accumulator.addSample(sample(10, 1, 1, { assetId: "same", asset }));
		accumulator.addSample(
			sample(20, 2, 2, {
				assetId: "same",
				asset: { ...asset, imageDataUrl: "data:image/png;base64,SECOND" },
			}),
		);
		const { assets } = accumulator.toRecordingData();
		expect(assets).toHaveLength(1);
		expect(assets[0].imageDataUrl).toBe("data:image/png;base64,FIRST");
	});

	it("caps the sample list by dropping the oldest", () => {
		const accumulator = new PipeWireCursorAccumulator(3);
		accumulator.reset(0);
		for (let index = 0; index < 5; index++) {
			accumulator.addSample(sample(index * 10, index, index));
		}
		const { samples } = accumulator.toRecordingData();
		expect(samples).toHaveLength(3);
		expect(samples[0].timeMs).toBe(20);
	});

	it("clamps positions outside the stream instead of emitting them", () => {
		// A cursor can legitimately be reported outside a window capture's
		// bounds. Un-clamped, cx/cy leave 0..1 and the editor draws the overlay
		// off-canvas rather than at the edge.
		const accumulator = new PipeWireCursorAccumulator(10);
		accumulator.reset(0);
		accumulator.addSample(sample(10, -50, 5000));
		const [point] = accumulator.toRecordingData().samples;
		expect(point.cx).toBe(0);
		expect(point.cy).toBe(1);
	});
});
