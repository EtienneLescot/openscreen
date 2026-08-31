// ponytail: the single seam of the whole workbench — a local OpenAI-compatible
// endpoint the app talks to as `provider: "openai-compatible"`. Three modes
// share one wire format:
//   script  — turns written by hand in a scenario file (offline, deterministic)
//   replay  — turns read back from a cassette (offline, deterministic)
//   record  — proxies to the real provider and writes the cassette (network)
//
// INVARIANT, learned the hard way: every response MUST carry a unique `id`.
// LangGraph's `add_messages` reducer merges by message id, so reusing one id
// makes each new assistant message REPLACE the previous one — the agent then
// silently loses every earlier tool result inside the same turn and the
// workbench measures amnesia that production does not have.

import { createServer, type Server } from "node:http";

export interface ScriptedToolCall {
	name: string;
	args: unknown;
}
export type ScriptedTurn =
	| { kind: "tools"; calls: ScriptedToolCall[] }
	| { kind: "text"; text: string }
	| { kind: "thinking"; reasoning: string; text: string };

export interface CapturedRequest {
	round: number;
	systemChars: number;
	toolNames: string[];
	messages: Array<{ role: string; content: string; toolCalls: string[] }>;
	raw: unknown;
}

export interface ModelServerHandle {
	url: string;
	requests: CapturedRequest[];
	/** Le modèle que le flux s'est attribué, quand un enregistreur l'a lu. Null
	 *  tant qu'aucune réponse n'est passée, et absent des serveurs scriptés. */
	resolvedModel?: string | null;
	close: () => void;
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

function chunk(responseId: string, delta: unknown, finish: string | null) {
	return {
		id: responseId,
		object: "chat.completion.chunk",
		created: 0,
		model: "workbench",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

function capture(round: number, body: Record<string, unknown>): CapturedRequest {
	const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
	const system = messages[0];
	return {
		round,
		systemChars: JSON.stringify(system?.content ?? "").length,
		toolNames: ((body.tools ?? []) as Array<{ function?: { name?: string } }>).map(
			(t) => t.function?.name ?? "?",
		),
		messages: messages.map((m) => ({
			role: String(m.role),
			content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
			toolCalls: ((m.tool_calls ?? []) as Array<{ function?: { name?: string } }>).map(
				(t) => t.function?.name ?? "?",
			),
		})),
		raw: body,
	};
}

export async function startScriptedModel(script: ScriptedTurn[]): Promise<ModelServerHandle> {
	const requests: CapturedRequest[] = [];
	let round = 0;

	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			requests.push(capture(round, JSON.parse(body)));
			const turn = script[Math.min(round, script.length - 1)];
			const responseId = `wb-${round}`;
			round += 1;

			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(sse(chunk(responseId, { role: "assistant", content: "" }, null)));

			if (turn.kind === "tools") {
				turn.calls.forEach((call, i) => {
					res.write(
						sse(
							chunk(
								responseId,
								{
									tool_calls: [
										{
											index: i,
											id: `call_${responseId}_${i}`,
											type: "function",
											function: {
												name: call.name,
												// ponytail: string, exactly like the wire — a scenario can
												// therefore inject malformed JSON on purpose.
												arguments:
													typeof call.args === "string" ? call.args : JSON.stringify(call.args),
											},
										},
									],
								},
								null,
							),
						),
					);
				});
				res.write(sse(chunk(responseId, {}, "tool_calls")));
			} else {
				const text = turn.kind === "text" ? turn.text : turn.text;
				for (const piece of text.match(/.{1,24}/g) ?? [text]) {
					res.write(sse(chunk(responseId, { content: piece }, null)));
				}
				res.write(sse(chunk(responseId, {}, "stop")));
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("model server has no address");
	return {
		url: `http://127.0.0.1:${addr.port}/v1`,
		requests,
		close: () => server.close(),
	};
}
