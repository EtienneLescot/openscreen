// Codex (ChatGPT OAuth) account-session helpers and the SSE body/parsers for
// the `/codex/responses` endpoint. Mirrors axcut's
// apps/server/src/llm/provider-runtime/openai-account.ts but adapted for
// OpenScreen's direct-fetch call path (no LangChain).
//
// Auth (beginCodexDeviceAuth / completeCodexDeviceAuth) and the runtime
// bearer exchange live in `llm-provider-auth.ts`; this module handles
// per-session identity (request id, window id, installation id) and the
// streaming response parser.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	beginCodexDeviceAuth,
	type CodexDeviceChallenge,
	type CodexTokens,
	completeCodexDeviceAuth,
	extractChatgptAccountId,
} from "./llm-provider-auth";

export const CODEX_RESPONSES_PATH = "/codex/responses";
export const CODEX_MODELS_PATH = "/codex/models";
export const CODEX_DEFAULT_MODEL = "gpt-5.4";

const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_INSTALLATION_ID_FILENAME = "codex_installation_id";

export const CODEX_REASONING_EFFORT_OPTIONS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];

export interface CodexIdentity {
	requestId: string;
	windowId: string;
	installationId: string;
	clientMetadata: Record<string, unknown>;
}

export interface CodexSession {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	accountId?: string;
	sessionId: string;
	identity: CodexIdentity;
}

export type CodexEvent = Record<string, unknown>;

/**
 * Begin + complete the full Codex device flow, returning a session ready for
 * call time. Installs the persistent installation id on first run.
 */
export async function beginCodexSession(
	userDataPath: string,
): Promise<{ challenge: CodexDeviceChallenge; complete: () => Promise<CodexSession> }> {
	const identity = await ensureIdentity(userDataPath);
	const challenge = await beginCodexDeviceAuth();
	const complete = async (): Promise<CodexSession> => {
		const tokens = await completeCodexDeviceAuth({
			intervalMs: challenge.intervalMs,
			expiresAt: challenge.expiresAt,
			deviceAuthId: challenge.deviceAuthId,
			userCode: challenge.userCode,
		});
		return {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt,
			accountId: tokens.accountId,
			sessionId: randomUUID(),
			identity,
		};
	};
	return { challenge, complete };
}

/**
 * Load (or generate) the persistent Codex installation id, plus a fresh
 * per-call request id and a session-scoped window id.
 */
export async function ensureIdentity(userDataPath: string): Promise<CodexIdentity> {
	const installationId = await ensureInstallationId(userDataPath);
	return {
		installationId,
		windowId: randomUUID(),
		requestId: randomUUID(),
		clientMetadata: {
			name: "OpenScreen",
			version: "1.6.0",
		},
	};
}

async function ensureInstallationId(userDataPath: string): Promise<string> {
	const dir = path.join(userDataPath, "codex");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, CODEX_INSTALLATION_ID_FILENAME);
	try {
		const existing = (await fs.readFile(file, "utf8")).trim();
		if (existing) return existing;
	} catch {
		// first run, mint a new one
	}
	const id = randomUUID();
	await fs.writeFile(file, id, { encoding: "utf8", mode: 0o600 });
	return id;
}

/**
 * Refresh the Codex tokens. Returns the new tokens + expiry. The caller is
 * responsible for writing them back through `LlmConfigStore.setCredential`.
 */
export async function refreshCodexSession(
	refreshToken: string,
): Promise<Pick<CodexTokens, "accessToken" | "refreshToken" | "expiresAt" | "accountId">> {
	const CODEX_ISSUER = "https://auth.openai.com";
	const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: CODEX_CLIENT_ID,
	});
	const res = await fetch(`${CODEX_ISSUER}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	if (!res.ok) {
		const detail = await res.text();
		throw new Error(
			detail ? `Codex refresh failed: ${detail}` : `Codex refresh failed: HTTP ${res.status}`,
		);
	}
	const json = (await res.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};
	if (!json.access_token) throw new Error("Codex refresh returned no access_token.");
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
		accountId: extractChatgptAccountId(json.access_token),
	};
}

// --- Reason-effort wire-up ------------------------------------------------

/**
 * Build the Codex `reasoning` payload. Mirrors `toCodexReasoningPayload` in
 * axcut: `none` → omitted; `minimal → low`; `xhigh → high`; gpt-5+ models
 * get `summary: 'auto'` so the server returns a small reasoning summary.
 */
export function toCodexReasoningPayload(
	modelId: string,
	effort: CodexReasoningEffort,
): Record<string, unknown> {
	if (effort === "none") return {};
	const collapsed: CodexReasoningEffort =
		effort === "minimal" ? "low" : effort === "xhigh" ? "high" : effort;
	const isGpt5 = /^gpt-5/i.test(modelId);
	return {
		reasoning: {
			effort: collapsed,
			...(isGpt5 ? { summary: "auto" } : {}),
		},
	};
}

// --- Identity / user-agent ------------------------------------------------

export function buildCodexUserAgent(): string {
	const term = detectTerminal();
	return `${CODEX_ORIGINATOR}/1.6.0 (${os.platform()} ${os.release()}; ${os.arch()}) ${term}`;
}

function detectTerminal(): string {
	const termProgram = process.env.TERM_PROGRAM;
	const termProgramVersion = process.env.TERM_PROGRAM_VERSION;
	if (termProgram) return termProgramVersion ? `${termProgram}/${termProgramVersion}` : termProgram;
	if (process.env.WT_SESSION) return "WindowsTerminal";
	if (process.env.WEZTERM_VERSION) return `WezTerm/${process.env.WEZTERM_VERSION}`;
	if (process.env.TERM) return process.env.TERM;
	return "unknown";
}

// --- Body shaping ---------------------------------------------------------

/**
 * Convert OpenScreen `ChatMessage` history into the Codex `input` array.
 * System prompt becomes `instructions` (set separately by the caller).
 */
export function toCodexInput(
	messages: Array<{
		role: string;
		content: string;
		toolCalls?: Array<{ id: string; name: string; arguments: string }>;
		toolCallId?: string;
	}>,
): Array<Record<string, unknown>> {
	const input: Array<Record<string, unknown>> = [];
	for (const m of messages) {
		// System becomes `instructions` on the body, not part of `input`.
		if (m.role === "system") continue;
		if (m.role === "tool") {
			input.push({
				type: "tool_result",
				role: "tool",
				tool_call_id: m.toolCallId ?? "",
				content: m.content,
			});
			continue;
		}
		if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
			input.push({
				role: "assistant",
				content: m.toolCalls.map((call) => ({
					type: "tool_call",
					name: call.name,
					arguments: call.arguments,
					call_id: call.id,
				})),
			});
			continue;
		}
		input.push({ role: m.role, content: m.content });
	}
	return input;
}

/**
 * Convert OpenScreen tool specs (OpenAI `function` shape) into the Codex
 * `tools` array. Strict-by-default to match the server's expectations.
 */
export function toCodexTools(
	tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
	return tools.map((t) => ({
		type: "function",
		name: t.name,
		description: t.description,
		parameters: t.parameters,
		strict: true,
	}));
}

// --- SSE -----------------------------------------------------------------

/**
 * Parse a Codex/ChatGPT SSE stream into a sequence of decoded JSON events.
 * Accepts an SSE body in `data: …\n\n` chunks. Skips malformed payloads,
 * terminator `[DONE]`, and lines without a `data:` prefix.
 */
export async function* parseCodexSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<CodexEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let idx = buffer.indexOf("\n\n");
		while (idx !== -1) {
			const chunk = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const dataLines = chunk
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trim());
			if (dataLines.length > 0) {
				const data = dataLines.join("\n").trim();
				if (data && data !== "[DONE]") {
					try {
						yield JSON.parse(data) as CodexEvent;
					} catch {
						/* skip malformed */
					}
				}
			}
			idx = buffer.indexOf("\n\n");
		}
	}
}

export interface CodexToolCallDelta {
	id: string;
	name: string;
	/** JSON arguments; may be partial until `response.output_item.done`. */
	args: string;
}

/**
 * Walk a Codex SSE event stream and yield:
 *   - `{ kind: "text", delta }` for `response.output_text.delta`
 *   - `{ kind: "tool", delta }` for tool-call argument deltas
 *   - `{ kind: "done" }` on `response.completed`
 *   - throws on `response.failed` / `error`
 *
 * Tool-call ids are de-duplicated across `output_item.added` and
 * `function_call_arguments.delta` events using the `call_id` ↔ `item_id`
 * aliases that Codex sends.
 */
export async function* consumeCodexStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<
	| { kind: "text"; delta: string }
	| { kind: "tool"; delta: CodexToolCallDelta }
	| { kind: "response_id"; id: string }
	| { kind: "done" }
> {
	const aliases = new Map<string, string>();
	const streamedArgs = new Map<string, string>();
	const toolCalls = new Map<string, CodexToolCallDelta>();

	for await (const event of parseCodexSSE(body)) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		switch (type) {
			case "response.output_text.delta": {
				if (typeof event.delta === "string") yield { kind: "text", delta: event.delta };
				break;
			}
			case "response.output_item.added":
			case "response.output_item.done": {
				const item = readItem(event);
				if (!item) break;
				const tc = extractToolCall(item, toolCalls.size);
				if (!tc) break;
				toolCalls.set(tc.id, tc);
				recordAlias(item, tc.id, aliases);
				if (type === "response.output_item.done") {
					const streamed = streamedArgs.get(tc.id) ?? "";
					const missing = unstreamedArgs(tc.args, streamed);
					if (missing) {
						streamedArgs.set(tc.id, `${streamed}${missing}`);
						tc.args = `${toolCalls.get(tc.id)?.args ?? ""}${missing}`;
						yield { kind: "tool", delta: { id: tc.id, name: tc.name, args: missing } };
					}
				} else {
					yield { kind: "tool", delta: { id: tc.id, name: tc.name, args: "" } };
				}
				break;
			}
			case "response.function_call_arguments.delta": {
				const id = resolveToolCallEventId(event, aliases);
				if (!id || typeof event.delta !== "string") break;
				const tc = toolCalls.get(id);
				if (!tc) break;
				tc.args = `${tc.args}${event.delta}`;
				streamedArgs.set(id, `${streamedArgs.get(id) ?? ""}${event.delta}`);
				yield { kind: "tool", delta: { id, name: tc.name, args: event.delta } };
				break;
			}
			case "response.function_call_arguments.done": {
				const id = resolveToolCallEventId(event, aliases);
				if (!id) break;
				const tc = toolCalls.get(id);
				if (!tc) break;
				const finalArgs = readString(event.arguments) ?? tc.args;
				const streamed = streamedArgs.get(id) ?? "";
				const missing = unstreamedArgs(finalArgs, streamed);
				if (missing) {
					tc.args = `${tc.args}${missing}`;
					yield { kind: "tool", delta: { id, name: tc.name, args: missing } };
				}
				break;
			}
			case "response.completed": {
				const resp = (event.response ?? {}) as Record<string, unknown>;
				const id = readString(resp.id);
				if (id) yield { kind: "response_id", id };
				yield { kind: "done" };
				return;
			}
			case "response.failed":
				throw new Error(extractSseError(event) ?? "Codex response failed.");
			case "error":
				throw new Error(extractSseError(event) ?? "Codex stream error.");
		}
	}
}

// --- Tiny helpers --------------------------------------------------------

function readItem(event: CodexEvent): Record<string, unknown> | undefined {
	const item = event.item ?? event.output_item;
	return item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function extractToolCall(
	item: Record<string, unknown> | undefined,
	index: number,
): CodexToolCallDelta | undefined {
	if (!item || item.type !== "function_call") return undefined;
	const name = readString(item.name);
	if (!name) return undefined;
	const id = readString(item.call_id) || readString(item.id) || `codex-tool-${index + 1}`;
	const args =
		typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
	return { id, name, args };
}

function recordAlias(
	item: Record<string, unknown>,
	toolCallId: string,
	aliases: Map<string, string>,
): void {
	for (const candidate of [item.call_id, item.id]) {
		const alias = readString(candidate);
		if (alias) aliases.set(alias, toolCallId);
	}
}

function resolveToolCallEventId(
	event: CodexEvent,
	aliases: Map<string, string>,
): string | undefined {
	const callId = readString(event.call_id);
	if (callId) return aliases.get(callId) ?? callId;
	const itemId = readString(event.item_id);
	return itemId ? (aliases.get(itemId) ?? itemId) : undefined;
}

function unstreamedArgs(finalArgs: string, streamed: string): string {
	if (!finalArgs) return "";
	if (!streamed) return finalArgs;
	if (finalArgs.startsWith(streamed)) return finalArgs.slice(streamed.length);
	return "";
}

function extractSseError(event: CodexEvent): string | undefined {
	const direct = readString(event.message) || readString(event.detail) || readString(event.code);
	if (direct) return direct;
	const nested = (event as { error?: unknown }).error;
	if (typeof nested === "string") return nested.trim() || undefined;
	if (nested && typeof nested === "object") {
		const rec = nested as Record<string, unknown>;
		const m = readString(rec.message) || readString(rec.detail) || readString(rec.code);
		if (m) return m;
	}
	try {
		const s = JSON.stringify(event);
		return s && s !== "{}" ? s : undefined;
	} catch {
		return undefined;
	}
}
