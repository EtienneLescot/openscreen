import { beforeEach, describe, expect, it, vi } from "vitest";
import { STT_NATIVE_EXTRACTION_UNAVAILABLE } from "../../../../electron/stt/transcriptionContract";
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
	transcribeSourceFileToSegments: vi.fn(),
}));

const { extractMono16kFromVideoUrl, transcribeMono16kToSegments, transcribeSourceFileToSegments } =
	await import("@/lib/captioning");
// `transcribeAsset` sends the PATH now and lets the main process decode; the samples
// entry point is only reached when no ffmpeg can be resolved. The assertions below
// therefore target the native call, and the fallback has tests of its own at the end.
const transcribeMock = vi.mocked(transcribeSourceFileToSegments);
const rendererMock = vi.mocked(transcribeMono16kToSegments);
const extractMock = vi.mocked(extractMono16kFromVideoUrl);

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
		audioTracks: [],
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

describe("transcribeAsset native extraction", () => {
	// Call counts are the assertion here, so they start from zero every test —
	// `mockResolvedValueOnce` queues a result, it does not clear the history.
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("hands the main process a path instead of decoding in the renderer", async () => {
		// The point of the change: the renderer must not touch the audio at all on the
		// happy path. `extractMono16kFromVideoUrl` reads the whole file, copies it twice
		// and resamples on the UI thread — that is the freeze this avoids.
		transcribeMock.mockResolvedValueOnce({
			segments: [{ startSec: 0, endSec: 1, text: "hi" }],
			granularity: "word",
			detectedLanguage: "en",
		});
		await transcribeAsset(makeDoc(), "asset_1");
		expect(transcribeMock).toHaveBeenCalledWith("/tmp/demo.mp4", expect.anything());
		expect(extractMock).not.toHaveBeenCalled();
		expect(rendererMock).not.toHaveBeenCalled();
	});

	it("falls back to the renderer decode when the install has no ffmpeg", async () => {
		// A dev checkout that never fetched ffmpeg, or a platform build missing it, must
		// still transcribe rather than lose the feature.
		transcribeMock.mockRejectedValueOnce(
			new Error(`${STT_NATIVE_EXTRACTION_UNAVAILABLE}: no ffmpeg binary`),
		);
		rendererMock.mockResolvedValueOnce({
			segments: [{ startSec: 0, endSec: 1, text: "hi" }],
			granularity: "word",
			detectedLanguage: "en",
		});
		const transcript = await transcribeAsset(makeDoc(), "asset_1");
		expect(extractMock).toHaveBeenCalled();
		expect(rendererMock).toHaveBeenCalled();
		expect(transcript.segments.length).toBeGreaterThan(0);
	});

	it("does NOT fall back on any other failure", async () => {
		// "This file has no audio" is a verdict. Re-deriving it in the renderer would buy
		// the same answer for the price of the decode this change exists to avoid.
		transcribeMock.mockRejectedValueOnce(new Error("No decodable audio in /tmp/demo.mp4"));
		await expect(transcribeAsset(makeDoc(), "asset_1")).rejects.toThrow("No decodable audio");
		expect(extractMock).not.toHaveBeenCalled();
		expect(rendererMock).not.toHaveBeenCalled();
	});
});
