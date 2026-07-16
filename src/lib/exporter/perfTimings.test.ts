import { describe, expect, it } from "vitest";
import { StageTimings } from "./perfTimings";

function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		tick: (ms: number) => {
			t += ms;
		},
	};
}

describe("StageTimings — record + snapshot", () => {
	it("accumulates totals, counts, averages, and shares", () => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		timings.record("decode", 10);
		timings.record("render", 30);
		timings.record("decode", 20);

		const snapshot = timings.snapshot();
		expect(snapshot.totalMs).toBe(60);
		expect(snapshot.stages.decode.totalMs).toBe(30);
		expect(snapshot.stages.decode.count).toBe(2);
		expect(snapshot.stages.decode.avgMs).toBe(15);
		expect(snapshot.stages.decode.pct).toBe(50);
		expect(snapshot.stages.render.totalMs).toBe(30);
		expect(snapshot.stages.render.count).toBe(1);
		expect(snapshot.stages.render.avgMs).toBe(30);
		expect(snapshot.stages.render.pct).toBe(50);
		expect(Object.values(snapshot.stages).reduce((sum, stat) => sum + stat.pct, 0)).toBeCloseTo(
			100,
		);
	});

	it("preserves first-seen order in snapshots and summaries", () => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		timings.record("render", 2);
		timings.record("decode-wait", 1);
		timings.record("render", 3);
		timings.record("encode-wait", 4);

		expect(Object.keys(timings.snapshot().stages)).toEqual([
			"render",
			"decode-wait",
			"encode-wait",
		]);

		const rows = timings
			.formatSummary()
			.split("\n")
			.filter(
				(line) =>
					line.startsWith("render") ||
					line.startsWith("decode-wait") ||
					line.startsWith("encode-wait"),
			);
		expect(rows.map((row) => row.trimStart().split(/\s+/)[0])).toEqual([
			"render",
			"decode-wait",
			"encode-wait",
		]);
	});
});

describe("StageTimings — injected-clock helpers", () => {
	it("records a start/stop duration once", () => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		const stop = timings.start("x");
		clock.tick(10);
		stop();
		stop();

		expect(timings.snapshot().stages.x).toEqual({ totalMs: 10, count: 1, avgMs: 10, pct: 100 });
	});

	it("times a synchronous function and returns its result", () => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		const result = timings.time("x", () => {
			clock.tick(12);
			return 42;
		});

		expect(result).toBe(42);
		expect(timings.snapshot().stages.x.totalMs).toBe(12);
	});

	it("times an async function and returns its resolved value", async () => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		const result = await timings.timeAsync("x", async () => {
			clock.tick(18);
			return "done";
		});

		expect(result).toBe("done");
		expect(timings.snapshot().stages.x).toEqual({ totalMs: 18, count: 1, avgMs: 18, pct: 100 });
	});

	it("records async elapsed time when the function rejects and re-throws", async () => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		const error = new Error("failed");

		await expect(
			timings.timeAsync("reject", async () => {
				clock.tick(7);
				throw error;
			}),
		).rejects.toBe(error);

		expect(timings.snapshot().stages.reject).toEqual({ totalMs: 7, count: 1, avgMs: 7, pct: 100 });
	});
});

describe("StageTimings — invalid and empty samples", () => {
	it.each([
		["negative", -1],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
	])("ignores a %s duration without creating a sample", (_name, duration) => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		timings.record("bad", duration);

		expect(timings.snapshot()).toEqual({ stages: {}, totalMs: 0 });
	});

	it("reports zero averages and shares for empty timings and a zero-duration sample", () => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		expect(timings.snapshot()).toEqual({ stages: {}, totalMs: 0 });

		timings.record("zero", 0);
		expect(timings.snapshot().stages.zero).toEqual({ totalMs: 0, count: 1, avgMs: 0, pct: 0 });
	});
});

describe("StageTimings — formatSummary and reset", () => {
	it("formats stage rows, a total, effective fps, and hardware acceleration", () => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		timings.record("decode-wait", 10);
		timings.record("render", 10);

		const summary = timings.formatSummary({ frames: 10, hardwareAcceleration: "prefer-hardware" });
		expect(summary).toContain("decode-wait");
		expect(summary).toContain("render");
		expect(summary).toContain("TOTAL");
		expect(summary).toContain("fps: 500.0");
		expect(summary).toContain("hwAccel: prefer-hardware");
	});

	it("uses n/a for fps when total time is zero", () => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		timings.record("zero", 0);

		expect(timings.formatSummary({ frames: 10 })).toContain("fps: n/a");
	});

	it("clears all accumulated timing data", () => {
		const clock = fakeClock();
		const timings = new StageTimings(clock.now);
		timings.record("x", 25);
		timings.reset();

		expect(timings.snapshot()).toEqual({ stages: {}, totalMs: 0 });
	});
});
