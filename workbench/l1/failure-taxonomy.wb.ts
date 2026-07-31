// L1 — the failure taxonomy, locked against the real chain.
//
// It used to say: a model that types an argument wrong ("startSec": "3") does
// not get a second chance. Under `createDeepAgent` that was true — LangChain's
// zod binding threw, the throw escaped, `deep-agent/service.ts` swallowed it and
// `chat-service.ts` re-labelled the empty turn "Empty response from model", the
// exact words a genuinely mute provider produces.
//
// Under `createAgent` it is no longer true, and that is a product change worth
// stating rather than discovering: LangChain's ToolNode catches the parse
// failure and returns it as the TOOL RESULT ("… Please fix the error and try
// again"), so the model sees its own mistake and gets another round. The
// substring moved from `run.error` to the wire; it is still not ours, so it is
// still locked here — a version bump that reworded it would make bad emissions
// invisible instead of merely misclassified.

import { describe, expect, it } from "vitest";
import { singleClip } from "../lib/fixtures";
import { runScenario } from "../lib/harness";
import { classifyFailure } from "../lib/oracles";
import { EMPTY_RESPONSE_ERROR, LANGCHAIN_SCHEMA_ERROR } from "../lib/prompts";

const BAD_ARGS = '{"startSec":"3","endSec":5}';

describe("invalid arguments from the model", () => {
	it("come back as a tool result carrying the substring the taxonomy depends on", async () => {
		const run = await runScenario({
			label: "l1-invalid-dsl",
			prompt: "zoom please",
			document: singleClip(),
			script: [
				// String seconds where the schema wants a number — the failure mode
				// observed on the real provider.
				{ kind: "tools", calls: [{ name: "addZoom", args: BAD_ARGS }] },
				{ kind: "text", text: "corrected" },
			],
		});
		expect(run.ok).toBe(true);
		const call = run.wire.calls.find((c) => c.name === "addZoom");
		expect(call?.resultJson).toContain(LANGCHAIN_SCHEMA_ERROR);
		expect(call?.resultOk).toBe(false);
		// The TURN is fine: the taxonomy classifies the run, and the run survived.
		expect(classifyFailure({ ok: run.ok, error: run.error })).toBe("NONE");
	});

	it("give the model another round instead of killing the turn", async () => {
		const run = await runScenario({
			label: "l1-retry",
			prompt: "zoom please",
			document: singleClip(),
			script: [
				{ kind: "tools", calls: [{ name: "addZoom", args: BAD_ARGS }] },
				{ kind: "text", text: "sorry — 3 to 5 seconds" },
			],
		});
		// Two rounds: the loop came back, which is the whole difference.
		expect(run.wire.rounds).toBe(2);
		expect(run.answer).toContain("sorry");
	});

	it("nothing was written, and the sink says nothing at all", async () => {
		// The tool body never ran, so there is no verdict to report — and the
		// stream loop no longer invents one. Silence is the honest emission.
		const run = await runScenario({
			label: "l1-invalid-dsl-silent",
			prompt: "zoom please",
			document: singleClip(),
			script: [
				{ kind: "tools", calls: [{ name: "addZoom", args: BAD_ARGS }] },
				{ kind: "text", text: "corrected" },
			],
		});
		expect(run.document?.zoomRanges ?? []).toHaveLength(0);
		expect(run.events.filter((e) => e.kind === "toolStart" || e.kind === "toolEnd")).toEqual([]);
	});

	it("a turn the provider ends without text still reads as a mute provider", async () => {
		// Unchanged, and still a product defect worth keeping visible: the user
		// cannot tell an exhausted script from a silent model.
		const run = await runScenario({
			label: "l1-invalid-dsl-label",
			prompt: "zoom please",
			document: singleClip(),
			script: [{ kind: "tools", calls: [{ name: "addZoom", args: BAD_ARGS }] }],
		});
		expect(run.error).toContain(EMPTY_RESPONSE_ERROR);
	});
});

describe("semantic errors, by contrast, are fed back", () => {
	it("an unknown id reaches the model as a tool result and the turn survives", async () => {
		const run = await runScenario({
			label: "l1-unknown-id",
			prompt: "widen that zoom",
			document: singleClip(),
			script: [
				{ kind: "tools", calls: [{ name: "setZoom", args: { zoomId: "zoom_nope", depth: 4 } }] },
				{ kind: "text", text: "That zoom does not exist." },
			],
		});
		expect(run.ok).toBe(true);
		const call = run.wire.calls.find((c) => c.name === "setZoom");
		expect(call?.resultOk).toBe(false);
		expect(call?.resultJson).toContain("Unknown zoom");
		expect(classifyFailure({ ok: run.ok, error: run.error })).toBe("NONE");
	});

	it("a read tool's error now reaches the sink as a failure", async () => {
		// Was: "invisible to the sink but visible on the wire". Read tools had no
		// emission of their own, and the stream loop hard-coded ok=true, so a
		// `getTranscript` that returned `{"error":"No transcript…"}` was announced
		// as a success. Both halves now agree.
		const run = await runScenario({
			label: "l1-read-error",
			prompt: "what is said?",
			document: singleClip(),
			script: [
				{ kind: "tools", calls: [{ name: "getTranscript", args: {} }] },
				{ kind: "text", text: "No transcript." },
			],
		});
		const call = run.wire.calls.find((c) => c.name === "getTranscript");
		expect(call?.resultOk).toBe(false);
		const sinkEnds = run.events.filter((e) => e.kind === "toolEnd" && e.name === "getTranscript");
		expect(sinkEnds).toHaveLength(1);
		expect(sinkEnds[0].ok).toBe(false);
	});
});

describe("the harness's own stop", () => {
	it("classifies its timeout as ours, not as the model's", () => {
		expect(classifyFailure({ ok: false, error: "workbench timeout after 5 ms" })).toBe("TIMEOUT");
	});
});
