// L0 — statistics and the report writer, including the secret barrier.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "../lib/env";
import { buildReport, renderMarkdown, writeReportFile } from "../lib/report";
import { minDetectableEffect, newcombeDelta, wilson95 } from "../lib/stats";

describe("wilson95", () => {
	it("stays inside [0,1] at the edges, where Wald does not", () => {
		const none = wilson95(0, 3);
		expect(none.low).toBe(0);
		expect(none.high).toBeGreaterThan(0.5);
		const all = wilson95(3, 3);
		expect(all.high).toBe(1);
		expect(all.low).toBeLessThan(0.5);
	});

	it("narrows as n grows", () => {
		const small = wilson95(5, 10);
		const large = wilson95(50, 100);
		expect(large.high - large.low).toBeLessThan(small.high - small.low);
	});

	it("treats n=0 as total ignorance rather than as a zero rate", () => {
		expect(wilson95(0, 0)).toMatchObject({ low: 0, high: 1 });
	});
});

describe("newcombeDelta", () => {
	it("refuses to call a small n=3 swing a result", () => {
		// 1/3 → 3/3 is the archetype of the conclusion this guard exists to block.
		const delta = newcombeDelta({ k: 1, n: 3 }, { k: 3, n: 3 });
		expect(delta.significant).toBe(false);
		expect(delta.direction).toBe("inconclusive");
	});

	it("does call a large, well-sampled swing a result", () => {
		const delta = newcombeDelta({ k: 5, n: 100 }, { k: 90, n: 100 });
		expect(delta.significant).toBe(true);
		expect(delta.direction).toBe("improved");
		expect(delta.low).toBeGreaterThan(0);
	});

	it("names a regression as such", () => {
		expect(newcombeDelta({ k: 95, n: 100 }, { k: 10, n: 100 }).direction).toBe("regressed");
	});
});

describe("minDetectableEffect", () => {
	it("is about 55 points at the sober default of n=3", () => {
		expect(minDetectableEffect(3)).toBeGreaterThan(0.5);
		expect(minDetectableEffect(3)).toBeLessThan(0.9);
	});

	it("shrinks with n but stays large at n=10", () => {
		expect(minDetectableEffect(10)).toBeLessThan(minDetectableEffect(3));
		expect(minDetectableEffect(10)).toBeGreaterThan(0.3);
	});
});

const FINGERPRINT = {
	systemSha256: "a".repeat(64),
	systemChars: 8742,
	toolsSha256: "b".repeat(64),
	toolNames: ["addZoom", "grep"],
	model: "workbench-scripted",
	gitSha: "deadbee",
	gitDirty: true,
	overlayId: null,
	reps: 3,
};

const SCENARIO_REPORT = {
	scenarioId: "demo",
	title: "Demo",
	tags: ["D1"],
	gate: 0,
	reps: 3,
	behaviour: { ...wilson95(1, 3), rate: 0.33 },
	dsl: { ...wilson95(2, 3), rate: 0.64 },
	gateScoreMean: 0.33,
	passRate: wilson95(3, 3),
	failureClasses: { NONE: 3 },
	checks: [
		{
			id: "beh.synthetique",
			axis: "behaviour" as const,
			weight: 3,
			passed: 0,
			total: 3,
			indeterminate: 0,
			wilson: wilson95(0, 3),
			expected: true,
			evidence: ["négation universelle : …"],
		},
	],
	unmeasuredAxes: [],
	msMean: 42,
};

describe("report rendering", () => {
	const report = buildReport({
		label: "unit",
		fingerprint: FINGERPRINT,
		scenarios: [SCENARIO_REPORT],
		notices: ["D1 semble corrigé sur demo/beh.sandbox"],
		now: new Date("2026-07-31T10:00:00Z"),
	});

	it("prints the minimum detectable effect above the numbers", () => {
		const markdown = renderMarkdown(report);
		const mdeLine = markdown.indexOf("Effet minimal détectable");
		const firstScore = markdown.indexOf("comportement");
		expect(mdeLine).toBeGreaterThan(-1);
		expect(mdeLine).toBeLessThan(firstScore);
	});

	it("carries the run fingerprint, so a deepagents bump is attributable", () => {
		const markdown = renderMarkdown(report);
		expect(markdown).toContain("8742 car.");
		expect(markdown).toContain("deadbee");
		expect(markdown).toContain("(dirty)");
	});

	it("labels a known failure as such and surfaces its evidence", () => {
		const markdown = renderMarkdown(report);
		expect(markdown).toContain("| `beh.synthetique` | behaviour | 3 | 0/3 |");
		expect(markdown).toContain("connu");
		expect(markdown).toContain("négation universelle");
	});
});

describe("report write barrier", () => {
	const directory = mkdtempSync(join(tmpdir(), "wb-report-"));

	it("writes an ordinary payload", () => {
		const file = join(directory, "clean.md");
		writeReportFile(file, "# fine\n");
		expect(readFileSync(file, "utf8")).toBe("# fine\n");
	});

	it("refuses a payload carrying the key rather than scrubbing it", () => {
		// Scrubbing would hide that a report path touched the key at all.
		const saved = process.env[ENV_KEYS.apiKey];
		process.env[ENV_KEYS.apiKey] = "wb-not-a-real-key-0123456789";
		try {
			expect(() =>
				writeReportFile(join(directory, "leak.md"), "answer: wb-not-a-real-key-0123456789"),
			).toThrow(/refus d'écrire/);
		} finally {
			if (saved === undefined) delete process.env[ENV_KEYS.apiKey];
			else process.env[ENV_KEYS.apiKey] = saved;
		}
	});

	it("refuses a payload carrying an Authorization header", () => {
		expect(() =>
			writeReportFile(join(directory, "auth.md"), "authorization: Bearer abc.def.ghi"),
		).toThrow(/refus d'écrire/);
	});
});
