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
	contextFromPersistedTurn,
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
		// 2 depuis l'arrivée du troisième verdict : `scores.checks[].indeterminate`
		// et `mutated`. Un fichier de schéma 1 reste lisible et n'en porte aucun,
		// ce qui est exact — à l'époque un check ne pouvait que passer ou échouer.
		expect(turn.schema).toBe(2);
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

	// ─── relecture ───────────────────────────────────────────────────────────
	//
	// La relecture est le chemin du juge (`cli.ts judge`). Ce qu'elle rend n'est
	// pas seulement « ce qui a été écrit » : c'est ce sur quoi un verdict sera
	// rendu, plus tard, par quelqu'un qui n'a pas vu le tour.

	/** Le tour de référence, avec l'appel 0 réécrit pour le cas à éprouver. */
	function turnWithCall(overrides: { argsJson: string; truncated?: string[] }): PersistedTurn {
		const turn = buildPersistedTurn({
			label: "baseline",
			result: repetition(),
			prompt: scenario.prompt,
			allowAgentEdits: true,
		});
		turn.wire.calls[0].argsJson = overrides.argsJson;
		turn.truncated = overrides.truncated ?? [];
		return turn;
	}

	it("refuses to rebuild a turn whose call arguments were truncated", () => {
		// ponytail: `cut()` coupe `argsJson` à MAX_FIELD_CHARS, et un JSON coupé ne
		// parse pas. Le `catch` rendait alors `args: undefined`, qui dans `WireCall`
		// veut dire « le modèle a émis du JSON invalide ». Notre propre troncature
		// se relisait donc comme un fait sur le modèle — et un check jugé aurait
		// pesé « aucun argument » là où la vérité est « arguments coupés ».
		const turn = turnWithCall({
			argsJson: `{"reason":"${"x".repeat(40)}…[tronqué]`,
			truncated: ["wire.calls[0].argsJson (41234 → 20000 car.)"],
		});
		expect(() => contextFromPersistedTurn(turn)).toThrow(/tronqués à l'écriture/);
	});

	it("still lets the model's OWN invalid JSON through, which is a real verdict", () => {
		// L'autre sens, et il compte : `args: undefined` reste la bonne lecture
		// quand c'est le modèle qui a mal écrit. Refuser les deux cas ferait
		// disparaître un défaut que l'axe (b) existe pour attraper.
		const turn = turnWithCall({ argsJson: '{"startSec": 3,,}', truncated: [] });
		const context = contextFromPersistedTurn(turn);
		expect(context.wire.calls[0].args).toBeUndefined();
		expect(context.wire.calls[0].argsJson).toBe('{"startSec": 3,,}');
	});

	it("does not mistake a truncated resultJson for truncated arguments", () => {
		// Le piège du préfixe : les deux coupes s'inscrivent sous `wire.calls[0].`,
		// et un résultat coupé n'empêche personne de relire les arguments.
		const turn = turnWithCall({
			argsJson: '{"startSec": 3,,}',
			truncated: ["wire.calls[0].resultJson (99999 → 20000 car.)"],
		});
		expect(() => contextFromPersistedTurn(turn)).not.toThrow();
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
