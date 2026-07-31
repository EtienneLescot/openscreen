// ponytail: record/replay of the provider's raw SSE bytes. The recorder is a
// transparent proxy: it forwards the Authorization header it receives without
// reading it, and never writes it to disk. The cassette holds only the request
// fingerprint and the response body.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { containsSecret } from "./env";
import { normalizeIds } from "./harness";
import type { CapturedRequest, ModelServerHandle } from "./model-server";

export interface CassetteRound {
	round: number;
	/** sha256 of the normalized request — stale-cassette detection only. */
	requestHash: string;
	/** Human-readable digest so a cassette diff is reviewable. */
	digest: { systemChars: number; toolCount: number; roles: string[]; lastUserText: string };
	/** Raw `text/event-stream` body, verbatim. */
	sse: string;
}

export interface Cassette {
	scenario: string;
	provider: string;
	model: string;
	recordedAt: string;
	rounds: CassetteRound[];
}

export function hashRequest(body: Record<string, unknown>): string {
	// ponytail: hash everything the model actually sees. If the system prompt,
	// the tool schemas or the message history change, the hash changes and the
	// cassette is flagged stale — that is the signal to re-record.
	//
	// Ids MUST be normalized first: tool results echo freshly minted
	// `trim_<uuid>` / `zoom_<uuid>` ids back into the next request, so a raw
	// hash marks every cassette stale on the very first replay.
	const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
	const tools = (body.tools ?? []) as Array<{ function?: { name?: string } }>;
	const canonical = JSON.stringify(
		normalizeIds({
			messages: messages.map((m) => ({ role: m.role, content: m.content, tc: m.tool_calls })),
			tools: tools.map((t) => t.function?.name),
		}),
	);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function digestOf(body: Record<string, unknown>): CassetteRound["digest"] {
	const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	return {
		systemChars: JSON.stringify(messages[0]?.content ?? "").length,
		toolCount: ((body.tools ?? []) as unknown[]).length,
		roles: messages.map((m) => String(m.role)),
		lastUserText: String(lastUser?.content ?? "").slice(0, 120),
	};
}

export function readCassette(file: string): Cassette {
	return JSON.parse(readFileSync(file, "utf8")) as Cassette;
}

export function writeCassette(file: string, cassette: Cassette): void {
	const payload = `${JSON.stringify(cassette, null, "\t")}\n`;
	// ponytail: the recorder proxies an Authorization header it never parses,
	// but a provider that echoed one back into an error body would put it in
	// this file, and cassettes are versioned. Refuse the write rather than
	// scrub it — a scrubbed cassette hides that the leak path exists.
	if (containsSecret(payload)) {
		throw new Error(`refus d'écrire la cassette ${file} : le blob contient une valeur secrète`);
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, payload, "utf8");
}

export function cassetteExists(file: string): boolean {
	return existsSync(file);
}

/**
 * Transparent proxy in front of the real provider. `upstream` is the provider's
 * base URL; the app is pointed at THIS server's url instead.
 *
 * It is not an optimisation, it is the live layer's evidence path. Point the
 * app straight at the provider and `model.requests` stays empty, which means
 * `wireFromRequests` sees no tool calls at all — and a DSL check that asks
 * "did it call anything mutating?" would then pass for the worst possible
 * reason. Every live repetition goes through here.
 *
 * `file` is optional: omit it to proxy without writing a cassette.
 */
export async function startRecorder(options: {
	upstream: string;
	file?: string;
	scenario: string;
	provider: string;
	model: string;
}): Promise<ModelServerHandle> {
	const requests: CapturedRequest[] = [];
	const rounds: CassetteRound[] = [];
	let round = 0;

	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", async () => {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(body) as Record<string, unknown>;
			} catch {
				res.writeHead(400, { "content-type": "application/json" });
				res.end('{"error":"workbench proxy: request body is not JSON"}');
				return;
			}
			const myRound = round;
			round += 1;
			requests.push({
				round: myRound,
				systemChars: digestOf(parsed).systemChars,
				toolNames: ((parsed.tools ?? []) as Array<{ function?: { name?: string } }>).map(
					(t) => t.function?.name ?? "?",
				),
				messages: [],
				raw: parsed,
			});

			// ponytail: pass the inbound Authorization header straight through.
			// The workbench never parses it, never logs it, never persists it.
			const auth = req.headers.authorization;
			const upstreamRes = await fetch(`${options.upstream}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(auth ? { authorization: auth } : {}),
				},
				body,
			});
			const sse = await upstreamRes.text();
			rounds.push({
				round: myRound,
				requestHash: hashRequest(parsed),
				digest: digestOf(parsed),
				sse,
			});
			if (options.file) {
				writeCassette(options.file, {
					scenario: options.scenario,
					provider: options.provider,
					model: options.model,
					recordedAt: new Date().toISOString(),
					rounds: [...rounds].sort((a, b) => a.round - b.round),
				});
			}
			res.writeHead(upstreamRes.status, { "content-type": "text/event-stream" });
			res.end(sse);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("recorder has no address");
	return { url: `http://127.0.0.1:${addr.port}/v1`, requests, close: () => server.close() };
}

export interface ReplayHandle extends ModelServerHandle {
	staleRounds: number[];
	/** Throws when any round went stale. Called by the runner under WB_STRICT. */
	assertFresh: () => void;
}

/** ponytail: a stale cassette is a silent liar — it answers a question the app
 * no longer asks. `staleRounds` alone is a field a caller can forget to read,
 * so `WB_STRICT=1` (or `onStale: "throw"`) turns it into a hard failure. */
export function strictReplayRequested(): boolean {
	return process.env.WB_STRICT === "1";
}

export async function startReplay(options: {
	file: string;
	onStale?: "warn" | "throw";
}): Promise<ReplayHandle> {
	const cassette = readCassette(options.file);
	const requests: CapturedRequest[] = [];
	const staleRounds: number[] = [];
	let round = 0;

	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body) as Record<string, unknown>;
			const myRound = round;
			round += 1;
			const stored = cassette.rounds[myRound];
			requests.push({
				round: myRound,
				systemChars: digestOf(parsed).systemChars,
				toolNames: ((parsed.tools ?? []) as Array<{ function?: { name?: string } }>).map(
					(t) => t.function?.name ?? "?",
				),
				messages: [],
				raw: parsed,
			});
			if (!stored) {
				// ponytail: the model asked for more rounds than were recorded —
				// close the turn with an explicit marker rather than hanging.
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(
					`data: ${JSON.stringify({
						id: `stale-${myRound}`,
						object: "chat.completion.chunk",
						created: 0,
						model: cassette.model,
						choices: [
							{
								index: 0,
								delta: { content: "[workbench: cassette exhausted]" },
								finish_reason: "stop",
							},
						],
					})}\n\ndata: [DONE]\n\n`,
				);
				staleRounds.push(myRound);
				return;
			}
			if (hashRequest(parsed) !== stored.requestHash) staleRounds.push(myRound);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(stored.sse);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("replay has no address");
	const strict = options.onStale === "throw" || strictReplayRequested();
	return {
		url: `http://127.0.0.1:${addr.port}/v1`,
		requests,
		staleRounds,
		assertFresh: () => {
			if (staleRounds.length === 0) return;
			const message =
				`cassette ${options.file} périmée aux rounds ${staleRounds.join(", ")} — ` +
				"le prompt système, les schémas d'outils ou l'historique ont changé ; ré-enregistrez-la.";
			if (strict) throw new Error(message);
			process.stderr.write(`[workbench] ${message}\n`);
		},
		close: () => server.close(),
	};
}
