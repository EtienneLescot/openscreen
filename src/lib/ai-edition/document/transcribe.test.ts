import { describe, expect, it } from "vitest";
import type { AxcutTranscript } from "../schema";
import { toAxcutTranscriptDsl } from "./transcribe";

describe("toAxcutTranscriptDsl", () => {
	it("emits the AXCUT_TRANSCRIPT v1 header + META + segments + words", () => {
		const transcript: AxcutTranscript = {
			assetId: "asset_1",
			language: "en",
			segments: [
				{
					id: "seg_1",
					kind: "speech",
					startSec: 0,
					endSec: 1.2,
					text: "okay so let's",
					wordIds: ["word_1", "word_2", "word_3"],
				},
			],
			words: [
				{ id: "word_1", segmentId: "seg_1", startSec: 0, endSec: 0.4, text: "okay" },
				{ id: "word_2", segmentId: "seg_1", startSec: 0.4, endSec: 0.7, text: "so" },
				{ id: "word_3", segmentId: "seg_1", startSec: 0.7, endSec: 1.2, text: "let's" },
			],
		};

		const dsl = toAxcutTranscriptDsl(transcript, "demo.mp4", 1.2);
		const lines = dsl.split("\n");

		expect(lines[0]).toBe("AXCUT_TRANSCRIPT v1");
		expect(lines[1]).toBe(
			'META source_video="demo.mp4" duration=1.200 language="en" kind="source"',
		);
		expect(lines).toContain(`SEGMENT id=s0001 start=0.000 end=1.200 text="okay so let''s"`);
		expect(lines).toContain('WORD id=w000001 segment=s0001 start=0.000 end=0.400 text="okay"');
		expect(lines).toContain('WORD id=w000002 segment=s0001 start=0.400 end=0.700 text="so"');
		expect(lines).toContain(`WORD id=w000003 segment=s0001 start=0.700 end=1.200 text="let''s"`);
		expect(lines.at(-1)).toBe("ENDSEGMENT");
	});

	it("escapes quotes in segment/word text (both kinds)", () => {
		const transcript: AxcutTranscript = {
			assetId: "asset_1",
			language: "auto",
			segments: [
				{
					id: "seg_1",
					kind: "speech",
					startSec: 0,
					endSec: 1,
					text: 'he said "hi"',
					wordIds: ["word_1"],
				},
			],
			words: [{ id: "word_1", segmentId: "seg_1", startSec: 0, endSec: 1, text: "let's" }],
		};

		const dsl = toAxcutTranscriptDsl(transcript);
		expect(dsl).toContain(`text="he said ""hi"""`);
		expect(dsl).toContain(`text="let''s"`);
	});

	it("omits duration when not provided", () => {
		const transcript: AxcutTranscript = {
			assetId: "asset_1",
			language: "fr",
			segments: [],
			words: [],
		};

		const dsl = toAxcutTranscriptDsl(transcript, "x.mp4");
		expect(dsl).toBe('AXCUT_TRANSCRIPT v1\nMETA source_video="x.mp4" language="fr" kind="source"');
	});
});
