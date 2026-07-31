// ponytail: one turn of the real agent, with no Electron anywhere.
//
// The whole chat path is already Node-pure: the only `import { … } from
// "electron"` under `electron/ai-edition/` is `llm-config-store.ts:13`, and
// `chat-service.ts:32-33` pulls both `DocumentService` and `LlmConfigStore` as
// `import type`, which TypeScript erases. So a duck-typed store is enough —
// `runChat` only ever calls `getConfig()` (:241) and `getCredential()` (:254) —
// and no credential store is ever loaded, let alone read.

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { CursorTelemetryLoad } from "../../electron/ai-edition/agent-tools";
import { createSession, runChat } from "../../electron/ai-edition/chat-service";
import type { CursorTelemetryReader } from "../../electron/ai-edition/deep-agent/service";
import type { LlmConfigStore } from "../../electron/ai-edition/llm-config-store";
import { readCursorSidecar } from "../../electron/media/cursorSidecar";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import type { CursorTrackSample } from "../../src/lib/ai-edition/timeline/cursor-track";
import { type ModelServerHandle, type ScriptedTurn, startScriptedModel } from "./model-server";
import { type WireTranscript, wireFromRequests } from "./wire";

/**
 * ponytail: 300s, and the number is measured rather than picked. At 120s the wizard
 * scenario on a real 66s screencast failed 3 runs out of 5 — and the two that passed
 * took 117.0s and 112.5s. The cutoff sat 3 to 7 seconds above a turn's normal
 * duration, so a slow moment at the provider decided the outcome, and the failures
 * read as "the model refused to act" in every report.
 *
 * The cost of a generous timeout is waiting; the cost of a tight one is a benchmark
 * that measures its own impatience and blames the model for it. Note what actually
 * takes the two minutes: that turn issues 19 tool calls in series, each a round trip.
 * A turn is slow because of its SHAPE, not its payload — the whole context is ~26k
 * characters, which is nothing.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 300_000;

export interface SinkEvent {
	kind: "text" | "thinking" | "toolStart" | "toolEnd" | "error";
	name?: string;
	args?: unknown;
	ok?: boolean;
	summary?: string;
	text?: string;
}

export interface ScenarioRun {
	ok: boolean;
	error?: string;
	answer: string;
	document?: AxcutDocument;
	/** Minted per run — see `runScenario`. */
	projectId: string;
	/**
	 * INFORMATIVE ONLY, still. The sink no longer duplicates calls and no longer
	 * fabricates `ok: true` — `deep-agent/service.ts` emits one pair per call
	 * with the executor's real verdict — but it carries no call id and does not
	 * interleave on parallel batches, so pairing by NAME stays ambiguous the
	 * moment a tool runs twice in a round. Score the DSL on `wire`, never on
	 * this. (`l1/failure-taxonomy.wb.ts` scores the sink deliberately, because
	 * the honesty of the sink is itself under test there.)
	 */
	events: SinkEvent[];
	/** The requests the app actually sent — the evidence base. */
	wire: WireTranscript;
	requests: ModelServerHandle["requests"];
	ms: number;
}

/** ponytail: ids are `${prefix}_${crypto.randomUUID()}` — rewrite them to
 * `${prefix}#${n}` in first-appearance order so a golden file is stable. */
export function normalizeIds(value: unknown): unknown {
	const seen = new Map<string, string>();
	const counters = new Map<string, number>();
	const json = JSON.stringify(value, (_k, v) => {
		if (typeof v !== "string") return v;
		return v.replace(
			/\b([a-z]+)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
			(match, prefix: string) => {
				const hit = seen.get(match);
				if (hit) return hit;
				const n = (counters.get(prefix) ?? 0) + 1;
				counters.set(prefix, n);
				const stable = `${prefix}#${n}`;
				seen.set(match, stable);
				return stable;
			},
		);
	});
	return JSON.parse(json);
}

function timeoutAfter(ms: number): { promise: Promise<never>; cancel: () => void } {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<never>((_resolve, reject) => {
		handle = setTimeout(() => reject(new Error(`workbench timeout after ${ms} ms`)), ms);
		handle.unref?.();
	});
	return {
		promise,
		cancel: () => {
			if (handle) clearTimeout(handle);
		},
	};
}

export interface RunScenarioOptions {
	prompt: string;
	document: AxcutDocument;
	/** Prefix for the minted project id — usually the scenario id. */
	label?: string;
	script?: ScriptedTurn[];
	/** Pre-started endpoint (replay, recorder, or live). Wins over `script`, and
	 * is NOT closed by the harness — its owner closes it. */
	endpoint?: ModelServerHandle;
	/** Duck-typed `LlmConfigStore` override — the live path supplies one whose
	 * credential comes from `env.ts`. Offline runs leave it unset. */
	store?: LlmConfigStore;
	allowAgentEdits?: boolean;
	/** A cursor-telemetry reader for the turn. Omitted, the agent answers
	 *  "unavailable" — which is the honest thing for a runtime with no reader, and
	 *  is itself worth measuring. */
	cursor?: CursorTelemetryReader;
	timeoutMs?: number;
}

/**
 * ponytail: a reader over an in-memory sample list, so a scenario can measure
 * the telemetry path without a disk, a recording, or Electron.
 *
 * It answers `no-sidecar` for assets the map does not mention, which is the same
 * shape production returns for imported footage — the point being that "this
 * asset has none" and "I could not look" have to stay distinguishable all the
 * way down to the fixture, not just in the tool.
 */
export function fakeCursorReader(
	samplesByAssetId: Record<string, CursorTrackSample[]>,
): CursorTelemetryReader {
	return {
		probe: async ({ assetId }) => samplesByAssetId[assetId] !== undefined,
		read: async ({ assetId }) => {
			const samples = samplesByAssetId[assetId];
			return samples ? { status: "ok", assetId, samples } : { status: "no-sidecar", assetId };
		},
	};
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * The REAL reader: a `.cursor.json` sidecar on disk, parsed by the production
 * parser (`electron/media/cursorSidecar.ts`) and nothing else. This is what
 * turns `getCursorTrack` from `available:false, reason:"unavailable"` into a
 * trajectory, and it is the only way a scenario can ask whether the model uses
 * one.
 *
 * ponytail: keyed by **assetId**, not by the document's `originalPath`, and the
 * `originalPath` the reader is handed is deliberately ignored. Production
 * cannot do that — it must resolve whatever path the document holds, which is
 * why `handlers.ts` runs it through `resolveApprovedVideoPath` first. The
 * workbench has no allow-list and no media on disk, so an explicit map is both
 * simpler and stricter: a document can name any path it likes and this reader
 * will still only ever open a file the caller named.
 *
 * The three states stay apart, which is the whole reason this interface exists:
 *
 * - asset not in the map → `no-sidecar`, a fact about the project;
 * - in the map, no file on disk → `no-sidecar` as well (we looked);
 * - in the map, file present but unreadable → `unavailable`, a fact about US.
 *
 * That last branch needs the extra `fileExists`: `readCursorSidecar` flattens
 * "absent" and "malformed" into the same `found: false`, which is right for a
 * renderer drawing an overlay and wrong here — reporting a corrupt sidecar as
 * "this recording has no pointer data" is exactly the swap of blindness for
 * fact the whole telemetry path was rebuilt to stop.
 */
export function sidecarCursorReader(
	videoPathByAssetId: Record<string, string>,
): Required<CursorTelemetryReader> {
	const load = async (assetId: string): Promise<CursorTelemetryLoad> => {
		const videoPath = videoPathByAssetId[assetId];
		if (!videoPath) return { status: "no-sidecar", assetId };
		// The sidecar convention is `<video>.cursor.json`; the video itself is
		// never opened, and in this bench it is not even on disk.
		const sidecar = await readCursorSidecar(videoPath, {});
		if (sidecar.found) return { status: "ok", assetId, samples: sidecar.data.samples };
		if (await fileExists(`${videoPath}.cursor.json`)) {
			return {
				status: "unavailable",
				assetId,
				note: "A cursor sidecar is present next to this asset but could not be parsed.",
			};
		}
		return { status: "no-sidecar", assetId };
	};
	return {
		// ponytail: a full parse where production does an `access` check. On the
		// bench's one 272 kB fixture that is under a millisecond, and it buys the
		// property that probe and read can never disagree.
		probe: async ({ assetId }) => (await load(assetId)).status === "ok",
		read: async ({ assetId }) => load(assetId),
	};
}

/** Offline store: a placeholder key for an endpoint that never authenticates.
 * `runChat` aborts on an empty key regardless of the provider's auth kind
 * (chat-service.ts:256-261), so something non-empty has to be passed. */
export function offlineStore(options: {
	baseUrl: string;
	allowAgentEdits: boolean;
}): LlmConfigStore {
	return {
		getConfig: () => ({
			provider: "openai-compatible",
			model: "workbench-scripted",
			baseUrl: options.baseUrl,
			allowAgentEdits: options.allowAgentEdits,
		}),
		getCredential: () => ({
			value: "workbench-replay-no-auth",
			entry: { kind: "api-key", apiKey: "workbench-replay-no-auth" },
		}),
	} as unknown as LlmConfigStore;
}

export async function runScenario(options: RunScenarioOptions): Promise<ScenarioRun> {
	// ponytail: `sessionsByProject` (chat-service.ts:36) and
	// `messageCheckpointsBySession` (:48) are module-level Maps with no exported
	// reset. Two runs sharing a projectId contaminate each other, and with
	// `isolate: false` that contamination is invisible in a single-file run —
	// the worst kind of flake. Minting the id here removes the footgun rather
	// than documenting it.
	const projectId = `${options.label ?? "wb"}_${randomUUID().slice(0, 8)}`;
	const ownsEndpoint = !options.endpoint;
	const model = options.endpoint ?? (await startScriptedModel(options.script ?? []));
	const store =
		options.store ??
		offlineStore({ baseUrl: model.url, allowAgentEdits: options.allowAgentEdits ?? true });

	const events: SinkEvent[] = [];
	const session = createSession(projectId);
	const t0 = performance.now();
	// ponytail: there is NO AbortSignal, no cancel and no timeout anywhere in
	// chat-service.ts or deep-agent/service.ts, and the agent runs at
	// recursionLimit 1000 (it was deepagents' 1e4). A looping model would hang
	// the suite forever, so the only stop is ours. The turn keeps running in the
	// background after a timeout — we stop waiting on it, and the endpoint is
	// closed underneath it.
	const guard = timeoutAfter(options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
	let result: Awaited<ReturnType<typeof runChat>>;
	try {
		result = await Promise.race([
			runChat(
				projectId,
				session.id,
				options.prompt,
				store,
				options.document,
				{
					text: (d: string) => events.push({ kind: "text", text: d }),
					thinking: (d: string) => events.push({ kind: "thinking", text: d }),
					toolStart: (name: string, args: unknown) =>
						events.push({ kind: "toolStart", name, args }),
					toolEnd: (name: string, ok: boolean, summary?: string) =>
						events.push({ kind: "toolEnd", name, ok, summary }),
					error: (m: string) => events.push({ kind: "error", text: m }),
				},
				{ cursor: options.cursor },
			),
			guard.promise,
		]);
	} catch (error) {
		result = { success: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		guard.cancel();
		if (ownsEndpoint) model.close();
	}
	const ms = performance.now() - t0;

	return {
		ok: result.success,
		error: result.success ? undefined : result.error,
		answer: result.success ? (result.assistantMessage?.content ?? "") : "",
		document: result.success ? (result.document as AxcutDocument | undefined) : undefined,
		projectId,
		events,
		wire: wireFromRequests(model.requests),
		requests: model.requests,
		ms,
	};
}
