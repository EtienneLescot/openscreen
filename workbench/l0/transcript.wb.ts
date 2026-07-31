// L0 — the door a real Whisper transcript walks through.
//
// The loader is the piece nobody will look at again once a real take is
// injected, and the piece whose silent failure would be least visible: a shape
// it does not recognise produces zero words, `speechSpans` falls back to
// segments, and every editorial number quietly goes back to being a property of
// the fixture. Hence a test per accepted shape, and a test for the refusal.

import { describe, expect, it } from "vitest";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import { speechSpans } from "../lib/editorial";
import { DEMO_SPEECH_SPANS, recordingWithWordTimings } from "../lib/fixtures";
import { totalSec } from "../lib/spans";
import {
	DEFAULT_SILENCE_MIN_SEC,
	synthesizeWords,
	transcriptFromWhisper,
	transcriptFromWords,
	wordSpans,
	wordsFromWhisper,
} from "../lib/transcript";

describe("wordsFromWhisper", () => {
	it("reads OpenAI / faster-whisper verbose_json", () => {
		const loaded = wordsFromWhisper({
			language: "en",
			segments: [
				{
					start: 0,
					end: 1.5,
					text: " Hello world.",
					words: [
						{ word: " Hello", start: 0, end: 0.8, probability: 0.95 },
						{ word: " world.", start: 0.8, end: 1.5, probability: 0.91 },
					],
				},
			],
		});
		expect(loaded.timingSource).toBe("word");
		expect(loaded.language).toBe("en");
		expect(loaded.words).toEqual([
			{ text: "Hello", startSec: 0, endSec: 0.8, confidence: 0.95 },
			{ text: "world.", startSec: 0.8, endSec: 1.5, confidence: 0.91 },
		]);
	});

	it("reads OpenScreen's own SttResult word segments", () => {
		// `electron/stt/index.ts:104` — the shape the app already produces.
		const loaded = wordsFromWhisper({
			wordSegments: [
				{ word: "Thank", startSec: 5.51, endSec: 6.85, confidence: 0.9 },
				{ word: "you", startSec: 6.85, endSec: 8.98, confidence: 0.9 },
			],
		});
		expect(loaded.timingSource).toBe("word");
		expect(loaded.words.map((w) => w.text)).toEqual(["Thank", "you"]);
	});

	it("reads whisper.cpp tokens, whose offsets are milliseconds", () => {
		const loaded = wordsFromWhisper({
			transcription: [
				{
					offsets: { from: 1200, to: 2400 },
					text: " drag it",
					tokens: [
						{ offsets: { from: 1200, to: 1900 }, text: " drag" },
						{ offsets: { from: 1900, to: 2400 }, text: " it" },
					],
				},
			],
		});
		expect(loaded.timingSource).toBe("word");
		expect(loaded.words[0]).toEqual({ text: "drag", startSec: 1.2, endSec: 1.9 });
	});

	it("labels an even split as what it is", () => {
		const loaded = wordsFromWhisper({
			segments: [{ start: 0, end: 3, text: "one two three" }],
		});
		expect(loaded.timingSource).toBe("segment");
		expect(loaded.words.map((w) => w.startSec)).toEqual([0, 1, 2]);
	});

	it("gives a clipped word a frame rather than a zero-length span", () => {
		// A zero-length word disappears from every span union, which would make
		// it invisible to `speechDamage` — the one place it must not be.
		const loaded = wordsFromWhisper({ words: [{ word: "ah", start: 4, end: 4 }] });
		expect(loaded.words[0].endSec).toBeGreaterThan(loaded.words[0].startSec);
	});
});

describe("transcriptFromWhisper", () => {
	const evenlySplit = { segments: [{ start: 0, end: 3, text: "one two three" }] };

	it("refuses fabricated precision unless it is asked for in writing", () => {
		expect(() => transcriptFromWhisper(evenlySplit, { assetId: "asset_1" })).toThrow(
			/aucun horodatage par mot/,
		);
		expect(() =>
			transcriptFromWhisper(evenlySplit, { assetId: "asset_1", allowSegmentSplit: true }),
		).not.toThrow();
	});

	it("refuses a file it found nothing in, rather than returning an empty transcript", () => {
		// Silence here would be the worst outcome: an empty transcript reads as
		// "this take has no speech", and every damage oracle then reports 0.
		expect(() => transcriptFromWhisper({ segments: [] }, { assetId: "asset_1" })).toThrow(
			/sans aucun mot exploitable/,
		);
	});
});

describe("transcriptFromWords", () => {
	it("groups words into speech and materialises the gaps as silence", () => {
		const transcript = transcriptFromWords({
			assetId: "asset_1",
			durationSec: 12,
			words: [
				{ text: "one", startSec: 0.4, endSec: 0.9 },
				{ text: "two", startSec: 0.95, endSec: 1.4 },
				// 2.6 s of nothing — a silence.
				{ text: "three", startSec: 4, endSec: 4.6 },
			],
		});
		expect(transcript.segments.map((s) => s.kind)).toEqual([
			"silence",
			"speech",
			"silence",
			"speech",
			"silence",
		]);
		const silence = transcript.segments.filter((s) => s.kind === "silence");
		expect(silence[1]).toMatchObject({ startSec: 1.4, endSec: 4 });
		// The trailing silence only exists because a duration was given.
		expect(silence[2]).toMatchObject({ startSec: 4.6, endSec: 12 });
	});

	it("does not cut a segment on an inter-word breath", () => {
		const transcript = transcriptFromWords({
			assetId: "asset_1",
			words: [
				{ text: "one", startSec: 0, endSec: 0.5 },
				{ text: "two", startSec: 0.5 + DEFAULT_SILENCE_MIN_SEC / 2, endSec: 1.2 },
			],
		});
		expect(transcript.segments.filter((s) => s.kind === "speech")).toHaveLength(1);
	});

	it("links every word to the segment that owns it", () => {
		const transcript = transcriptFromWords({
			assetId: "asset_1",
			words: synthesizeWords({ speech: [[0, 4]] }),
		});
		const segment = transcript.segments.find((s) => s.kind === "speech");
		if (!segment) throw new Error("aucun segment de parole");
		expect(segment.wordIds).toHaveLength(transcript.words.length);
		for (const word of transcript.words) expect(word.segmentId).toBe(segment.id);
	});
});

describe("synthesizeWords", () => {
	it("is deterministic — a fixture must be the same document twice", () => {
		expect(synthesizeWords({ speech: [[0, 5]] })).toEqual(synthesizeWords({ speech: [[0, 5]] }));
	});

	it("stays inside the spans it was given, and off the grid", () => {
		const words = synthesizeWords({ speech: [[2, 6]] });
		expect(words[0].startSec).toBe(2);
		expect(words.at(-1)?.endSec).toBeCloseTo(6, 6);
		// If every boundary landed on a round number the fixture would be back to
		// declaring the answer it is supposed to measure.
		expect(words.some((w) => Math.abs(w.startSec - Math.round(w.startSec * 10) / 10) > 1e-4)).toBe(
			true,
		);
	});
});

describe("the demonstration fixture", () => {
	it("parses, carries real words, and keeps its declared speech total", () => {
		const document = recordingWithWordTimings();
		expect(documentSchema.safeParse(document).success).toBe(true);
		const declared = totalSec(
			DEMO_SPEECH_SPANS.map(([startSec, endSec]) => ({ startSec, endSec })),
		);
		const spoken = document.transcripts[0].segments.filter((s) => s.kind === "speech");
		expect(spoken).toHaveLength(DEMO_SPEECH_SPANS.length);
		expect(totalSec(spoken)).toBeCloseTo(declared, 3);
		// The words do NOT fill their segments: there are breaths between them,
		// and `speechSpans` counts the voiced time rather than the segment. That
		// gap is the whole reason word timings are worth loading — a cut placed
		// in one of those breaths destroys nothing, and a segment-level oracle
		// cannot tell it from a cut through a syllable.
		const voiced = totalSec(speechSpans(document));
		expect(voiced).toBeLessThan(declared);
		expect(voiced).toBeGreaterThan(declared - 2);
		expect(totalSec(wordSpans(document.transcripts[0].words))).toBeCloseTo(voiced, 6);
	});

	it("accepts a real transcript in place of the synthetic one", () => {
		// The injection path, exercised without a file: what `loadWhisperTranscript`
		// returns is exactly what this parameter takes.
		const transcript = transcriptFromWhisper(
			{
				language: "fr",
				segments: [
					{
						start: 1.02,
						end: 2.44,
						text: "bonjour à tous",
						words: [
							{ word: "bonjour", start: 1.02, end: 1.61 },
							{ word: "à", start: 1.68, end: 1.79 },
							{ word: "tous", start: 1.83, end: 2.44 },
						],
					},
				],
			},
			{ assetId: "asset_1", durationSec: 48 },
		);
		const document = recordingWithWordTimings({ transcript, projectId: "wb_real_take" });
		expect(document.transcripts[0].language).toBe("fr");
		// Three voiced spans, not one: the 70 ms and 40 ms between the words are
		// not speech, and nothing here rounds them away.
		expect(speechSpans(document)).toEqual([
			{ startSec: 1.02, endSec: 1.61 },
			{ startSec: 1.68, endSec: 1.79 },
			{ startSec: 1.83, endSec: 2.44 },
		]);
		expect(document.transcripts[0].segments.filter((s) => s.kind === "speech")).toHaveLength(1);
	});
});
