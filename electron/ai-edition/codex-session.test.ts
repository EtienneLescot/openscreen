import { describe, expect, it } from "vitest";
import {
	buildCodexUserAgent,
	consumeCodexStream,
	parseCodexSSE,
	toCodexInput,
	toCodexReasoningPayload,
} from "./codex-session";
import { parseAnthropicEvents } from "./llm-call";

// ponytail: helpers for faking SSE ReadableStreams in jsdom.
function sseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(lines));
			controller.close();
		},
	});
}

describe("parseCodexSSE", () => {
	it("yields the parsed JSON for each `data:` chunk", async () => {
		const events = [
			{ type: "response.created", id: "r1" },
			{ type: "response.delta", x: 2 },
		];
		const out: Array<Record<string, unknown>> = [];
		for await (const e of parseCodexSSE(sseStream(events))) out.push(e);
		expect(out).toEqual(events);
	});

	it("skips `[DONE]` and malformed lines", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode('data: {"type":"a"}\n\ndata: [DONE]\n\ndata: {not json}\n\n'),
				);
				controller.close();
			},
		});
		const out: Array<Record<string, unknown>> = [];
		for await (const e of parseCodexSSE(stream)) out.push(e);
		expect(out).toEqual([{ type: "a" }]);
	});
});

describe("consumeCodexStream", () => {
	it("yields text deltas for response.output_text.delta", async () => {
		const stream = sseStream([
			{ type: "response.output_text.delta", delta: "Hello" },
			{ type: "response.output_text.delta", delta: " world" },
			{ type: "response.completed", response: { id: "r1" } },
		]);
		const kinds: Array<string> = [];
		let text = "";
		for await (const ev of consumeCodexStream(stream)) {
			kinds.push(ev.kind);
			if (ev.kind === "text") text += ev.delta;
		}
		expect(kinds).toContain("text");
		expect(text).toBe("Hello world");
	});

	it("collects tool-call argument deltas + emits response_id", async () => {
		const stream = sseStream([
			{
				type: "response.output_item.added",
				item: { type: "function_call", call_id: "c1", name: "addSkip" },
			},
			{ type: "response.function_call_arguments.delta", call_id: "c1", delta: '{"a":' },
			{ type: "response.function_call_arguments.delta", call_id: "c1", delta: "1}" },
			{
				type: "response.output_item.done",
				item: { type: "function_call", call_id: "c1", name: "addSkip" },
			},
			{ type: "response.completed", response: { id: "r42" } },
		]);
		// ponytail: callers accumulate the chunked argument strings themselves,
		// same as the OpenAI stream consumption path. The parser only ships
		// per-chunk deltas; recomposing the full args is the consumer's job.
		const accumulated = new Map<string, string>();
		let responseId = "";
		let sawAny = false;
		for await (const ev of consumeCodexStream(stream)) {
			if (ev.kind === "tool") {
				sawAny = true;
				accumulated.set(ev.delta.id, `${accumulated.get(ev.delta.id) ?? ""}${ev.delta.args}`);
			} else if (ev.kind === "response_id") {
				responseId = ev.id;
			}
		}
		expect(sawAny).toBe(true);
		expect(accumulated.get("c1")).toBe('{"a":1}');
		expect(responseId).toBe("r42");
	});

	it("throws on response.failed", async () => {
		const stream = sseStream([{ type: "response.failed", error: { message: "oops" } }]);
		await expect(async () => {
			for await (const _ of consumeCodexStream(stream)) {
				/* noop */
			}
		}).rejects.toThrow(/oops/);
	});
});

describe("toCodexInput", () => {
	it("converts tool messages and assistant tool-calls", () => {
		const input = toCodexInput([
			{ role: "system", content: "ignore me" },
			{ role: "user", content: "cut it" },
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "c1", name: "addSkip", arguments: '{"a":1}' }],
			},
			{ role: "tool", content: '{"ok":true}', toolCallId: "c1" },
		]);
		expect(input).toEqual([
			{ role: "user", content: "cut it" },
			{
				role: "assistant",
				content: [{ type: "tool_call", name: "addSkip", arguments: '{"a":1}', call_id: "c1" }],
			},
			{ type: "tool_result", role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
		]);
	});
});

describe("toCodexReasoningPayload", () => {
	it("omits reasoning on `none`", () => {
		expect(toCodexReasoningPayload("gpt-5", "none")).toEqual({});
	});

	it("collapses minimal → low", () => {
		expect(toCodexReasoningPayload("gpt-5", "minimal")).toEqual({
			reasoning: { effort: "low", summary: "auto" },
		});
	});

	it("collapses xhigh → high", () => {
		expect(toCodexReasoningPayload("gpt-5", "xhigh")).toEqual({
			reasoning: { effort: "high", summary: "auto" },
		});
	});

	it("passes through other efforts unchanged", () => {
		expect(toCodexReasoningPayload("gpt-5", "medium").reasoning).toEqual({
			effort: "medium",
			summary: "auto",
		});
	});
});

describe("parseAnthropicEvents", () => {
	it("preserves the `event:` name alongside the JSON payload", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
					),
				);
				controller.close();
			},
		});
		const types: string[] = [];
		for await (const ev of parseAnthropicEvents(stream)) types.push(ev.type);
		expect(types).toContain("message_start");
		expect(types).toContain("content_block_delta");
	});
});

describe("buildCodexUserAgent", () => {
	it("starts with the codex_cli_rs originator and a platform triple", () => {
		const ua = buildCodexUserAgent();
		expect(ua).toMatch(/^codex_cli_rs\//);
		expect(ua).toMatch(/\(win32|linux|darwin /);
	});
});
