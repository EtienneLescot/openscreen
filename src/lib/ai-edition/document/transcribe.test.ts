import { describe, expect, it, vi } from "vitest";
import type { AxcutDocument, AxcutTranscript } from "../schema";
import { toAxcutTranscriptDsl, transcribeAsset } from "./transcribe";

vi.mock("@/components/video-editor/projectPersistence", () => ({
	toFileUrl: (path: string) => `file://${path}`,
}));

vi.mock("@/lib/captioning", () => ({
	extractMono16kFromVideoUrl: vi.fn(async () => ({
		samples: new Float32Array([0, 0, 0]),
		sampleRate: 16_000,
	})),
	transcribeMono16kToSegments: vi.fn(),
}));

const { transcribeMono16kToSegments } = await import("@/lib/captioning");
const transcribeMock = vi.mocked(transcribeMono16kToSegments);

function makeDoc(): AxcutDocument {
	return {
		schemaVersion: 3,
		project: {
			id: "proj_1",
			title: "Test",
			createdAt: "2026-07-03T00:00:00Z",
			updatedAt: "2026-07-03T00:00:00Z",
			primaryAssetId: "asset_1",
		},
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "demo.mp4",
				originalPath: "/tmp/demo.mp4",
				durationSec: 60,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			id: "tl_1",
			clips: [],
			gaps: [],
			operations: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		agent: null,
		preview: { revision: 0, playbackRate: 1 },
		export: null,
		history: { revisions: [] },
	};
}

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

describe("transcribeAsset language handling", () => {
	it("forwards a forced language to the worker and stores it on the transcript", async () => {
		transcribeMock.mockResolvedValueOnce({
			segments: [{ startSec: 0, endSec: 1, text: "bonjour" }],
			granularity: "phrase",
			detectedLanguage: "fr",
		});

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1", { language: "fr" });

		// The forced ISO code reaches the underlying worker call.
		expect(transcribeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ language: "fr" }),
		);
		// The stored transcript reports the model-confirmed language.
		expect(t.language).toBe("fr");
	});

	it("omits the language option from the worker call when 'auto' so Whisper detects", async () => {
		transcribeMock.mockResolvedValueOnce({
			segments: [{ startSec: 0, endSec: 1, text: "hello" }],
			granularity: "phrase",
			detectedLanguage: "en",
		});

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1", { language: "auto" });

		expect(transcribeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ language: undefined }),
		);
		expect(t.language).toBe("en");
	});

	it("captures Whisper's auto-detected language when no option was passed", async () => {
		transcribeMock.mockResolvedValueOnce({
			segments: [{ startSec: 0, endSec: 1, text: "hola" }],
			granularity: "phrase",
			detectedLanguage: "es",
		});

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1");

		expect(transcribeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ language: undefined }),
		);
		expect(t.language).toBe("es");
	});

	it("falls back to 'auto' when the model reports no language token", async () => {
		transcribeMock.mockResolvedValueOnce({
			segments: [],
			granularity: "phrase",
			detectedLanguage: null,
		});

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1");

		expect(t.language).toBe("auto");
	});
});
