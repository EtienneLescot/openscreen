// ponytail: the DSL axis is scored HERE and nowhere else — never on the chat
// sink.
//
// The sink used to be disqualified on three counts: every mutating tool was
// announced twice (once by the tool body with the real args, once by the
// streamEvents loop with them re-wrapped as `{input: "<json string>"}`), the
// second emission hard-coded `ok: true` so a refused write and a `getTranscript`
// that returned `{"error":"No transcript…"}` both read as successes, and read
// tools had no emission of their own at all. Two of those are fixed:
// `deep-agent/service.ts` now emits exactly ONE start/end pair per call, from
// the tool body, carrying the executor's real verdict.
//
// The third reason stands and is enough on its own: on a parallel batch the
// start and end families do not interleave, and the sink carries no call id, so
// pairing a start with an end by tool NAME is ambiguous the moment a tool is
// called twice in one round. And a `resultJson` is still the TOOL's word about
// itself. The requests the app actually sent to the provider carry, verbatim:
// the system message the model received, the full tool surface, each
// `tool_calls[].function.arguments` string, and each `role:"tool"` result keyed
// by `tool_call_id`. That is the whole evidence base.

import { createHash } from "node:crypto";
import { isMutatingTool } from "../../electron/ai-edition/agent-tools";
import type { CapturedRequest } from "./model-server";

export interface WireCall {
	/** 0-based index of the model response that emitted this call. */
	round: number;
	/** `tool_call_id` — the ONLY sound way to pair a call with its result. */
	id: string;
	name: string;
	/** Verbatim, unparsed. A model can and does emit malformed JSON. */
	argsJson: string;
	/** `JSON.parse(argsJson)`, or `undefined` when it does not parse. */
	args: unknown;
	mutating: boolean;
	/** Content of the matching `role:"tool"` message, when one came back. */
	resultJson?: string;
	/** False when the result is missing, unparseable, or carries an `error` key. */
	resultOk: boolean;
}

export interface WireTool {
	name: string;
	description: string;
	parameters: unknown;
}

export interface WireTranscript {
	/** System content exactly as sent: a string, or the array of blocks. */
	systemBlocks: unknown[];
	/** Our SYSTEM_PROMPT and nothing else since `createAgent` replaced
	 * `createDeepAgent` — it was ~8742 for a 2968-character constant. */
	systemChars: number;
	systemSha256: string;
	toolsSent: WireTool[];
	/** 18 today: exactly the OpenScreen tools, no injected surface. */
	toolNames: string[];
	toolsSha256: string;
	calls: WireCall[];
	/** Number of model responses observed (one per captured request). */
	rounds: number;
}

interface RawMessage {
	role?: unknown;
	content?: unknown;
	tool_call_id?: unknown;
	tool_calls?: Array<{
		id?: unknown;
		function?: { name?: unknown; arguments?: unknown };
	}>;
}

interface RawBody {
	messages?: RawMessage[];
	tools?: Array<{ function?: { name?: unknown; description?: unknown; parameters?: unknown } }>;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function bodyOf(request: CapturedRequest): RawBody {
	return (request.raw ?? {}) as RawBody;
}

/** System content is a string on some providers and an array of blocks on
 * others; normalize to an array so callers never branch. */
function systemBlocksOf(content: unknown): unknown[] {
	if (content == null) return [];
	if (Array.isArray(content)) return content;
	return [content];
}

function textOfBlocks(blocks: unknown[]): string {
	return blocks
		.map((block) => {
			if (typeof block === "string") return block;
			if (block && typeof block === "object" && "text" in block) {
				const text = (block as { text?: unknown }).text;
				return typeof text === "string" ? text : JSON.stringify(block);
			}
			return JSON.stringify(block);
		})
		.join("\n");
}

/**
 * A tool result is an error when it parses to an object carrying `error`, or
 * when it is one of LangChain's plain-text tool failures.
 *
 * ponytail: the plain-text branch is not cosmetic. `executeAgentTool` always
 * returns JSON, so a non-JSON result can only come from the LangChain layer
 * ABOVE it — an unknown tool ("Error: ls is not a valid tool, try one of […]")
 * or an argument the zod binding rejected ("Error invoking tool 'addZoom' …
 * Received tool input did not match expected schema"). Both used to be counted
 * as inconclusive-ok, on the assumption that a non-JSON result was a
 * deepagents-side tool doing its job. There are no such tools any more, so that
 * assumption now hides exactly the failures the DSL axis exists to catch.
 */
export function resultIsError(resultJson: string | undefined): boolean {
	if (resultJson === undefined) return true;
	try {
		const parsed: unknown = JSON.parse(resultJson);
		return Boolean(parsed && typeof parsed === "object" && "error" in parsed);
	} catch {
		return /^error\b/i.test(resultJson.trim());
	}
}

/**
 * Calls to `name` the runtime actually ANSWERED — the tool ran and returned its
 * own JSON.
 *
 * ponytail: `calls(name).length > 0` was the whole of every "did it look?"
 * check, and it cannot fail on the commonest way a look comes back empty: a
 * name the agent does not carry. LangChain answers those with a plain-text
 * `Error: … is not a valid tool`, which `resultIsError` already recognises —
 * and which a check counting NAMES scores as a successful read. A workbench
 * whose scenario still names a renamed tool then reports a perfect score for a
 * turn in which nothing was read at all.
 */
export function answeredCalls(calls: WireCall[], name: string): WireCall[] {
	return calls.filter((call) => call.name === name && call.resultOk);
}

/**
 * …and the stricter form: calls that brought DATA back, i.e. whose payload says
 * `available: true`.
 *
 * The telemetry tool answers `ok: true` on all three of its branches on purpose
 * — "none recorded" and "I could not look" are answers, not failures — so
 * `resultOk` alone still credits a model that asked about an asset with no
 * sidecar, or misspelled the assetId into a different asset. Where the scenario
 * wires a readable sidecar, "it looked" has to mean it holds the samples.
 */
export function callsWithData(calls: WireCall[], name: string): WireCall[] {
	return answeredCalls(calls, name).filter((call) => {
		try {
			const parsed: unknown = JSON.parse(call.resultJson ?? "");
			return (
				Boolean(parsed) &&
				typeof parsed === "object" &&
				(parsed as { available?: unknown }).available === true
			);
		} catch {
			return false;
		}
	});
}

/** The system message as ONE string, joined exactly the way `systemSha256` was
 * computed over it — so a persisted `system-<sha>.txt` can be verified against
 * the fingerprint a report carries instead of being taken on trust. */
export function systemTextOf(wire: WireTranscript): string {
	return textOfBlocks(wire.systemBlocks);
}

export function wireFromRequests(requests: CapturedRequest[]): WireTranscript {
	const first = requests[0];
	const firstBody = first ? bodyOf(first) : {};
	const systemMessage = (firstBody.messages ?? []).find((m) => m.role === "system");
	const systemBlocks = systemBlocksOf(systemMessage?.content);
	const systemText = textOfBlocks(systemBlocks);

	const toolsSent: WireTool[] = (firstBody.tools ?? []).map((tool) => ({
		name: String(tool.function?.name ?? "?"),
		description: String(tool.function?.description ?? ""),
		parameters: tool.function?.parameters,
	}));

	// Results are keyed by tool_call_id and can appear in ANY later request; the
	// history is not guaranteed to be one linear thread (it never was under the
	// `task` sub-agent, and a future middleware could split it again).
	const resultsById = new Map<string, string>();
	for (const request of requests) {
		for (const message of bodyOf(request).messages ?? []) {
			if (message.role !== "tool") continue;
			const id = typeof message.tool_call_id === "string" ? message.tool_call_id : null;
			if (!id || resultsById.has(id)) continue;
			resultsById.set(
				id,
				typeof message.content === "string" ? message.content : JSON.stringify(message.content),
			);
		}
	}

	const calls: WireCall[] = [];
	const seen = new Set<string>();
	requests.forEach((request, requestIndex) => {
		for (const message of bodyOf(request).messages ?? []) {
			for (const call of message.tool_calls ?? []) {
				const id = typeof call.id === "string" && call.id ? call.id : null;
				// No id means we cannot pair a result; still record it, with a
				// synthetic key, rather than dropping evidence of the emission.
				const key = id ?? `anon:${requestIndex}:${calls.length}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const name = String(call.function?.name ?? "?");
				const argsJson =
					typeof call.function?.arguments === "string"
						? call.function.arguments
						: JSON.stringify(call.function?.arguments ?? {});
				let args: unknown;
				try {
					args = argsJson.trim() ? JSON.parse(argsJson) : {};
				} catch {
					args = undefined;
				}
				const resultJson = id ? resultsById.get(id) : undefined;
				calls.push({
					// The call reached us inside the request that FOLLOWS the response
					// that produced it, so the emitting round is one behind.
					round: Math.max(0, requestIndex - 1),
					id: key,
					name,
					argsJson,
					args,
					mutating: isMutatingTool(name),
					resultJson,
					resultOk: !resultIsError(resultJson),
				});
			}
		}
	});

	return {
		systemBlocks,
		systemChars: systemText.length,
		systemSha256: sha256(systemText),
		toolsSent,
		toolNames: toolsSent.map((t) => t.name),
		toolsSha256: sha256(JSON.stringify(toolsSent)),
		calls,
		rounds: requests.length,
	};
}

export interface SseTranscript {
	calls: Array<{ id: string; name: string; arguments: string }>;
	finalText: string;
}

/**
 * Rebuilds the model's emissions from raw SSE bytes — the L0 replay path, and
 * the way a cassette is turned back into a tool-call transcript.
 *
 * The delicate part is that `tool_calls` deltas are FRAGMENTED: the name
 * arrives on the first chunk for a given `index` and the arguments trickle in
 * as string slices on later chunks carrying the same `index`. Concatenating by
 * index is the only correct reassembly.
 */
export function transcriptFromSse(sse: string): SseTranscript {
	const byIndex = new Map<number, { id: string; name: string; arguments: string }>();
	let finalText = "";
	for (const line of sse.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		let event: {
			choices?: Array<{
				delta?: {
					content?: unknown;
					tool_calls?: Array<{
						index?: unknown;
						id?: unknown;
						function?: { name?: unknown; arguments?: unknown };
					}>;
				};
			}>;
		};
		try {
			event = JSON.parse(payload);
		} catch {
			continue;
		}
		const delta = event.choices?.[0]?.delta;
		if (!delta) continue;
		if (typeof delta.content === "string") finalText += delta.content;
		for (const fragment of delta.tool_calls ?? []) {
			const index = typeof fragment.index === "number" ? fragment.index : 0;
			const entry = byIndex.get(index) ?? { id: "", name: "", arguments: "" };
			if (typeof fragment.id === "string" && fragment.id) entry.id = fragment.id;
			if (typeof fragment.function?.name === "string" && fragment.function.name) {
				entry.name = fragment.function.name;
			}
			if (typeof fragment.function?.arguments === "string") {
				entry.arguments += fragment.function.arguments;
			}
			byIndex.set(index, entry);
		}
	}
	const calls = [...byIndex.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([index, entry]) => ({
			id: entry.id || `sse_${index}`,
			name: entry.name,
			arguments: entry.arguments,
		}))
		.filter((entry) => entry.name.length > 0);
	return { calls, finalText };
}
