import { describe, expect, it, vi } from "vitest";
import { type AxcutDocument, axcutSchemaVersion } from "../schema";
import { transcribeAsset } from "./transcribe";

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
		schemaVersion: axcutSchemaVersion,
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
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	};
}

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
