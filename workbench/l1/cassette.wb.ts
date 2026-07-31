// L1 — record/replay. The recorder is what makes a live run reusable: once a
// turn is on tape, the same agent loop, the same prompt and the same tool
// schemas can be re-run offline in milliseconds.
//
// The two things that must hold: a replay reproduces the recorded document
// exactly, and a cassette that no longer matches the request says so instead of
// answering a question the app no longer asks.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readCassette, startRecorder, startReplay, writeCassette } from "../lib/cassette";
import { ENV_KEYS } from "../lib/env";
import { singleClip } from "../lib/fixtures";
import { normalizeIds, runScenario } from "../lib/harness";
import { startScriptedModel } from "../lib/model-server";

const DIRECTORY = mkdtempSync(join(tmpdir(), "wb-cassette-"));
const FILE = join(DIRECTORY, "wizard.json");
const PROMPT = "enhance this recording";

afterAll(() => rmSync(DIRECTORY, { recursive: true, force: true }));

async function record() {
	// ponytail: stands in for the real provider. Live, `upstream` is the
	// provider base URL and the key rides through in the header the app already
	// set — the recorder forwards it without parsing it.
	const upstream = await startScriptedModel([
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{
			kind: "tools",
			calls: [
				{ name: "addZoom", args: { startSec: 3, endSec: 5, depth: 3 } },
				{ name: "addTrim", args: { startSec: 12, endSec: 14 } },
			],
		},
		{ kind: "text", text: "Added a zoom at 3s and cut 12-14s." },
	]);
	const recorder = await startRecorder({
		upstream: upstream.url,
		file: FILE,
		scenario: "wizard-enhance",
		provider: "openai-compatible",
		model: "fake-upstream",
	});
	try {
		return await runScenario({
			label: "cassette-record",
			prompt: PROMPT,
			document: singleClip(),
			endpoint: recorder,
		});
	} finally {
		recorder.close();
		upstream.close();
	}
}

describe("record then replay", () => {
	it("replaying reproduces the recorded document exactly", async () => {
		const recorded = await record();
		expect(recorded.ok).toBe(true);

		const replay = await startReplay({ file: FILE });
		let replayed: Awaited<ReturnType<typeof runScenario>>;
		try {
			replayed = await runScenario({
				label: "cassette-replay",
				prompt: PROMPT,
				document: singleClip(),
				endpoint: replay,
			});
		} finally {
			replay.close();
		}

		expect(replay.staleRounds).toEqual([]);
		expect(replayed.answer).toBe(recorded.answer);
		// Ids are freshly minted uuids on both sides, hence the normalization.
		expect(normalizeIds(replayed.document?.zoomRanges)).toEqual(
			normalizeIds(recorded.document?.zoomRanges),
		);
		expect(normalizeIds(replayed.document?.timeline.trimRanges)).toEqual(
			normalizeIds(recorded.document?.timeline.trimRanges),
		);
		// The wire transcript survives the round trip — that is what makes an
		// offline re-score of the DSL axis meaningful.
		expect(replayed.wire.calls.map((c) => c.name)).toEqual(recorded.wire.calls.map((c) => c.name));
	});

	it("never puts an authorization header on disk", () => {
		const cassette = readCassette(FILE);
		const blob = JSON.stringify(cassette);
		expect(blob).not.toContain("Bearer");
		expect(blob).not.toContain("authorization");
	});

	it("refuses to write a cassette carrying the key", () => {
		const saved = process.env[ENV_KEYS.apiKey];
		process.env[ENV_KEYS.apiKey] = "wb-not-a-real-key-0123456789";
		try {
			expect(() =>
				writeCassette(join(DIRECTORY, "leak.json"), {
					scenario: "leak",
					provider: "openai-compatible",
					model: "m",
					recordedAt: "2026-07-31",
					rounds: [
						{
							round: 0,
							requestHash: "x",
							digest: { systemChars: 0, toolCount: 0, roles: [], lastUserText: "" },
							sse: "data: wb-not-a-real-key-0123456789\n\n",
						},
					],
				}),
			).toThrow(/refus d'écrire la cassette/);
		} finally {
			if (saved === undefined) delete process.env[ENV_KEYS.apiKey];
			else process.env[ENV_KEYS.apiKey] = saved;
		}
	});

	it("marks a changed prompt as stale instead of answering the old question", async () => {
		const replay = await startReplay({ file: FILE });
		try {
			await runScenario({
				label: "cassette-stale",
				prompt: "a completely different request",
				document: singleClip(),
				endpoint: replay,
			});
		} finally {
			replay.close();
		}
		expect(replay.staleRounds.length).toBeGreaterThan(0);
		// A field nobody reads is not a guard; assertFresh is the enforceable form.
		expect(() => replay.assertFresh()).not.toThrow();
	});

	it("turns staleness into a hard failure under strict mode", async () => {
		const replay = await startReplay({ file: FILE, onStale: "throw" });
		try {
			await runScenario({
				label: "cassette-strict",
				prompt: "yet another request",
				document: singleClip(),
				endpoint: replay,
			});
		} finally {
			replay.close();
		}
		expect(() => replay.assertFresh()).toThrow(/périmée aux rounds/);
	});
});
