// L0 — the scoring machinery, the scenario loader and the ratchet. These are
// the parts that decide what a run MEANS, so they are tested harder than the
// scenarios they serve.

import { describe, expect, it } from "vitest";
import { assertAgainstBaseline, baselineFromRun, STALE_AFTER_DAYS } from "../lib/baseline";
import { singleClip } from "../lib/fixtures";
import { buildEvalContext } from "../lib/oracles";
import { type Check, defineScenario, fail, pass, type Scenario } from "../lib/scenario";
import { allResults, runChecks, STRUCTURAL_CHECKS, scoreRun } from "../lib/score";
import type { WireTranscript } from "../lib/wire";
import { allScenarios, getScenario, selectScenarios } from "../scenarios/registry";

const EMPTY_WIRE: WireTranscript = {
	systemBlocks: [],
	systemChars: 0,
	systemSha256: "",
	toolsSent: [],
	toolNames: [],
	toolsSha256: "",
	calls: [],
	rounds: 0,
};

function context(overrides?: { answer?: string; ok?: boolean; error?: string }) {
	const doc = singleClip();
	return buildEvalContext({
		answer: overrides?.answer ?? "",
		wire: EMPTY_WIRE,
		before: doc,
		after: doc,
		mutated: false,
		run: { ok: overrides?.ok ?? true, error: overrides?.error, ms: 1 },
	});
}

const always = (id: string, weight: number, ok: boolean): Check => ({
	id,
	weight,
	check: () => (ok ? pass() : fail(`${id} failed`)),
});

describe("runChecks", () => {
	it("weights the score rather than counting checks", () => {
		const axis = runChecks([always("a", 3, true), always("b", 1, false)], context());
		expect(axis.score).toBeCloseTo(0.75, 6);
		expect(axis.results.find((r) => r.id === "b")?.evidence).toBe("b failed");
	});

	it("scores an empty axis as 1 rather than dividing by zero", () => {
		expect(runChecks([], context()).score).toBe(1);
	});

	it("turns a throwing check into a failure, never a pass", () => {
		const boom: Check = {
			id: "boom",
			weight: 1,
			check: () => {
				throw new Error("oracle bug");
			},
		};
		const axis = runChecks([boom], context());
		expect(axis.results[0].ok).toBe(false);
		expect(axis.results[0].evidence).toContain("oracle bug");
	});

	it("marks a failure as expected when the scenario declared it", () => {
		const axis = runChecks([always("known", 1, false)], context(), { known: {} });
		expect(axis.results[0].expected).toBe(true);
	});
});

describe("scoreRun", () => {
	const base = (checks: { behaviour: Check[]; dsl: Check[] }): Scenario =>
		defineScenario({
			id: "unit-gate",
			title: "unit",
			tags: [],
			prompt: "p",
			document: () => singleClip(),
			gate: 0.5,
			behaviour: checks.behaviour,
			dsl: checks.dsl,
		});

	it("gates on min(behaviour, dsl), never on their mean", () => {
		// The case the user's criterion is about: a flawless edit described with
		// a lie. A mean would score 0.5 and pass the gate; min scores 0.
		const scenario = base({
			behaviour: [always("beh.lie", 1, false)],
			dsl: [always("dsl.perfect", 1, true)],
		});
		const run = scoreRun(scenario, context());
		expect(run.behaviour.score).toBe(0);
		expect(run.dsl.score).toBe(1);
		expect(run.gateScore).toBe(0);
		expect(run.passed).toBe(false);
	});

	it("appends the structural checks to the DSL axis of every scenario", () => {
		const scenario = base({ behaviour: [always("b", 1, true)], dsl: [always("d", 1, true)] });
		const ids = scoreRun(scenario, context()).dsl.results.map((r) => r.id);
		for (const structural of STRUCTURAL_CHECKS) expect(ids).toContain(structural.id);
	});

	it("carries the failure class alongside the score", () => {
		const scenario = base({ behaviour: [always("b", 1, true)], dsl: [always("d", 1, true)] });
		const run = scoreRun(scenario, context({ ok: false, error: "Empty response from model (…)" }));
		expect(run.failureClass).toBe("EMPTY_TEXT");
	});

	it("passes a healthy document through the structural checks", () => {
		const scenario = base({ behaviour: [always("b", 1, true)], dsl: [] });
		const run = scoreRun(scenario, context());
		expect(run.dsl.results.every((r) => r.ok)).toBe(true);
	});
});

describe("defineScenario", () => {
	const minimal = {
		id: "ok-id",
		title: "t",
		tags: [],
		prompt: "p",
		document: () => singleClip(),
		gate: 0.5,
		behaviour: [always("a", 1, true)],
		dsl: [],
	};

	it("accepts a well-formed scenario", () => {
		expect(defineScenario({ ...minimal }).id).toBe("ok-id");
	});

	it("rejects a non-kebab id, an out-of-range gate and an empty prompt", () => {
		expect(() => defineScenario({ ...minimal, id: "Not Kebab" })).toThrow(/kebab-case/);
		expect(() => defineScenario({ ...minimal, gate: 1.5 })).toThrow(/gate/);
		expect(() => defineScenario({ ...minimal, prompt: "  " })).toThrow(/prompt/);
	});

	it("rejects duplicate check ids across the two axes", () => {
		expect(() => defineScenario({ ...minimal, dsl: [always("a", 1, true)] })).toThrow(
			/duplicate check id a/,
		);
	});

	it("rejects a non-positive weight and a scenario with no checks", () => {
		expect(() => defineScenario({ ...minimal, behaviour: [always("a", 0, true)] })).toThrow(
			/non-positive weight/,
		);
		expect(() => defineScenario({ ...minimal, behaviour: [] })).toThrow(/no checks/);
	});

	it("rejects an expectedFailures entry naming a check that does not exist", () => {
		expect(() =>
			defineScenario({
				...minimal,
				expectedFailures: { ghost: { defect: "D9", since: "2026-01-01" } },
			}),
		).toThrow(/unknown check ghost/);
	});
});

describe("scenario registry", () => {
	it("loads every scenario and keeps their ids unique", () => {
		const scenarios = allScenarios();
		expect(scenarios.length).toBeGreaterThanOrEqual(3);
		expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
	});

	it("builds each scenario's document as a schema-valid one", () => {
		// The fixtures are hand-written documents, exactly the thing that drifted
		// out of the schema before tsconfig.test.json existed. `workbench/` is
		// outside the CI typecheck ratchet, so this is the net.
		for (const scenario of allScenarios()) expect(() => scenario.document()).not.toThrow();
	});

	it("selects by id and by tag, and complains about a typo", () => {
		expect(selectScenarios({ ids: ["consent"] }).map((s) => s.id)).toEqual(["consent"]);
		expect(selectScenarios({ tags: ["D1"] }).map((s) => s.id)).toContain("wizard-enhance");
		expect(selectScenarios({}).length).toBe(allScenarios().length);
		expect(() => getScenario("nope")).toThrow(/unknown scenario/);
	});
});

describe("baseline ratchet", () => {
	const scenario = defineScenario({
		id: "ratchet",
		title: "t",
		tags: [],
		prompt: "p",
		document: () => singleClip(),
		gate: 0,
		behaviour: [always("beh.known", 1, false), always("beh.fresh", 1, true)],
		dsl: [],
		expectedFailures: { "beh.known": { defect: "D1", since: "2026-07-31" } },
	});
	const results = runChecks(scenario.behaviour, context(), scenario.expectedFailures).results;

	it("stays quiet on a known failure", () => {
		const verdict = assertAgainstBaseline({
			scenario,
			results,
			baseline: null,
			now: new Date("2026-08-01T00:00:00Z"),
		});
		expect(verdict.ok).toBe(true);
		expect(verdict.regressions).toEqual([]);
	});

	it("reports a new failure as a regression", () => {
		const regressed = runChecks(
			[always("beh.known", 1, false), always("beh.fresh", 1, false)],
			context(),
			scenario.expectedFailures,
		).results;
		const verdict = assertAgainstBaseline({
			scenario,
			results: regressed,
			baseline: null,
			now: new Date("2026-08-01T00:00:00Z"),
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.regressions).toEqual(["beh.fresh"]);
	});

	it("reports a known failure that started passing, so the entry gets harvested", () => {
		const fixed = runChecks(
			[always("beh.known", 1, true), always("beh.fresh", 1, true)],
			context(),
			scenario.expectedFailures,
		).results;
		const verdict = assertAgainstBaseline({
			scenario,
			results: fixed,
			baseline: null,
			now: new Date("2026-08-01T00:00:00Z"),
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.fixed).toEqual(["beh.known"]);
		expect(verdict.messages.join(" ")).toMatch(/D1 semble corrigé/);
	});

	it("flags an expectedFailures entry left to rot", () => {
		const later = new Date(Date.parse("2026-07-31") + (STALE_AFTER_DAYS + 2) * 86_400_000);
		const verdict = assertAgainstBaseline({ scenario, results, baseline: null, now: later });
		expect(verdict.stale.map((s) => s.id)).toEqual(["beh.known"]);
	});

	it("records a baseline from a run's own failures", () => {
		const baseline = baselineFromRun({
			scenarioId: "ratchet",
			results,
			behaviour: 0.5,
			dsl: 1,
			now: new Date("2026-07-31T12:00:00Z"),
		});
		expect(baseline).toEqual({
			scenario: "ratchet",
			expectedFailures: ["beh.known"],
			// Écrit même vide : « tout a été tranché » est une affirmation, et son
			// absence se lirait comme « la question ne se posait pas ».
			undecided: [],
			behaviour: 0.5,
			dsl: 1,
			recordedAt: "2026-07-31",
		});
	});
});

describe("allResults", () => {
	it("flattens both axes for reporting", () => {
		const scenario = defineScenario({
			id: "flat",
			title: "t",
			tags: [],
			prompt: "p",
			document: () => singleClip(),
			gate: 0,
			behaviour: [always("b", 1, true)],
			dsl: [always("d", 1, true)],
		});
		const ids = allResults(scoreRun(scenario, context())).map((r) => r.id);
		expect(ids).toContain("b");
		expect(ids).toContain("d");
		expect(ids).toContain("struct.schema-valid");
	});
});
