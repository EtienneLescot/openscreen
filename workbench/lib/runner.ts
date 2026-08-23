// ponytail: turns a Scenario (data) into a scored repetition (evidence).
//
// The same function serves both executors: offline it drives the scripted model
// server, online it drives a transparent proxy in front of the real provider.
// Nothing about scoring differs between the two — only the number of
// repetitions and how the results are read.
//
// The app ALWAYS talks to 127.0.0.1, live included. That is not a convenience:
// the requests the app sends are the DSL axis's only evidence, and pointing the
// app straight at the provider leaves `wire.calls` empty — at which point a
// check like "did it call anything mutating?" passes because nothing was
// observed, not because nothing happened. That false green cost one live run to
// find; the proxy is now the only live path.

import type { LlmConfigStore } from "../../electron/ai-edition/llm-config-store";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { startRecorder } from "./cassette";
import { requireLiveEnv } from "./env";
import {
	DEFAULT_TURN_TIMEOUT_MS,
	fakeCursorReader,
	runScenario,
	type ScenarioRun,
} from "./harness";
import type { ModelServerHandle } from "./model-server";
import { buildEvalContext } from "./oracles";
import type { EvalContext, Scenario } from "./scenario";
import { type ScoredRun, scoreRun } from "./score";

export interface RepetitionResult {
	scenarioId: string;
	rep: number;
	projectId: string;
	scored: ScoredRun;
	context: EvalContext;
	run: ScenarioRun;
}

export interface RunRepetitionOptions {
	scenario: Scenario;
	rep?: number;
	/** Live/replay endpoint. Omit to use the scenario's `demoScript` offline. */
	endpoint?: ModelServerHandle;
	store?: LlmConfigStore;
	timeoutMs?: number;
}

/**
 * ponytail: the live store. The key is read from process.env by `env.ts`, put
 * straight into the object `runChat` consumes, and never logged, never written,
 * never inspected. `getConfig`/`getCredential` are the only two members
 * `runChat` touches (chat-service.ts:241, :254), so this duck is complete.
 *
 * `baseUrl` is the PROXY's url, never the provider's — see the module comment.
 * The proxy forwards the Authorization header the app set without parsing it.
 */
export function liveStore(options: { baseUrl: string; allowAgentEdits: boolean }): LlmConfigStore {
	const env = requireLiveEnv();
	return {
		getConfig: () => ({
			provider: "openai-compatible",
			model: env.model,
			baseUrl: options.baseUrl,
			allowAgentEdits: options.allowAgentEdits,
		}),
		getCredential: () => ({
			value: env.apiKey,
			entry: { kind: "api-key", apiKey: env.apiKey },
		}),
	} as unknown as LlmConfigStore;
}

/** Opens a proxy to the configured provider. `cassetteFile` records the turn. */
export async function startLiveEndpoint(options: {
	scenario: string;
	cassetteFile?: string;
}): Promise<ModelServerHandle> {
	const env = requireLiveEnv();
	return startRecorder({
		upstream: env.baseUrl,
		file: options.cassetteFile,
		scenario: options.scenario,
		provider: "openai-compatible",
		model: env.model,
	});
}

/** Runs one repetition and scores it. */
export async function runRepetition(options: RunRepetitionOptions): Promise<RepetitionResult> {
	const { scenario } = options;
	const before: AxcutDocument = scenario.document();
	const run = await runScenario({
		label: scenario.id,
		prompt: scenario.prompt,
		document: before,
		allowAgentEdits: scenario.allowAgentEdits ?? true,
		// `defineScenario` refuses both at once, so this is a choice between two
		// exclusive shapes, never a precedence rule.
		cursor:
			scenario.cursorReader?.() ??
			(scenario.cursorTelemetry ? fakeCursorReader(scenario.cursorTelemetry()) : undefined),
		script: options.endpoint ? undefined : scenario.demoScript,
		endpoint: options.endpoint,
		store: options.store,
		timeoutMs: options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
	});
	// `runChat` only returns a document when a tool mutated one
	// (chat-service.ts:386) — absence therefore means "nothing changed", which
	// is exactly what the consent scenario has to be able to observe.
	const mutated = run.document !== undefined;
	const context = buildEvalContext({
		answer: run.answer,
		wire: run.wire,
		before,
		after: run.document ?? before,
		mutated,
		allowAgentEdits: scenario.allowAgentEdits !== false,
		run: { ok: run.ok, error: run.error, ms: run.ms },
	});
	return {
		scenarioId: scenario.id,
		rep: options.rep ?? 0,
		projectId: run.projectId,
		scored: scoreRun(scenario, context),
		context,
		run,
	};
}

export interface ScenarioRepsOptions {
	scenario: Scenario;
	reps: number;
	/** Live mode: open a proxy per repetition and source the key from env. */
	live?: { record?: (rep: number) => string | undefined };
	timeoutMs?: number;
	maxRetries?: number;
	onRepetition?: (result: RepetitionResult) => void;
}

/**
 * Runs a scenario `reps` times, sequentially.
 *
 * A repetition that failed for OUR reasons — a timeout or a transport error —
 * is replayed rather than scored: counting infrastructure noise against the
 * model would make every rate a function of the network. `maxRetries` bounds
 * that so a genuinely broken endpoint cannot loop forever.
 */
export async function runScenarioReps(
	options: ScenarioRepsOptions,
): Promise<{ results: RepetitionResult[]; discarded: RepetitionResult[] }> {
	const results: RepetitionResult[] = [];
	const discarded: RepetitionResult[] = [];
	const maxRetries = options.maxRetries ?? 2;
	const allowAgentEdits = options.scenario.allowAgentEdits ?? true;

	for (let rep = 0; rep < options.reps; rep += 1) {
		let attempt = 0;
		for (;;) {
			const endpoint = options.live
				? await startLiveEndpoint({
						scenario: options.scenario.id,
						cassetteFile: options.live.record?.(rep),
					})
				: undefined;
			let result: RepetitionResult;
			try {
				result = await runRepetition({
					scenario: options.scenario,
					rep,
					endpoint,
					store: endpoint ? liveStore({ baseUrl: endpoint.url, allowAgentEdits }) : undefined,
					timeoutMs: options.timeoutMs,
				});
			} finally {
				endpoint?.close();
			}
			const failureClass = result.scored.failureClass;
			if ((failureClass === "TIMEOUT" || failureClass === "TRANSPORT") && attempt < maxRetries) {
				discarded.push(result);
				attempt += 1;
				continue;
			}
			results.push(result);
			options.onRepetition?.(result);
			break;
		}
	}
	return { results, discarded };
}
