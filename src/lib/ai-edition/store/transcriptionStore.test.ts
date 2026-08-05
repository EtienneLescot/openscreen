// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutDocument, AxcutTranscript } from "../schema";
import { useProjectStore } from "./projectStore";
import { useTranscriptionStore, whenTranscriptionIdle } from "./transcriptionStore";

const bridgeMocks = vi.hoisted(() => ({
	save: vi.fn(),
}));

const transcribeMocks = vi.hoisted(() => ({
	transcribeAsset: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: { save: bridgeMocks.save } },
}));

vi.mock("../document/transcribe", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../document/transcribe")>();
	return { ...actual, transcribeAsset: transcribeMocks.transcribeAsset };
});

vi.mock("sonner", () => ({ toast: { success: toastMocks.success, error: toastMocks.error } }));

function asset(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		kind: "video" as const,
		label: `${id}.mp4`,
		originalPath: `/tmp/${id}.mp4`,
		cameraTrack: null,
		...extra,
	};
}

function makeDoc(assetIds: string[], projectId = "proj_1"): AxcutDocument {
	return {
		schemaVersion: 7,
		project: {
			id: projectId,
			title: "Test",
			createdAt: "2026-06-25T10:00:00.000Z",
			updatedAt: "2026-06-25T10:00:00.000Z",
			primaryAssetId: assetIds[0],
		},
		assets: assetIds.map((id) => asset(id)),
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
	} as unknown as AxcutDocument;
}

function transcriptFor(assetId: string): AxcutTranscript {
	return {
		assetId,
		language: "en",
		segments: [
			{ id: "seg_1", kind: "speech", startSec: 0, endSec: 1, text: "hello", wordIds: ["word_1"] },
		],
		words: [{ id: "word_1", segmentId: "seg_1", startSec: 0, endSec: 1, text: "hello" }],
	};
}

/** A promise plus a 0-arg release, so a mocked run can be held open mid-flight. */
function deferred(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => {
		// Replaced synchronously by the executor below, before this can be called.
	};
	const promise = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	return { promise, release: () => release() };
}

/** Loads a document into the project store the way `loadProject` would. */
function loadDocument(document: AxcutDocument) {
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		status: "ready",
		error: null,
		dirty: false,
	});
}

describe("useTranscriptionStore", () => {
	beforeEach(() => {
		useTranscriptionStore.getState().reset();
		useProjectStore.getState().clear();
		bridgeMocks.save.mockReset();
		// The bridge echoes back whatever it was handed, like a successful save.
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		transcribeMocks.transcribeAsset.mockReset();
		toastMocks.success.mockReset();
		toastMocks.error.mockReset();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the preload bridge
		(window as any).electronAPI = { stt: { transcribe: vi.fn() } };
	});

	afterEach(() => {
		vi.clearAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the preload bridge
		delete (window as any).electronAPI;
	});

	it("transcribes every asset that has no transcript, one at a time", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Promise.resolve();
				inFlight -= 1;
				return transcriptFor(assetId);
			},
		);
		loadDocument(makeDoc(["asset_1", "asset_2"]));

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(maxInFlight).toBe(1);
		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(2);
		expect(
			useProjectStore
				.getState()
				.document?.transcripts.map((t) => t.assetId)
				.sort(),
		).toEqual(["asset_1", "asset_2"]);
		expect(useTranscriptionStore.getState().jobs).toEqual({});
		// The background pass stays quiet on success.
		expect(toastMocks.success).not.toHaveBeenCalled();
	});

	it("does not re-enqueue an asset whose transcript it just wrote", async () => {
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));

		const { sync } = useTranscriptionStore.getState();
		sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		// Every document change re-runs sync in the shell — this is the loop guard.
		sync(useProjectStore.getState().document);
		sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
		expect(useTranscriptionStore.getState().jobs).toEqual({});
	});

	it("remembers a no-audio verdict on the asset and never retries it by itself", async () => {
		transcribeMocks.transcribeAsset.mockRejectedValue(
			new Error("No audio track found in this video."),
		);
		loadDocument(makeDoc(["asset_1"]));

		const { sync } = useTranscriptionStore.getState();
		sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		const job = useTranscriptionStore.getState().jobs.asset_1;
		expect(job?.status).toBe("failed");
		expect(job?.failure?.kind).toBe("no-audio");
		expect(useProjectStore.getState().document?.assets[0].transcriptionFailure?.kind).toBe(
			"no-audio",
		);
		// Silence is an expected outcome, not an incident.
		expect(toastMocks.error).not.toHaveBeenCalled();

		sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();
		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
	});

	it("skips an asset that already carries a persisted failure on a fresh load", async () => {
		const doc = makeDoc(["asset_1"]);
		loadDocument({
			...doc,
			assets: [
				asset("asset_1", { transcriptionFailure: { kind: "no-audio", message: "silent" } }),
			] as AxcutDocument["assets"],
		});

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(transcribeMocks.transcribeAsset).not.toHaveBeenCalled();
		expect(useTranscriptionStore.getState().jobs).toEqual({});
	});

	it("keeps a transient failure in memory only, and toasts it", async () => {
		transcribeMocks.transcribeAsset.mockRejectedValue(new Error("whisper-server exited"));
		loadDocument(makeDoc(["asset_1"]));

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(useTranscriptionStore.getState().jobs.asset_1?.failure?.kind).toBe("error");
		expect(useProjectStore.getState().document?.assets[0].transcriptionFailure).toBeUndefined();
		expect(toastMocks.error).toHaveBeenCalledTimes(1);
	});

	it("stops the queue on an engine failure instead of failing each asset in turn", async () => {
		// The model download died / whisper-server didn't come up: that verdict is
		// about the engine, so the remaining assets inherit it rather than each
		// spending a full retry budget and stacking an identical toast.
		transcribeMocks.transcribeAsset.mockRejectedValue(new Error("whisper-server exited"));
		loadDocument(makeDoc(["asset_1", "asset_2", "asset_3"]));

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
		const jobs = useTranscriptionStore.getState().jobs;
		expect(Object.values(jobs).map((j) => j.status)).toEqual(["failed", "failed", "failed"]);
		expect(jobs.asset_3?.failure?.message).toBe("whisper-server exited");
		expect(toastMocks.error).toHaveBeenCalledTimes(1);
	});

	it("request() re-runs a failed asset and clears the remembered verdict", async () => {
		transcribeMocks.transcribeAsset.mockRejectedValueOnce(
			new Error("No audio track found in this video."),
		);
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();
		expect(useProjectStore.getState().document?.assets[0].transcriptionFailure?.kind).toBe(
			"no-audio",
		);

		await useTranscriptionStore.getState().request("asset_1", "fr");

		expect(transcribeMocks.transcribeAsset).toHaveBeenLastCalledWith(
			expect.anything(),
			"asset_1",
			expect.objectContaining({ language: "fr" }),
		);
		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
		expect(useProjectStore.getState().document?.assets[0].transcriptionFailure).toBeNull();
		expect(useTranscriptionStore.getState().jobs).toEqual({});
		// A run the user asked for reports back.
		expect(toastMocks.success).toHaveBeenCalledTimes(1);
	});

	it("drops the queue when another project is loaded", async () => {
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		const other = makeDoc(["asset_9"], "proj_2");
		loadDocument(other);
		useTranscriptionStore.getState().sync(other);
		expect(useTranscriptionStore.getState().projectId).toBe("proj_2");
		await whenTranscriptionIdle();

		expect(useProjectStore.getState().document?.transcripts.map((t) => t.assetId)).toEqual([
			"asset_9",
		]);
	});

	it("forgets a job when its asset leaves the document", async () => {
		transcribeMocks.transcribeAsset.mockRejectedValue(new Error("whisper-server exited"));
		loadDocument(makeDoc(["asset_1", "asset_2"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();
		expect(Object.keys(useTranscriptionStore.getState().jobs)).toEqual(["asset_1", "asset_2"]);

		const doc = useProjectStore.getState().document as AxcutDocument;
		const pruned = { ...doc, assets: doc.assets.filter((a) => a.id === "asset_1") };
		loadDocument(pruned);
		useTranscriptionStore.getState().sync(pruned);

		expect(Object.keys(useTranscriptionStore.getState().jobs)).toEqual(["asset_1"]);
	});

	it("runs no background pass without a local STT engine", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the preload bridge
		delete (window as any).electronAPI;
		loadDocument(makeDoc(["asset_1"]));

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(transcribeMocks.transcribeAsset).not.toHaveBeenCalled();
		expect(useTranscriptionStore.getState().jobs).toEqual({});
	});

	it("lets a manual request supersede the background run of the same asset", async () => {
		// The background pass is mid-run on asset_1 (auto language) when the user
		// asks for French from the media card. The outgoing run must neither win
		// the race nor delete the request that replaced it.
		const languages: string[] = [];
		const firstRun = deferred();
		transcribeMocks.transcribeAsset.mockImplementation(
			async (
				_doc: AxcutDocument,
				assetId: string,
				options: { language?: string; signal?: AbortSignal },
			) => {
				languages.push(options.language ?? "auto");
				if (languages.length === 1) {
					await firstRun.promise;
					throw new DOMException("Aborted", "AbortError");
				}
				return { ...transcriptFor(assetId), language: options.language ?? "auto" };
			},
		);
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await Promise.resolve();
		expect(useTranscriptionStore.getState().jobs.asset_1?.status).toBe("running");

		const requested = useTranscriptionStore.getState().request("asset_1", "fr");
		expect(useTranscriptionStore.getState().jobs.asset_1?.status).toBe("queued");
		firstRun.release();
		await requested;
		await whenTranscriptionIdle();

		expect(languages).toEqual(["auto", "fr"]);
		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
		expect(useProjectStore.getState().document?.transcripts[0].language).toBe("fr");
		expect(useTranscriptionStore.getState().jobs).toEqual({});
	});

	it("requestTimelineTranscripts covers the timeline's media, skipping the silent ones", async () => {
		// The pane button used to target `primaryAssetId` only — which in a
		// recording project is the (often silent) screen capture, leaving the
		// talking clip next to it untranscribable from there.
		// The background pass is off here so the assertions see only what the
		// button itself asked for.
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the preload bridge
		delete (window as any).electronAPI;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		const doc = makeDoc(["silent", "voice", "offTimeline"]);
		loadDocument({
			...doc,
			assets: [
				asset("silent", { transcriptionFailure: { kind: "no-audio", message: "silent" } }),
				asset("voice"),
				asset("offTimeline"),
			],
			timeline: {
				...doc.timeline,
				clips: ["silent", "voice"].map((assetId, i) => ({
					id: `clip_${i}`,
					assetId,
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: i * 10,
					timelineEndSec: i * 10 + 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				})),
			},
		} as unknown as AxcutDocument);

		await useTranscriptionStore.getState().requestTimelineTranscripts();

		expect(transcribeMocks.transcribeAsset.mock.calls.map((c) => c[1])).toEqual(["voice"]);
		expect(useProjectStore.getState().document?.transcripts.map((t) => t.assetId)).toEqual([
			"voice",
		]);
	});

	it("waits for the background run instead of transcribing the same asset twice", async () => {
		const firstRun = deferred();
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => {
				await firstRun.promise;
				return transcriptFor(assetId);
			},
		);
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await Promise.resolve();
		expect(useTranscriptionStore.getState().jobs.asset_1?.status).toBe("running");

		const requested = useTranscriptionStore.getState().requestTimelineTranscripts();
		firstRun.release();
		await requested;

		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
	});

	it("still honours a manual request without the auto pass", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the preload bridge
		delete (window as any).electronAPI;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));

		await useTranscriptionStore.getState().request("asset_1");

		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
	});
});
