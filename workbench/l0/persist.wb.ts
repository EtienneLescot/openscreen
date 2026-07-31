// L0 — the raw turns must survive to disk, complete, bounded, and without the
// key.
//
// The barrier test is the one that matters: a persisted run is the first thing
// in this workbench that writes MODEL TEXT and TOOL RESULTS to a file nobody
// reviews before it lands. `report.ts` already refuses a payload carrying a
// credential; this proves the run files go through the same door rather than
// around it.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { ENV_KEYS } from "../lib/env";
import { longTranscript, twoClipsWithTrim } from "../lib/fixtures";
import type { CapturedRequest } from "../lib/model-server";
import { buildEvalContext } from "../lib/oracles";
import {
	buildPersistedTurn,
	MAX_FIELD_CHARS,
	MAX_SEGMENTS,
	type PersistedTurn,
	persistRepetition,
} from "../lib/persist";
import type { RepetitionResult } from "../lib/runner";
import { scoreRun } from "../lib/score";
import { wireFromRequests } from "../lib/wire";
import { getScenario } from "../scenarios/registry";

const SYSTEM_TEXT = "You are OpenScreen's editing agent. Ten thousand characters, abridged.";
const scenario = getScenario("describe-project");

function capturedRequests(options: { resultJson: string }): CapturedRequest[] {
	const system = { role: "system", content: SYSTEM_TEXT };
	const user = { role: "user", content: scenario.prompt };
	const assistant = {
		role: "assistant",
		content: "",
		tool_calls: [
			{
				id: "call_1",
				function: {
					name: "addTrim",
					arguments: '{"startSec":10,"endSec":12.5,"reason":"silence"}',
				},
			},
		],
	};
	const toolResult = { role: "tool", tool_call_id: "call_1", content: options.resultJson };
	const compact = (messages: Array<Record<string, unknown>>) =>
		messages.map((message) => ({
			role: String(message.role),
			content: typeof message.content === "string" ? message.content : "",
			toolCalls: ((message.tool_calls ?? []) as Array<{ function?: { name?: string } }>).map(
				(call) => call.function?.name ?? "?",
			),
		}));
	const tools = [{ function: { name: "addTrim", description: "cut", parameters: {} } }];
	const first = [system, user];
	const second = [system, user, assistant, toolResult];
	return [
		{
			round: 0,
			systemChars: SYSTEM_TEXT.length,
			toolNames: ["addTrim"],
			messages: compact(first),
			raw: { messages: first, tools },
		},
		{
			round: 1,
			systemChars: SYSTEM_TEXT.length,
			toolNames: ["addTrim"],
			messages: compact(second),
			raw: { messages: second, tools },
		},
	];
}

function repetition(options?: {
	answer?: string;
	resultJson?: string;
	document?: AxcutDocument;
	rep?: number;
}): RepetitionResult {
	const before = options?.document ?? twoClipsWithTrim();
	const requests = capturedRequests({
		resultJson: options?.resultJson ?? '{"trimRangeId":"trim_9"}',
	});
	const wire = wireFromRequests(requests);
	const context = buildEvalContext({
		answer: options?.answer ?? "Two clips, one trim.",
		wire,
		before,
		after: before,
		mutated: false,
		run: { ok: true, ms: 1234 },
	});
	return {
		scenarioId: scenario.id,
		rep: options?.rep ?? 0,
		projectId: "describe-project_abcd1234",
		scored: scoreRun(scenario, context),
		context,
		run: {
			ok: true,
			answer: options?.answer ?? "Two clips, one trim.",
			projectId: "describe-project_abcd1234",
			events: [],
			wire,
			requests,
			ms: 1234,
		},
	};
}

const directories: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "wb-persist-"));
	directories.push(dir);
	return dir;
}

afterEach(() => {
	while (directories.length > 0) {
		const dir = directories.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function readTurn(file: string): PersistedTurn {
	return JSON.parse(readFileSync(file, "utf8")) as PersistedTurn;
}

describe("persistRepetition", () => {
	it("writes one self-contained file per repetition", () => {
		const root = scratch();
		const written = persistRepetition({
			root,
			label: "baseline",
			result: repetition(),
			prompt: scenario.prompt,
			allowAgentEdits: true,
		});
		expect(written.file).toBe(`${root}/baseline/describe-project/rep-0.json`);

		const turn = readTurn(written.file);
		expect(turn.schema).toBe(1);
		expect(turn.prompt).toBe(scenario.prompt);
		expect(turn.answer).toBe("Two clips, one trim.");
		// The arguments verbatim — the thing a report never keeps.
		expect(turn.wire.calls).toHaveLength(1);
		expect(turn.wire.calls[0]).toMatchObject({
			name: "addTrim",
			mutating: true,
			argsJson: '{"startSec":10,"endSec":12.5,"reason":"silence"}',
		});
		// Both documents, so the edit can be re-derived offline.
		expect((turn.documents.before as AxcutDocument).timeline.clips).toHaveLength(2);
		expect((turn.documents.after as AxcutDocument).timeline.trimRanges).toHaveLength(1);
		expect(turn.conversation.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
		expect(turn.scores.checks.length).toBeGreaterThan(0);
		expect(turn.truncated).toEqual([]);
	});

	it("puts the system message beside the file, once, named by its sha", () => {
		const root = scratch();
		const options = { root, label: "baseline", prompt: scenario.prompt, allowAgentEdits: true };
		const first = persistRepetition({ ...options, result: repetition({ rep: 0 }) });
		persistRepetition({ ...options, result: repetition({ rep: 1 }) });

		expect(readFileSync(first.systemFile, "utf8")).toBe(SYSTEM_TEXT);
		const files = readdirSync(`${root}/baseline/describe-project`).sort();
		expect(files.filter((name) => name.startsWith("system-"))).toHaveLength(1);
		expect(files.filter((name) => name.startsWith("rep-"))).toEqual(["rep-0.json", "rep-1.json"]);
		// The reference is verifiable: the name carries the sha the report prints.
		const turn = readTurn(`${root}/baseline/describe-project/rep-0.json`);
		expect(files).toContain(turn.wire.systemFile);
		expect(turn.wire.systemFile).toContain(turn.wire.systemSha256.slice(0, 12));
	});

	it("bounds a tool result instead of writing a hundred kilobytes of it", () => {
		const huge = `{"segments":"${"x".repeat(MAX_FIELD_CHARS * 2)}"}`;
		const turn = buildPersistedTurn({
			label: "baseline",
			result: repetition({ resultJson: huge }),
			prompt: scenario.prompt,
			allowAgentEdits: true,
		});
		const kept = turn.wire.calls[0].resultJson ?? "";
		expect(kept.length).toBeLessThan(huge.length);
		expect(kept.endsWith("…[tronqué]")).toBe(true);
		// Named, so a reader is never silently looking at a fragment.
		expect(turn.truncated.join(" ")).toContain("wire.calls[0].resultJson");
	});

	it("caps a transcript that is input rather than evidence", () => {
		const turn = buildPersistedTurn({
			label: "baseline",
			result: repetition({ document: longTranscript({ segments: 900 }) }),
			prompt: scenario.prompt,
			allowAgentEdits: true,
		});
		const before = turn.documents.before as AxcutDocument;
		expect(before.transcripts[0].segments).toHaveLength(MAX_SEGMENTS);
		expect(turn.truncated.join(" ")).toContain("before.transcripts[0].segments");
		// Everything an editorial oracle reads is untouched.
		expect(before.timeline.clips).toHaveLength(1);
	});

	it("refuses to write a turn carrying the API key", () => {
		const saved = process.env[ENV_KEYS.apiKey];
		process.env[ENV_KEYS.apiKey] = "wb-not-a-real-key-0123456789";
		const root = scratch();
		try {
			expect(() =>
				persistRepetition({
					root,
					label: "baseline",
					// A model that quotes back a header it was shown is not a
					// hypothesis: the whole point of the barrier is that nobody reads
					// these files before they land.
					result: repetition({ answer: "I saw wb-not-a-real-key-0123456789 in the env." }),
					prompt: scenario.prompt,
					allowAgentEdits: true,
				}),
			).toThrow(/contient la clé API/);
			expect(readdirSync(root)).toEqual([]);
		} finally {
			if (saved === undefined) delete process.env[ENV_KEYS.apiKey];
			else process.env[ENV_KEYS.apiKey] = saved;
		}
	});
});
