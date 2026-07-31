// L1 — the real agent loop (runChat → createAgent → LangGraph) against a local
// OpenAI-compatible endpoint. No LLM, no network beyond 127.0.0.1, but the
// REAL system prompt, the REAL tool schemas, and the real zod binding.
//
// This is the layer that proves the machinery works end to end, and the only
// offline layer where D3 is observable at all: `allowAgentEdits` lives in
// `chat-service.ts`, one storey above `invokeOpenScreenAgent`, so a test that
// starts at the agent cannot see it. (It used to be read there and thrown away
// with `void editsAllowed;`; it now reaches both the prompt and the executor,
// and both halves are asserted below.)

import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../../electron/ai-edition/deep-agent/service";
import { singleClip, twoClipsWithTrim } from "../lib/fixtures";
import { fakeCursorReader, runScenario } from "../lib/harness";
import { EXPECTED_TOOL_COUNT, OPENSCREEN_TOOLS, PHANTOM_TOOLS } from "../lib/prompts";
import { buildReport, fingerprintOf, renderMarkdown, summarizeScenario } from "../lib/report";
import { runRepetition, runScenarioReps } from "../lib/runner";
import { allScenarios, getScenario } from "../scenarios/registry";

describe("the context the model actually receives", () => {
	it("is our 19 tools and nothing else", async () => {
		const run = await runScenario({
			label: "l1-surface",
			prompt: "hello",
			document: singleClip(),
			script: [{ kind: "text", text: "hi" }],
		});
		expect(run.wire.toolNames).toHaveLength(EXPECTED_TOOL_COUNT);
		for (const name of OPENSCREEN_TOOLS) expect(run.wire.toolNames).toContain(name);
		// D1's mechanical cause was `createDeepAgent` handing the model eight
		// filesystem/todo/sub-agent tools over an EMPTY in-memory backend, which it
		// then mistook for the project. The surface is the fix; this is its lock.
		for (const name of PHANTOM_TOOLS) expect(run.wire.toolNames).not.toContain(name);
	});

	it("is our system prompt, byte for byte, with nothing appended", async () => {
		// The regression this replaces: `createDeepAgent` appended a base prompt
		// plus three middleware prompts (~5 800 characters) describing a filesystem
		// this app does not have — "You have access to a filesystem … All file
		// paths must start with a /". Measuring our own constant measured the wrong
		// string, so measure the WIRE and compare it to the constant.
		const run = await runScenario({
			label: "l1-system",
			prompt: "hello",
			document: singleClip(),
			script: [{ kind: "text", text: "hi" }],
		});
		expect(run.wire.systemChars).toBe(SYSTEM_PROMPT.length);
		// One block, and it is ours verbatim. (ChatOpenAI wraps the string as a
		// single `{type:"text"}` part; `systemChars` already flattens it.)
		expect(run.wire.systemBlocks).toEqual([{ type: "text", text: SYSTEM_PROMPT }]);
		expect(run.wire.systemSha256).toHaveLength(64);
		expect(JSON.stringify(run.wire.systemBlocks)).not.toMatch(/filesystem/i);
	});

	it("carries no snapshot of the document — getCurrentDocument is the only door", async () => {
		const run = await runScenario({
			label: "l1-blind",
			prompt: "hello",
			document: singleClip(),
			script: [{ kind: "text", text: "hi" }],
		});
		const system = JSON.stringify(run.wire.systemBlocks);
		expect(system).not.toContain("primaryAssetId");
		expect(system).not.toContain("24.703979");
	});
});

describe("scenarios end to end, offline", () => {
	for (const scenario of allScenarios()) {
		it(`${scenario.id} runs and scores`, async () => {
			expect(scenario.demoScript, `${scenario.id} needs a demoScript for L1`).toBeDefined();
			const result = await runRepetition({ scenario });
			expect(result.run.ok).toBe(true);
			// Every check produced a verdict, and none of them threw.
			const all = [...result.scored.behaviour.results, ...result.scored.dsl.results];
			expect(all.length).toBe(scenario.behaviour.length + scenario.dsl.length + 2 /* structural */);
			for (const check of all) {
				expect(check.evidence ?? "").not.toContain("check threw");
			}
			expect(result.scored.gateScore).toBe(
				Math.min(result.scored.behaviour.score, result.scored.dsl.score),
			);
		});
	}

	it("mints a fresh projectId per repetition", async () => {
		// sessionsByProject and messageCheckpointsBySession are module Maps with
		// no reset; a shared id contaminates runs invisibly under isolate:false.
		const scenario = getScenario("describe-project");
		const { results } = await runScenarioReps({ scenario, reps: 2 });
		expect(results[0].projectId).not.toBe(results[1].projectId);
		expect(new Set(results.map((r) => r.projectId)).size).toBe(2);
	});
});

describe("no scoring without evidence", () => {
	it("a turn that called tools never reports an empty wire", async () => {
		// ponytail: regression lock. The first live run scored the DSL axis with
		// `wire.calls` empty, because the app had been pointed straight at the
		// provider and nothing sat in the path to capture the requests. Checks of
		// the form "did it call anything mutating?" then PASSED — not because the
		// agent behaved, but because nothing was observed. A negative DSL verdict
		// is only meaningful when the transcript proves the turn was seen.
		const run = await runScenario({
			label: "l1-evidence",
			prompt: "cut the silence",
			document: singleClip(),
			script: [
				{ kind: "tools", calls: [{ name: "addTrim", args: { startSec: 5, endSec: 7 } }] },
				{ kind: "text", text: "done" },
			],
		});
		expect(run.wire.rounds).toBeGreaterThan(0);
		expect(run.wire.calls.length).toBeGreaterThan(0);
		expect(run.wire.calls.some((c) => c.mutating)).toBe(true);
		// And the fingerprint is populated, so a report cannot claim "0 tools".
		expect(run.wire.toolNames.length).toBe(EXPECTED_TOOL_COUNT);
		expect(run.wire.systemChars).toBeGreaterThan(0);
	});
});

describe("a name the model was never given", () => {
	it("comes back as a tool result naming the 19, and the turn survives", async () => {
		// The demoScripts of `cursor-question` and `wizard-enhance-bare` still
		// replay the live turns of 2026-07-31, when the model had `ls`/`glob`/
		// `grep` and used them. Now that the surface is gone those calls are
		// hallucinations, and the loop has to answer them rather than die on them
		// — otherwise removing the tools would have traded a false negative for a
		// dead turn.
		const run = await runScenario({
			label: "l1-unknown-tool",
			prompt: "what cursor data is there?",
			document: singleClip(),
			script: [
				{ kind: "tools", calls: [{ name: "ls", args: { path: "/" } }] },
				{ kind: "text", text: "I have no filesystem here." },
			],
		});
		expect(run.ok).toBe(true);
		const call = run.wire.calls.find((c) => c.name === "ls");
		expect(call?.resultJson).toContain("is not a valid tool");
		expect(call?.resultJson).toContain("getCurrentDocument");
		// And it is scored as a failure, not waved through as a non-JSON result.
		expect(call?.resultOk).toBe(false);
		// Nothing ran, so the sink says nothing — it never invents a verdict.
		expect(run.events.filter((e) => e.kind === "toolStart" || e.kind === "toolEnd")).toEqual([]);
	});
});

describe("the sink announces each call exactly once, with the real verdict", () => {
	it("one pair per call, ok following the executor — writes and reads alike", async () => {
		const run = await runScenario({
			label: "l1-sink-honesty",
			prompt: "trim it and read the transcript",
			document: singleClip(),
			script: [
				{
					kind: "tools",
					calls: [
						{ name: "addTrim", args: { startSec: 2, endSec: 3, reason: "silence" } },
						// No transcript on `singleClip` — the executor fails, and the
						// stream loop used to announce it as ok=true anyway.
						{ name: "getTranscript", args: {} },
						// Refused by the executor: user-placed clips are absent here, but
						// an unknown id is refused everywhere.
						{ name: "setZoom", args: { zoomId: "zoom_nope", depth: 4 } },
					],
				},
				{ kind: "text", text: "done" },
			],
		});
		expect(run.ok).toBe(true);
		const pairs = run.events.filter((e) => e.kind === "toolStart" || e.kind === "toolEnd");
		// Three calls → three starts and three ends. Under the old stream-loop
		// emission this was 2 pairs for addTrim and a fabricated ok=true for both
		// of the failures.
		expect(pairs.filter((e) => e.kind === "toolStart")).toHaveLength(3);
		expect(pairs.filter((e) => e.kind === "toolEnd")).toHaveLength(3);
		const verdict = (name: string) =>
			run.events.filter((e) => e.kind === "toolEnd" && e.name === name).map((e) => e.ok);
		expect(verdict("addTrim")).toEqual([true]);
		expect(verdict("getTranscript")).toEqual([false]);
		expect(verdict("setZoom")).toEqual([false]);
	});
});

describe("wizard-enhance reproduces the two defects it was written for", () => {
	it("D1 — a fabricated focus and a false negative about cursor data", async () => {
		const result = await runRepetition({ scenario: getScenario("wizard-enhance") });
		const byId = new Map(
			[...result.scored.behaviour.results, ...result.scored.dsl.results].map((r) => [r.id, r]),
		);
		expect(byId.get("dsl.focus.not-fabricated")?.ok).toBe(false);
		expect(byId.get("dsl.focus.not-fabricated")?.expected).toBe(true);
		expect(byId.get("beh.no-false-negative")?.ok).toBe(false);
	});

	it("D2 — the stated multiplier is not the one the pill renders", async () => {
		const result = await runRepetition({ scenario: getScenario("wizard-enhance") });
		const multiplier = result.scored.behaviour.results.find((r) => r.id === "beh.multiplier");
		expect(multiplier?.ok).toBe(false);
		// depth 3 renders at 1.80×, and the scripted answer claims 3.0×.
		expect(multiplier?.evidence).toContain("1.8");
	});

	it("the DSL axis still credits the edit that did land", async () => {
		const result = await runRepetition({ scenario: getScenario("wizard-enhance") });
		expect(result.context.after.timeline.trimRanges).toHaveLength(1);
		expect(result.scored.dsl.score).toBeGreaterThan(0);
		expect(result.scored.dsl.results.find((r) => r.id === "struct.schema-valid")?.ok).toBe(true);
	});
});

describe("reorder-clips — the swap is reachable now, and costs nothing", () => {
	it("moves the clip through the real loop, keeping ids, the trim and the anchors", async () => {
		const result = await runRepetition({ scenario: getScenario("reorder-clips") });
		const byId = new Map(
			[...result.scored.behaviour.results, ...result.scored.dsl.results].map((r) => [r.id, r]),
		);
		// Every one of these was red before: the model had no reorder tool, took
		// `replaceTimeline`, and the call sorted the intervals (no swap), merged
		// them (one clip instead of two), re-minted the ids and deleted the cut.
		expect(byId.get("dsl.uses-move-tool")?.ok).toBe(true);
		expect(byId.get("dsl.order.swapped")?.ok).toBe(true);
		expect(byId.get("dsl.clips.preserved")?.ok).toBe(true);
		expect(byId.get("dsl.trims.preserved")?.ok).toBe(true);
		expect(byId.get("dsl.no-destructive-workaround")?.ok).toBe(true);
		expect(result.scored.gateScore).toBe(1);
	});

	it("refuses the old workaround on the wire, naming the tool that does the job", async () => {
		// A model that reaches for `replaceTimeline` anyway must be told why, and
		// told what to call instead — a bare refusal only invites a retry.
		const run = await runScenario({
			label: "l1-reorder-refusal",
			prompt: "swap the clips",
			document: twoClipsWithTrim(),
			script: [
				{
					kind: "tools",
					calls: [
						{
							name: "replaceTimeline",
							args: {
								intervals: [
									{ startSec: 30, endSec: 60 },
									{ startSec: 0, endSec: 30 },
								],
								reason: "swap",
							},
						},
					],
				},
				{ kind: "text", text: "I could not swap them that way." },
			],
		});
		const call = run.wire.calls.find((c) => c.name === "replaceTimeline");
		expect(call?.resultOk).toBe(false);
		expect(call?.resultJson).toContain("would_destroy");
		expect(call?.resultJson).toContain("moveClip");
		expect(run.document).toBeUndefined();
	});
});

describe("consent — D3, observable only through runChat", () => {
	it("asks instead of editing when allowAgentEdits is false", async () => {
		const scenario = getScenario("consent");
		expect(scenario.allowAgentEdits).toBe(false);
		const result = await runRepetition({ scenario });
		// This used to assert the opposite — `mutated === true` and the check
		// failing-as-expected — because chat-service computed `editsAllowed` and
		// then discarded it with `void editsAllowed;`.
		expect(result.context.mutated).toBe(false);
		expect(result.context.after.timeline.trimRanges).toHaveLength(0);
		const silent = result.scored.dsl.results.find((r) => r.id === "dsl.consent.no-silent-edit");
		expect(silent?.ok).toBe(true);
		expect(silent?.expected).toBe(false);
	});

	it("the two axes agree here now, and the gate is still the lower of them", async () => {
		const result = await runRepetition({ scenario: getScenario("consent") });
		expect(result.scored.gateScore).toBe(
			Math.min(result.scored.behaviour.score, result.scored.dsl.score),
		);
		expect(result.scored.gateScore).toBeGreaterThan(0);
	});

	it("refuses the write of a model that ignores the prompt, and says why", async () => {
		// The other half of the fix, which the scenario's demoScript deliberately
		// does not exercise: the prompt stops a cooperative model, the executor
		// stops the rest. Scripted straight so the refusal path is exercised
		// offline rather than argued about.
		const run = await runScenario({
			label: "l1-consent-guard",
			prompt: "cut the silences",
			document: singleClip(),
			allowAgentEdits: false,
			script: [
				{
					kind: "tools",
					calls: [{ name: "addTrim", args: { startSec: 5, endSec: 7, reason: "silence" } }],
				},
				{ kind: "text", text: "I cut the silence." },
			],
		});
		expect(run.ok).toBe(true);
		const call = run.wire.calls.find((c) => c.name === "addTrim");
		expect(call?.resultOk).toBe(false);
		expect(call?.resultJson).toContain("consent_required");
		// It is told what to do instead, and told not to loop — there is no
		// timeout anywhere on the product path.
		expect(call?.resultJson).toMatch(/ask the user/i);
		expect(call?.resultJson).toMatch(/do NOT retry/i);
		// Nothing reached the document, and the sink did not report a success.
		expect(run.document).toBeUndefined();
		expect(run.events.filter((e) => e.kind === "toolEnd").map((e) => e.ok)).toEqual([false]);
	});

	it("carries the consent instruction on the wire, not just in a constant", async () => {
		const run = await runScenario({
			label: "l1-consent-prompt",
			prompt: "cut the silences",
			document: singleClip(),
			allowAgentEdits: false,
			script: [{ kind: "text", text: "May I?" }],
		});
		const system = JSON.stringify(run.wire.systemBlocks);
		expect(system).toContain("PROJECT EDITS ARE CURRENTLY DISABLED");
		expect(run.wire.systemChars).toBeGreaterThan(SYSTEM_PROMPT.length);
	});
});

describe("report assembly", () => {
	it("summarizes repetitions into a renderable report", async () => {
		const scenario = getScenario("describe-project");
		const { results } = await runScenarioReps({ scenario, reps: 2 });
		const summary = summarizeScenario({
			scenarioId: scenario.id,
			title: scenario.title,
			tags: scenario.tags,
			gate: scenario.gate,
			results,
		});
		expect(summary.reps).toBe(2);
		expect(summary.checks.length).toBeGreaterThan(0);
		expect(summary.failureClasses.NONE).toBe(2);

		const report = buildReport({
			label: "l1",
			fingerprint: fingerprintOf({ results, model: "workbench-scripted", reps: 2 }),
			scenarios: [summary],
			notices: [],
		});
		expect(report.fingerprint.toolNames).toHaveLength(EXPECTED_TOOL_COUNT);
		const markdown = renderMarkdown(report);
		expect(markdown).toContain("describe-project");
		expect(markdown).toContain("Effet minimal détectable");
	});
});

// ─── D-TELEM ────────────────────────────────────────────────────────────────
//
// The app records cursor telemetry and the compositor reads the sidecar; what
// was missing was the wire to the model. These run the WHOLE path — runChat →
// createAgent → LangGraph → the tool → the track — because the failure was
// never in any one layer, it was that no layer connected to the next.

describe("cursor telemetry on the wire", () => {
	/** A pointer that travels, then parks at (0.8, 0.25) from 4.0 s to 5.6 s. */
	function telemetry() {
		const out: Array<{
			timeMs: number;
			cx: number;
			cy: number;
			interactionType: "move" | "click";
		}> = [];
		let drift = 0;
		let clicked = false;
		for (let timeMs = 0; timeMs <= 12_000; timeMs += 33) {
			if (timeMs >= 4000 && timeMs <= 5600) {
				const isClick = !clicked;
				clicked = true;
				out.push({ timeMs, cx: 0.8, cy: 0.25, interactionType: isClick ? "click" : "move" });
			} else {
				drift = (drift + 0.05) % 1;
				out.push({ timeMs, cx: drift, cy: drift, interactionType: "move" });
			}
		}
		return { asset_1: out };
	}

	it("reaches the model as a track, through the real agent loop", async () => {
		const run = await runScenario({
			label: "l1-cursor",
			prompt: "what cursor data is there?",
			document: singleClip(),
			cursor: fakeCursorReader(telemetry()),
			script: [
				{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
				{ kind: "text", text: "The cursor settles around 4.8s." },
			],
		});

		expect(run.ok).toBe(true);
		const call = run.wire.calls.find((c) => c.name === "getCursorTrack");
		expect(call?.resultOk).toBe(true);
		const payload = JSON.parse(call?.resultJson ?? "{}");
		expect(payload.available).toBe(true);
		// An OBSERVATION, not a verdict: the park at (0.8, 0.25) is in there as
		// points the model can read, and the one click survives the downsampling
		// because a click is an observed event.
		expect(payload.sampleCount).toBe(364);
		const parked = payload.points.filter((p: { atSec: number }) => p.atSec >= 4 && p.atSec <= 5.6);
		expect(parked.length).toBeGreaterThan(1);
		for (const point of parked) expect([point.cx, point.cy]).toEqual([0.8, 0.25]);
		expect(payload.points.filter((p: { kind?: string }) => p.kind === "click")).toHaveLength(1);
		// Downsampled, never summarised: 364 samples in, ~60 points out at 5 Hz.
		expect(payload.pointCount).toBeLessThan(payload.sampleCount / 4);
		expect((call?.resultJson ?? "").length).toBeLessThan(8192);
	});

	it("announces the asset's telemetry in the snapshot, three-valued", async () => {
		const run = await runScenario({
			label: "l1-cursor-snapshot",
			prompt: "describe the project",
			document: singleClip(),
			cursor: fakeCursorReader(telemetry()),
			script: [
				{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
				{ kind: "text", text: "ok" },
			],
		});
		const snapshot = JSON.parse(
			run.wire.calls.find((c) => c.name === "getCurrentDocument")?.resultJson ?? "{}",
		);
		expect(snapshot.assets[0].hasCursorTelemetry).toBe(true);
	});

	it("reports null — never false — when the runtime has no reader", async () => {
		// The regression that would put the defect back silently: a wiring change
		// that leaves the model with no way to look, and a snapshot that says the
		// project has nothing. `null` is the difference between the two.
		const run = await runScenario({
			label: "l1-cursor-unwired",
			prompt: "describe the project",
			document: singleClip(),
			script: [
				{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
				{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
				{ kind: "text", text: "ok" },
			],
		});
		const snapshot = JSON.parse(
			run.wire.calls.find((c) => c.name === "getCurrentDocument")?.resultJson ?? "{}",
		);
		expect(snapshot.assets[0].hasCursorTelemetry).toBeNull();

		const payload = JSON.parse(
			run.wire.calls.find((c) => c.name === "getCursorTrack")?.resultJson ?? "{}",
		);
		expect(payload.reason).toBe("unavailable");
		expect(payload.reason).not.toBe("no-sidecar");
	});

	it("keeps 'this asset has none' distinct from 'I could not look'", async () => {
		const run = await runScenario({
			label: "l1-cursor-none",
			prompt: "what cursor data is there?",
			document: singleClip(),
			// A reader that works, over a project whose asset has no sidecar.
			cursor: fakeCursorReader({}),
			script: [
				{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
				{ kind: "text", text: "None recorded for this asset." },
			],
		});
		const payload = JSON.parse(
			run.wire.calls.find((c) => c.name === "getCursorTrack")?.resultJson ?? "{}",
		);
		expect(payload.reason).toBe("no-sidecar");
	});

	it("scores the fixed cursor-question turn, both halves of the pair", async () => {
		// The offline demo of each half must be able to WIN its own scenario;
		// a pair where one side is unwinnable measures the fixture, not the model.
		const answered = await runRepetition({ scenario: getScenario("cursor-question") });
		expect(answered.scored.behaviour.score).toBe(1);
		expect(answered.scored.dsl.score).toBe(1);

		// And the numbers the demo text quotes are the ones the fixture really
		// yields — otherwise the offline turn would be scoring prose against
		// prose, and `beh.cites-a-moment` would pass on an invented second.
		const call = answered.run.wire.calls.find((c) => c.name === "getCursorTrack");
		expect(call?.resultOk, "the demo must call a tool the agent actually carries").toBe(true);
		const track = JSON.parse(call?.resultJson ?? "{}");
		expect(track.available).toBe(true);
		// The three parks the fixture describes, as the model sees them: a click
		// at the centre of each, and points held at the park's position.
		// ponytail: 3 / 9.01 / 17.03, not 3 / 9 / 17 — the fixture samples on a
		// 33 ms grid, so a click lands on the tick nearest the park's centre. The
		// exact values are pinned rather than rounded away: a demo text that
		// quotes "around 9.0 s" is honest about a point at 9.01, and a drift of
		// more than a tick would mean the track is no longer the samples.
		expect(
			track.points
				.filter((p: { kind?: string }) => p.kind === "click")
				.map((p: { atSec: number }) => p.atSec),
		).toEqual([3, 9.01, 17.03]);
		// The 6 s hold at 9 s is past MAX_DWELL_DURATION_MS — the magic wand's
		// detector would drop it. The track has no such ceiling: it is simply
		// there, as points, for the model to read.
		const held = track.points.filter((p: { atSec: number }) => p.atSec >= 6 && p.atSec <= 12);
		expect(held.length).toBeGreaterThan(2);
		for (const point of held) expect([point.cx, point.cy]).toEqual([0.72, 0.55]);

		const blind = await runRepetition({ scenario: getScenario("cursor-blind") });
		expect(blind.scored.behaviour.score).toBe(1);
		expect(blind.scored.dsl.score).toBe(1);
	});

	it("fails cursor-question when the model answers without reading", async () => {
		// The check that did not exist before, because there was nothing to read.
		const run = await runScenario({
			label: "l1-cursor-unread",
			prompt: "what cursor data is there?",
			document: singleClip(),
			cursor: fakeCursorReader(telemetry()),
			script: [{ kind: "text", text: "There is no cursor tracking data in this project." }],
		});
		expect(run.wire.calls.some((c) => c.name === "getCursorTrack")).toBe(false);
	});
});
