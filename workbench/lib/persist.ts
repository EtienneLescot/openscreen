// ponytail: the raw turns, kept.
//
// A report answers "how often did check X pass". It cannot answer "why did it
// cut there", because everything that would let you SEE the turn is summarised
// out of it: `MAX_EVIDENCE = 3` distinct strings per check (`report.ts:98`),
// each of them whatever prefix the check happened to slice. The 2026-07-31
// baseline is the proof — `dsl.effect.honest` failed on three `addZoom` calls
// and the surviving trace is their call ids. Not the arguments, not the zooms
// that landed, not the document. Nobody can re-derive from that report what the
// model actually did, and a live run costs money and cannot be replayed.
//
// So every repetition writes one self-contained file:
//
//   workbench/runs/<label>/<scenario>/rep-<n>.json
//   workbench/runs/<label>/<scenario>/system-<sha12>.txt
//
// Three rules it lives by:
//   1. NEVER the key. Every write goes through `writeReportFile`, the same
//      barrier the reports use — it REFUSES a payload carrying the key, a
//      Bearer header or an `sk-` token rather than scrubbing it, because a
//      scrubbed file hides that something carried a secret at all.
//   2. Bounded. Tool results are unbounded by nature (`getTranscript` on the
//      900-segment fixture is six figures of characters). Long fields are cut
//      at `MAX_FIELD_CHARS` and every cut is NAMED in `truncated[]`, so a
//      reader is never silently looking at a fragment.
//   3. The system message goes beside the file, not in it — ~8.5 kB identical
//      across every repetition of every scenario. It is written once per sha
//      and referenced by name; the sha is the report's own fingerprint field,
//      so the reference is verifiable rather than decorative.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import { buildEvalContext } from "./oracles";
import { writeReportFile } from "./report";
import type { RepetitionResult } from "./runner";
import type { EvalContext } from "./scenario";
import { allResults } from "./score";
import { systemTextOf, type WireTranscript } from "./wire";

/** Default root. Gitignored — these are run outputs, not sources. */
export const RUNS_DIR = "workbench/runs";

/** Per string field. 20 000 characters is ~6 pages: enough for any argument
 * list and any plausible answer, short of a full transcript dump. */
export const MAX_FIELD_CHARS = 20_000;

/** Transcript segments / words kept in the persisted documents. A fixture with
 * 900 segments would otherwise write 300 kB of unchanged input per repetition. */
export const MAX_SEGMENTS = 400;
export const MAX_WORDS = 4_000;

export interface PersistedCall {
	round: number;
	id: string;
	name: string;
	mutating: boolean;
	argsJson: string;
	resultJson?: string;
	resultOk: boolean;
}

export interface PersistedMessage {
	role: string;
	content: string;
	toolCalls: string[];
}

export interface PersistedTurn {
	/**
	 * Bump when the shape changes: these files outlive the code that wrote them.
	 *
	 * 2 — `scores.checks[].indeterminate`, le troisième verdict. Un fichier de
	 * schéma 1 n'en porte pas, ce qui est exact : à l'époque où il a été écrit
	 * un check ne pouvait que passer ou échouer.
	 */
	schema: 1 | 2;
	label: string;
	scenarioId: string;
	rep: number;
	projectId: string;
	createdAt: string;
	prompt: string;
	allowAgentEdits: boolean;
	run: { ok: boolean; error?: string; ms: number; failureClass: string };
	/** The model's final text, verbatim. */
	answer: string;
	/** True when a tool mutated a document — le fait que `runChat` rapporte, et
	 *  qu'un diff des deux documents ci-dessous ne rend pas. Absent en schéma 1. */
	mutated?: boolean;
	wire: {
		rounds: number;
		systemSha256: string;
		systemChars: number;
		/** Sibling file holding the system message in full. */
		systemFile: string;
		toolsSha256: string;
		toolNames: string[];
		calls: PersistedCall[];
	};
	/**
	 * The conversation as the LAST request carried it — that request holds the
	 * whole history, so this is the full thread without repeating it once per
	 * round. Caveat, and it is a real one: a `task` sub-agent keeps its own
	 * message list, which never appears in the parent request. `wire.calls`
	 * spans every request and does see those.
	 */
	conversation: PersistedMessage[];
	documents: { before: unknown; after: unknown };
	scores: {
		behaviour: number;
		dsl: number;
		gateScore: number;
		passed: boolean;
		checks: Array<{
			id: string;
			ok: boolean;
			expected: boolean;
			/** Absent sur un fichier de schéma 1. */
			indeterminate?: boolean;
			evidence?: string;
		}>;
	};
	/** Every field this file had to shorten, by name. Empty means complete. */
	truncated: string[];
}

function cut(value: string, field: string, truncated: string[], max = MAX_FIELD_CHARS): string {
	if (value.length <= max) return value;
	truncated.push(`${field} (${value.length} → ${max} car.)`);
	return `${value.slice(0, max)}…[tronqué]`;
}

/**
 * Documents go in whole except for the transcript, which is INPUT the model was
 * handed and which no scenario edits. Cutting it keeps a rep file readable
 * while leaving every field an editorial oracle reads — clips, trims, zooms,
 * annotations, `legacyEditor` — untouched and exact.
 */
export function compactDocument(document: unknown, field: string, truncated: string[]): unknown {
	const clone = structuredClone(document) as {
		transcripts?: Array<{ segments?: unknown[]; words?: unknown[] }>;
	};
	for (const [index, transcript] of (clone.transcripts ?? []).entries()) {
		const segments = transcript.segments ?? [];
		if (segments.length > MAX_SEGMENTS) {
			truncated.push(
				`${field}.transcripts[${index}].segments (${segments.length} → ${MAX_SEGMENTS})`,
			);
			transcript.segments = segments.slice(0, MAX_SEGMENTS);
		}
		const words = transcript.words ?? [];
		if (words.length > MAX_WORDS) {
			truncated.push(`${field}.transcripts[${index}].words (${words.length} → ${MAX_WORDS})`);
			transcript.words = words.slice(0, MAX_WORDS);
		}
	}
	return clone;
}

export interface BuildPersistedTurnOptions {
	label: string;
	result: RepetitionResult;
	prompt: string;
	allowAgentEdits: boolean;
	now?: Date;
}

export function buildPersistedTurn(options: BuildPersistedTurnOptions): PersistedTurn {
	const { result } = options;
	const wire = result.run.wire;
	const truncated: string[] = [];
	const lastRequest = result.run.requests.at(-1);
	return {
		schema: 2,
		label: options.label,
		scenarioId: result.scenarioId,
		rep: result.rep,
		projectId: result.projectId,
		createdAt: (options.now ?? new Date()).toISOString(),
		prompt: options.prompt,
		allowAgentEdits: options.allowAgentEdits,
		run: {
			ok: result.run.ok,
			...(result.run.error === undefined
				? {}
				: { error: cut(result.run.error, "run.error", truncated) }),
			ms: result.run.ms,
			failureClass: result.scored.failureClass,
		},
		answer: cut(result.run.answer, "answer", truncated),
		mutated: result.context.mutated,
		wire: {
			rounds: wire.rounds,
			systemSha256: wire.systemSha256,
			systemChars: wire.systemChars,
			systemFile: systemFileName(wire.systemSha256),
			toolsSha256: wire.toolsSha256,
			toolNames: wire.toolNames,
			calls: wire.calls.map((call, index) => ({
				round: call.round,
				id: call.id,
				name: call.name,
				mutating: call.mutating,
				argsJson: cut(call.argsJson, `wire.calls[${index}].argsJson`, truncated),
				...(call.resultJson === undefined
					? {}
					: {
							resultJson: cut(call.resultJson, `wire.calls[${index}].resultJson`, truncated),
						}),
				resultOk: call.resultOk,
			})),
		},
		conversation: (lastRequest?.messages ?? []).map((message, index) => ({
			role: message.role,
			content: cut(message.content, `conversation[${index}].content`, truncated),
			toolCalls: message.toolCalls,
		})),
		documents: {
			before: compactDocument(result.context.before, "before", truncated),
			after: compactDocument(result.context.after, "after", truncated),
		},
		scores: {
			behaviour: result.scored.behaviour.score,
			dsl: result.scored.dsl.score,
			gateScore: result.scored.gateScore,
			passed: result.scored.passed,
			checks: allResults(result.scored).map((check) => ({
				id: check.id,
				ok: check.ok,
				expected: check.expected,
				indeterminate: check.indeterminate,
				...(check.evidence === undefined
					? {}
					: { evidence: cut(check.evidence, `check.${check.id}`, truncated, 2_000) }),
			})),
		},
		truncated,
	};
}

export function systemFileName(systemSha256: string): string {
	return `system-${systemSha256.slice(0, 12)}.txt`;
}

export interface PersistRepetitionOptions extends BuildPersistedTurnOptions {
	/** Root for all runs. `<root>/<label>/<scenario>/rep-<n>.json`. */
	root?: string;
}

/**
 * Writes one repetition to disk and returns the paths.
 *
 * Deliberately NOT part of `runRepetition`: the runner is used by the offline
 * L1 suite too, and a test suite that silently grows a directory of run
 * artefacts is a test suite people start deleting files from. The live CLI
 * calls this; nothing else does.
 */
export function persistRepetition(options: PersistRepetitionOptions): {
	file: string;
	systemFile: string;
} {
	const turn = buildPersistedTurn(options);
	const directory = `${options.root ?? RUNS_DIR}/${options.label}/${turn.scenarioId}`;
	const file = `${directory}/rep-${turn.rep}.json`;
	writeReportFile(file, `${JSON.stringify(turn, null, "\t")}\n`);

	const systemFile = `${directory}/${turn.wire.systemFile}`;
	// Identical for every repetition — write it once and let the rest point at
	// it. `existsSync` rather than a module-level Set so a resumed run, or two
	// labels sharing a directory, still converge on one copy.
	if (!existsSync(systemFile)) {
		writeReportFile(systemFile, systemTextOf(options.result.run.wire));
	}
	return { file, systemFile };
}

// ───────────────────────── relecture ─────────────────────────
//
// ponytail: la relecture existe pour le juge (`lib/judge.ts`). Un run live coûte
// de l'argent et ne se rejoue pas ; faire tourner le juge PENDANT le tour lierait
// chaque changement de rubric à un nouveau run payé. Il tourne donc après, sur ce
// que ce fichier a écrit, autant de fois qu'on veut — c'est la raison d'être de
// `runs/`, enfin utilisée pour autre chose que la lecture humaine.

/**
 * `cut()` inscrit ses coupes sous la forme `<champ> (<n> → <max> car.)`. La
 * comparaison porte donc sur `<champ> ` et pas sur un préfixe : `argsJson` et
 * `argsJsonBrut` commenceraient pareil, et `wire.calls[1]` serait un préfixe de
 * `wire.calls[12]`.
 */
function wasTruncated(turn: PersistedTurn, field: string): boolean {
	return turn.truncated.some((entry) => entry.startsWith(`${field} (`));
}

export function readPersistedTurn(file: string): PersistedTurn {
	const turn = JSON.parse(readFileSync(file, "utf8")) as PersistedTurn;
	if (turn.schema !== 1 && turn.schema !== 2) {
		throw new Error(`${file} : schéma ${String(turn.schema)} inconnu de cette version du banc`);
	}
	return turn;
}

/** Les tours d'un label, groupés par scénario, dans l'ordre des répétitions. */
export function listPersistedTurns(options: {
	label: string;
	root?: string;
	scenarioIds?: string[];
}): Array<{ scenarioId: string; files: string[] }> {
	const directory = `${options.root ?? RUNS_DIR}/${options.label}`;
	if (!existsSync(directory)) return [];
	const wanted = new Set(options.scenarioIds ?? []);
	const out: Array<{ scenarioId: string; files: string[] }> = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (wanted.size > 0 && !wanted.has(entry.name)) continue;
		const files = readdirSync(`${directory}/${entry.name}`)
			.filter((name) => /^rep-\d+\.json$/.test(name))
			.sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
			.map((name) => `${directory}/${entry.name}/${name}`);
		if (files.length > 0) out.push({ scenarioId: entry.name, files });
	}
	return out.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

/**
 * Rebuilds an `EvalContext` from a turn on disk.
 *
 * ponytail: UNE chose ne survit pas au fichier, et la taire la rendrait
 * mesurable par erreur. `systemBlocks` et `toolsSent` ne sont pas persistés —
 * seuls leurs sha, leurs noms et le message système voisin le sont — donc un
 * check qui les lirait verrait des tableaux vides, ce qui ressemble à « rien
 * n'a été envoyé » et n'en est pas. Aucun check jugé ne les touche ; ce
 * commentaire est ce qui doit être lu avant qu'un futur check le fasse.
 *
 * Tout le reste est RELU, jamais redérivé. `mutating` et `mutated` viennent du
 * fichier plutôt que d'un recalcul : ils décrivent ce que ce tour-là a fait, et
 * un recalcul avec le roster d'aujourd'hui rejugerait un tour de l'an dernier
 * avec des outils qu'il n'avait pas.
 */
export function contextFromPersistedTurn(turn: PersistedTurn): EvalContext {
	const wire: WireTranscript = {
		systemBlocks: [],
		systemChars: turn.wire.systemChars,
		systemSha256: turn.wire.systemSha256,
		toolsSent: [],
		toolNames: turn.wire.toolNames,
		toolsSha256: turn.wire.toolsSha256,
		rounds: turn.wire.rounds,
		calls: turn.wire.calls.map((call, index) => {
			let args: unknown;
			try {
				args = JSON.parse(call.argsJson);
			} catch {
				// ponytail: `args: undefined` a un sens PRÉCIS dans `WireCall` — le
				// modèle a émis du JSON invalide, ce qu'un scénario peut provoquer
				// exprès. Mais `cut()` coupe `argsJson` à MAX_FIELD_CHARS, et un JSON
				// tronqué ne parse pas non plus : sans cette branche, notre propre
				// troncature se relisait comme « le modèle n'a pas passé d'arguments ».
				// C'est l'absence traitée comme un non-événement, la faute que ce
				// fichier passe son temps à refuser ailleurs.
				//
				// Il refuse donc plutôt que de rendre un tour amputé. Le champ exact,
				// jamais le préfixe `wire.calls[` : `resultJson` est coupé sous le même
				// préfixe et sa troncature, elle, est sans conséquence ici.
				if (wasTruncated(turn, `wire.calls[${index}].argsJson`)) {
					throw new Error(
						`tour illisible : les arguments de ${call.name} (appel ${call.id}) ont été ` +
							"tronqués à l'écriture, on ne peut pas les relire. Rejugez un run dont " +
							"`truncated[]` est vide, ou remontez MAX_FIELD_CHARS avant de le rejouer.",
					);
				}
				args = undefined;
			}
			return {
				round: call.round,
				id: call.id,
				name: call.name,
				argsJson: call.argsJson,
				args,
				mutating: call.mutating,
				...(call.resultJson === undefined ? {} : { resultJson: call.resultJson }),
				resultOk: call.resultOk,
			};
		}),
	};
	return buildEvalContext({
		answer: turn.answer,
		wire,
		before: documentSchema.parse(turn.documents.before),
		after: documentSchema.parse(turn.documents.after),
		// `runChat` ne rend un document que lorsqu'un outil a muté quelque chose,
		// donc `mutated` est un fait sur le TOUR et pas un diff de documents : un
		// `setZoom` idempotent mute sans rien changer, et comparer les deux
		// documents effacerait la distinction que `consent` mesure.
		mutated: turn.mutated ?? turn.wire.calls.some((call) => call.mutating),
		// ponytail: relu du fichier, jamais redérivé — c'est le réglage sous lequel
		// CE tour-là a tourné. Le déduire de la définition du scénario
		// d'aujourd'hui rejugerait un tour d'hier sous un réglage qu'il n'avait
		// pas, ce qui est la même faute que recalculer `mutating`.
		allowAgentEdits: turn.allowAgentEdits,
		run: {
			ok: turn.run.ok,
			...(turn.run.error === undefined ? {} : { error: turn.run.error }),
			ms: turn.run.ms,
		},
	});
}
