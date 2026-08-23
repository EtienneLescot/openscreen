// L0 — no LLM, no network. The wire reader is the DSL axis's only evidence
// path, so it is tested against hand-built request logs that reproduce the
// shapes the provider actually sees.

import { describe, expect, it } from "vitest";
import { modelFromSse } from "../lib/cassette";
import type { CapturedRequest } from "../lib/model-server";
import { transcriptFromSse, wireFromRequests } from "../lib/wire";

function request(round: number, body: unknown): CapturedRequest {
	return { round, systemChars: 0, toolNames: [], messages: [], raw: body };
}

describe("wireFromRequests", () => {
	it("reads the system message as sent, blocks and all", () => {
		const wire = wireFromRequests([
			request(0, {
				messages: [
					{
						role: "system",
						content: [
							{ type: "text", text: "ours" },
							{ type: "text", text: "theirs" },
						],
					},
					{ role: "user", content: "hi" },
				],
				tools: [],
			}),
		]);
		expect(wire.systemBlocks).toHaveLength(2);
		expect(wire.systemChars).toBe("ours\ntheirs".length);
		expect(wire.systemSha256).toHaveLength(64);
	});

	it("accepts a plain-string system message too", () => {
		const wire = wireFromRequests([
			request(0, { messages: [{ role: "system", content: "flat" }], tools: [] }),
		]);
		expect(wire.systemBlocks).toEqual(["flat"]);
		expect(wire.systemChars).toBe(4);
	});

	it("records the whole tool surface verbatim, whatever is on it", () => {
		const wire = wireFromRequests([
			request(0, {
				messages: [],
				tools: [
					{ function: { name: "addZoom", description: "d1", parameters: { a: 1 } } },
					{ function: { name: "grep", description: "d2", parameters: {} } },
				],
			}),
		]);
		expect(wire.toolNames).toEqual(["addZoom", "grep"]);
		expect(wire.toolsSent[0].description).toBe("d1");
	});

	it("pairs a call with its result by tool_call_id, never by name", () => {
		// Two addZoom calls in one batch: pairing by name would attach the wrong
		// result to at least one of them.
		const wire = wireFromRequests([
			request(0, { messages: [{ role: "user", content: "go" }], tools: [] }),
			request(1, {
				messages: [
					{ role: "user", content: "go" },
					{
						role: "assistant",
						tool_calls: [
							{
								id: "call_a",
								function: { name: "addZoom", arguments: '{"startSec":1,"endSec":2}' },
							},
							{
								id: "call_b",
								function: { name: "addZoom", arguments: '{"startSec":9,"endSec":9}' },
							},
						],
					},
					{
						role: "tool",
						tool_call_id: "call_b",
						content: '{"zoomId":"z2","startSec":9,"endSec":9}',
					},
					{
						role: "tool",
						tool_call_id: "call_a",
						content: '{"zoomId":"z1","startSec":1,"endSec":2}',
					},
				],
			}),
		]);
		expect(wire.calls.map((c) => c.id)).toEqual(["call_a", "call_b"]);
		expect(wire.calls[0].resultJson).toContain("z1");
		expect(wire.calls[1].resultJson).toContain("z2");
		expect(wire.calls[0].args).toEqual({ startSec: 1, endSec: 2 });
	});

	it("flags a tool result carrying an error", () => {
		const wire = wireFromRequests([
			request(0, { messages: [], tools: [] }),
			request(1, {
				messages: [
					{
						role: "assistant",
						tool_calls: [{ id: "c1", function: { name: "getTranscript", arguments: "{}" } }],
					},
					{ role: "tool", tool_call_id: "c1", content: '{"error":"No transcript for asset_1."}' },
				],
			}),
		]);
		expect(wire.calls[0].resultOk).toBe(false);
		expect(wire.calls[0].mutating).toBe(false);
	});

	it("flags LangChain's plain-text failures, which are not JSON at all", () => {
		// `executeAgentTool` always returns JSON, so a non-JSON result comes from
		// the layer ABOVE it. Both strings below were captured verbatim from the
		// real loop. They used to be counted as inconclusive-OK — a hole big
		// enough for every unknown-tool and bad-argument call to fall through.
		for (const content of [
			"Error: ls is not a valid tool, try one of [getCurrentDocument, addTrim].",
			'Error invoking tool \'addZoom\' with kwargs {"startSec":"3"} with error: ' +
				"Error: Received tool input did not match expected schema",
		]) {
			const wire = wireFromRequests([
				request(0, { messages: [], tools: [] }),
				request(1, {
					messages: [
						{
							role: "assistant",
							tool_calls: [{ id: "c1", function: { name: "addZoom", arguments: "{}" } }],
						},
						{ role: "tool", tool_call_id: "c1", content },
					],
				}),
			]);
			expect(wire.calls[0].resultOk).toBe(false);
		}
	});

	it("leaves an ordinary non-JSON result alone", () => {
		// Only a leading "Error" makes it a failure — a tool that legitimately
		// returns prose must not be scored as one.
		const wire = wireFromRequests([
			request(0, { messages: [], tools: [] }),
			request(1, {
				messages: [
					{
						role: "assistant",
						tool_calls: [{ id: "c1", function: { name: "getTranscript", arguments: "{}" } }],
					},
					{ role: "tool", tool_call_id: "c1", content: "no errors here, just prose" },
				],
			}),
		]);
		expect(wire.calls[0].resultOk).toBe(true);
	});

	it("marks mutating calls from the executor's own table", () => {
		const wire = wireFromRequests([
			request(0, { messages: [], tools: [] }),
			request(1, {
				messages: [
					{
						role: "assistant",
						tool_calls: [
							{ id: "c1", function: { name: "addTrim", arguments: "{}" } },
							{ id: "c2", function: { name: "getCurrentDocument", arguments: "{}" } },
						],
					},
				],
			}),
		]);
		expect(wire.calls.map((c) => c.mutating)).toEqual([true, false]);
	});

	it("keeps malformed arguments verbatim instead of dropping the call", () => {
		const wire = wireFromRequests([
			request(0, { messages: [], tools: [] }),
			request(1, {
				messages: [
					{
						role: "assistant",
						tool_calls: [{ id: "c1", function: { name: "addZoom", arguments: "{not json" } }],
					},
				],
			}),
		]);
		expect(wire.calls[0].argsJson).toBe("{not json");
		expect(wire.calls[0].args).toBeUndefined();
	});

	it("does not double-count a call that reappears in later histories", () => {
		const assistant = {
			role: "assistant",
			tool_calls: [{ id: "c1", function: { name: "addTrim", arguments: "{}" } }],
		};
		const wire = wireFromRequests([
			request(0, { messages: [], tools: [] }),
			request(1, { messages: [assistant] }),
			request(2, { messages: [assistant, { role: "assistant", content: "done" }] }),
		]);
		expect(wire.calls).toHaveLength(1);
		expect(wire.rounds).toBe(3);
	});
});

describe("transcriptFromSse", () => {
	it("reassembles tool arguments fragmented across chunks by index", () => {
		const chunks = [
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "c1", function: { name: "addZoom", arguments: '{"start' } },
							],
						},
					},
				],
			},
			{
				choices: [
					{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Sec":3,"endSec":5}' } }] } },
				],
			},
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		];
		const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
		const transcript = transcriptFromSse(sse);
		expect(transcript.calls).toEqual([
			{ id: "c1", name: "addZoom", arguments: '{"startSec":3,"endSec":5}' },
		]);
	});

	it("concatenates the final text and survives junk lines", () => {
		const sse = [
			`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}`,
			"",
			"data: not-json",
			"",
			`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`,
			"",
			"data: [DONE]",
			"",
		].join("\n");
		expect(transcriptFromSse(sse).finalText).toBe("Hello");
	});
});

describe("modelFromSse — qui a répondu, pas ce qu'on a demandé", () => {
	const chunk = (model: string) =>
		`data: ${JSON.stringify({ object: "chat.completion.chunk", model, choices: [] })}\n\n`;

	it("rend le modèle que le flux s'attribue", () => {
		expect(modelFromSse(chunk("deepseek-v4-flash"))).toBe("deepseek-v4-flash");
	});

	it("rend celui du PREMIER chunk qui se nomme, et ne suppose pas les suivants", () => {
		// Un flux qui change d'avis en cours de route est précisément ce qu'on veut
		// pouvoir constater ; le premier nom est la réponse, pas une moyenne.
		expect(modelFromSse(chunk("a") + chunk("b"))).toBe("a");
	});

	it("rend null quand le flux ne se nomme pas — jamais le modèle demandé", () => {
		// L'absence est une absence. Retomber sur la demande ici rendrait la
		// divergence invisible, ce qui est le défaut que cette fonction répare.
		expect(
			modelFromSse('data: {"object":"chat.completion.chunk","choices":[]}' + `\n\n`),
		).toBeNull();
	});

	it("ignore un chunk illisible au lieu d'abandonner le flux", () => {
		expect(modelFromSse("data: {pas du json}" + `\n\n` + chunk("c"))).toBe("c");
	});

	it("s'arrête à [DONE] et ne rend rien d'un flux vide", () => {
		expect(modelFromSse("data: [DONE]" + `\n\n` + chunk("d"))).toBeNull();
		expect(modelFromSse("")).toBeNull();
	});
});
