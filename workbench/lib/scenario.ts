// ponytail: a scenario is DATA, not a test. It states a document, a prompt, and
// two independent lists of checks; the runner decides how many times to run it
// and against which model. That separation is what lets the same scenario run
// offline against a script (L1, deterministic, `expect`-able) and online against
// the real provider (L2, stochastic, scored as a rate).

import type { CursorTelemetryReader } from "../../electron/ai-edition/deep-agent/service";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import type { CursorTrackSample } from "../../src/lib/ai-edition/timeline/cursor-track";
import type {
	CutBalance,
	EditScope,
	FamilyDelta,
	Fragment,
	SpeechDamage,
	TrimMargin,
	ZoomHygieneOptions,
	ZoomIssue,
} from "./editorial";
import type { ScriptedTurn } from "./model-server";
import type {
	CoverageOptions,
	CutPrecision,
	Pause,
	PauseOptions,
	ScopeBreach,
	ScopeRequest,
	SilenceCoverage,
	SpeechDamageDetail,
	TruthZone,
	ZoomPlacement,
	ZoomPlacementOptions,
} from "./quality";
import type { WireCall, WireTranscript } from "./wire";

export type Verdict = { ok: true } | { ok: false; evidence: string };

export const pass = (): Verdict => ({ ok: true });
export const fail = (evidence: string): Verdict => ({ ok: false, evidence });

/** How a failed turn should be attributed. `TIMEOUT` and `TRANSPORT` are OUR
 * fault: the runner replays the repetition instead of scoring it. */
export type FailureClass = "NONE" | "INVALID_DSL" | "EMPTY_TEXT" | "TIMEOUT" | "TRANSPORT";

export interface EvalContext {
	/** The model's final text. Empty string on a failed turn. */
	answer: string;
	/** The wire truth for the DSL axis. Never the sink. */
	wire: WireTranscript;
	before: AxcutDocument;
	/** The document after the turn — equal to `before` when nothing mutated. */
	after: AxcutDocument;
	/** True when `runChat` returned a document, i.e. a tool mutated something. */
	mutated: boolean;
	run: { ok: boolean; error?: string; ms: number };

	/** Every wire call to `name`, in emission order. */
	calls(name: string): WireCall[];
	/** Calls to the 8 filesystem/todo/sub-agent names that must no longer be on
	 * the surface at all — see `PHANTOM_TOOLS`. The D1 tell. */
	callsToPhantomTools(): WireCall[];
	/** Index of the first call to `name` in the wire order; -1 when absent. */
	firstIndexOf(name: string): number;
	/** Index of the first mutating call; `Infinity` when the turn read only. */
	firstMutatingIndex(): number;
	/** Regions stored in the document that playback will never emit. */
	unplayableRegions(): Array<{ kind: string; id: string }>;
	/** True when a mutating call's own result matches what landed in `after`. */
	diffMatches(call: WireCall): boolean;
	/** Duration of `assetId` (default: the primary asset), 0 when unknown. */
	assetDuration(assetId?: string): number;
	/** Total playing time once clips and trims are applied. */
	compressedDurationSec(): number;
	classifyFailure(): FailureClass;

	// ─── editorial quality (lib/editorial.ts) ────────────────────────────────
	// These read `before` AND `after`: they judge the EDIT, not the document.
	// Deterministic on purpose — an LLM judge would answer the same questions
	// and answer them differently tomorrow.

	/** Seconds of SPEECH the turn removed. Must be 0 for "cut the silences". */
	speechDamage(): SpeechDamage;
	/** Sub-half-second islands of material the turn left between two cuts. */
	orphanFragments(maxSec?: number): Fragment[];
	/** Per added trim: how much of the silence it left breathing on each edge. */
	trimMargins(): TrimMargin[];
	/** Over-cut / under-cut against the silences that were really there. */
	cutBalance(): CutBalance;
	/** Overlaps, aberrant durations, and placement against declared interest. */
	zoomIssues(options?: ZoomHygieneOptions): ZoomIssue[];
	/** Families the request did not license but the document changed anyway. */
	outOfScopeEdits(scope: EditScope): FamilyDelta[];
	/** Mutating calls outside the tools the request licenses. */
	outOfScopeCalls(allowedTools: string[]): WireCall[];

	// ─── editorial QUALITY (lib/quality.ts) ──────────────────────────────────
	// The same family of questions, asked of material whose silences are not
	// round numbers somebody typed. Everything here is keyed on `pauses()` —
	// gaps in the speech above a floor, with the head and tail of the recording
	// held apart — because on a real transcript the un-floored complement of the
	// words is 120 inter-word gaps and no oracle built on it says anything.

	/** The silences, as an editor would list them. Read from `before`. */
	pauses(options?: PauseOptions): Pause[];
	/** `speechDamage`, plus the WORDS the cut ran through. */
	speechDamageDetail(): SpeechDamageDetail;
	/** Per added trim, per edge: distance to the pause boundary, and the bite. */
	cutPrecision(options?: PauseOptions): CutPrecision[];
	/** Which silences went, which stayed — interior and edge counted apart. */
	silenceCoverage(options?: CoverageOptions): SilenceCoverage;
	/**
	 * Zoom precision AND recall against the zones the SCENARIO declares.
	 *
	 * The zones are an argument, never a property of the document: they are the
	 * ground truth of what the user was doing, they live on the assertion side,
	 * and a scenario that let them reach the model would be grading a dictation.
	 */
	zoomPlacement(zones: TruthZone[], options?: ZoomPlacementOptions): ZoomPlacement;
	/** Out-of-scope document changes and out-of-scope mutating calls, together. */
	scopeBreaches(scope: ScopeRequest): ScopeBreach[];
}

export interface Check {
	id: string;
	weight: number;
	check: (context: EvalContext) => Verdict;
}

export interface ExpectedFailure {
	/** Defect tag: "D1", "DSL-3", … */
	defect: string;
	/** ISO date the failure was accepted. Entries older than 90 days are
	 * reported for review, so the baseline cannot quietly become wallpaper. */
	since: string;
	note?: string;
}

export interface Scenario {
	id: string;
	title: string;
	tags: string[];
	document: () => AxcutDocument;
	prompt: string;
	/** Defaults to true. `false` exercises D3 through `runChat`. */
	allowAgentEdits?: boolean;
	/**
	 * Recorded pointer telemetry for the fixture, keyed by assetId. Declared next
	 * to the document because it is part of the same material: a recording HAS a
	 * sidecar or it does not, and which one is exactly what D-TELEM is about.
	 *
	 * Omit it and the turn runs with no reader at all — the agent then answers
	 * "unavailable", which is the honest shape for a runtime that cannot look and
	 * is worth measuring on its own.
	 */
	cursorTelemetry?: () => Record<string, CursorTrackSample[]>;
	/**
	 * A telemetry reader built by the scenario itself — the door for fixtures
	 * whose samples come from a FILE rather than from a generator
	 * (`realScreencastCursorReader`). Mutually exclusive with `cursorTelemetry`:
	 * two sources of pointer data for one turn means one of them is silently
	 * ignored, and which one would depend on the runner's order.
	 */
	cursorReader?: () => CursorTelemetryReader;
	/** Axis (a): does the agent behave — refuse, ask, describe truthfully? */
	behaviour: Check[];
	/** Axis (b): is the emitted DSL valid, well targeted, and honest? */
	dsl: Check[];
	/** L2 repetitions. Defaults to the CLI's `--reps`. */
	reps?: number;
	/** Pass threshold on `min(behaviour, dsl)` — the conjoint gate. */
	gate: number;
	/** Known-broken checks, with the defect they belong to. The ratchet fails
	 * BOTH ways: a new failure is a regression, and a listed check that starts
	 * passing is a fix that must be removed from the list. */
	expectedFailures?: Record<string, ExpectedFailure>;
	/**
	 * OFFLINE ONLY. A scripted model turn sequence that lets L1 exercise this
	 * scenario end to end with no network and no LLM. It is never used on the
	 * live path — it proves the machinery runs, it does not stand in for a
	 * model's behaviour.
	 */
	demoScript?: ScriptedTurn[];
}

/** Validates a scenario at module load, so a malformed one fails at import
 * rather than halfway through a paid live run. */
export function defineScenario(scenario: Scenario): Scenario {
	if (!scenario.id.trim()) throw new Error("scenario.id is required");
	if (!/^[a-z0-9][a-z0-9-]*$/.test(scenario.id)) {
		throw new Error(`scenario id must be kebab-case: ${scenario.id}`);
	}
	if (!scenario.prompt.trim()) throw new Error(`${scenario.id}: prompt is required`);
	if (!(scenario.gate >= 0 && scenario.gate <= 1)) {
		throw new Error(`${scenario.id}: gate must be within [0,1], got ${scenario.gate}`);
	}
	if (scenario.reps !== undefined && (!Number.isInteger(scenario.reps) || scenario.reps < 1)) {
		throw new Error(`${scenario.id}: reps must be a positive integer`);
	}
	if (scenario.cursorTelemetry && scenario.cursorReader) {
		throw new Error(
			`${scenario.id}: cursorTelemetry and cursorReader are mutually exclusive — ` +
				"one of the two would be silently dropped",
		);
	}
	const all = [...scenario.behaviour, ...scenario.dsl];
	if (all.length === 0) throw new Error(`${scenario.id}: no checks — nothing would be measured`);
	const ids = new Set<string>();
	for (const check of all) {
		if (!check.id.trim()) throw new Error(`${scenario.id}: a check has an empty id`);
		if (ids.has(check.id)) throw new Error(`${scenario.id}: duplicate check id ${check.id}`);
		ids.add(check.id);
		if (!(check.weight > 0)) {
			throw new Error(`${scenario.id}: check ${check.id} has a non-positive weight`);
		}
	}
	for (const key of Object.keys(scenario.expectedFailures ?? {})) {
		if (!ids.has(key)) {
			throw new Error(`${scenario.id}: expectedFailures names an unknown check ${key}`);
		}
	}
	return scenario;
}
