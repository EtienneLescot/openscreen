import { describe, expect, it } from "vitest";
import type { AxcutDocument, AxcutTranscript } from "../schema";
import {
	type AssetTranscriptionView,
	assetCanCarrySpeech,
	classifyTranscriptionError,
	deriveAssetStatus,
	firstBusyView,
	firstTimelineBusyView,
	isCpuBackend,
	isModelDownloadInFlight,
	isPermanentFailure,
	progressFraction,
	realtimeSpeed,
	resolveTranscriptGate,
	transcriptHasSpeech,
	transcriptRelevantAssetIds,
} from "./status";

function transcript(assetId: string, words: string[]): AxcutTranscript {
	return {
		assetId,
		language: "en",
		segments: words.map((text, i) => ({
			id: `seg_${i}`,
			kind: "speech" as const,
			startSec: i,
			endSec: i + 1,
			text,
			wordIds: [`word_${i}`],
		})),
		words: words.map((text, i) => ({
			id: `word_${i}`,
			segmentId: `seg_${i}`,
			startSec: i,
			endSec: i + 1,
			text,
		})),
	};
}

function view(
	assetId: string,
	status: AssetTranscriptionView["status"],
	failureKind?: "no-audio" | "unsupported-audio" | "error",
): AssetTranscriptionView {
	return {
		assetId,
		status,
		failure: failureKind ? { kind: failureKind, message: `${failureKind} boom` } : undefined,
	};
}

describe("classifyTranscriptionError", () => {
	it("recognises a container with no audio track", () => {
		const failure = classifyTranscriptionError(new Error("No audio track found in this video."));
		expect(failure.kind).toBe("no-audio");
		expect(isPermanentFailure(failure.kind)).toBe(true);
	});

	it("treats a decode that yielded nothing as no-audio too", () => {
		expect(
			classifyTranscriptionError(new Error("Decoded zero audio frames from this video.")).kind,
		).toBe("no-audio");
	});

	it("recognises an audio codec the caption path cannot read", () => {
		const failure = classifyTranscriptionError(
			new Error("Audio codec not supported for captions: ac-3"),
		);
		expect(failure.kind).toBe("unsupported-audio");
		expect(isPermanentFailure(failure.kind)).toBe(true);
	});

	it("treats anything else as a transient error worth retrying", () => {
		const failure = classifyTranscriptionError(new Error("whisper-server exited"));
		expect(failure.kind).toBe("error");
		expect(failure.message).toBe("whisper-server exited");
		expect(isPermanentFailure(failure.kind)).toBe(false);
	});
});

describe("transcriptHasSpeech", () => {
	it("is false for a transcript whisper returned empty", () => {
		expect(transcriptHasSpeech(transcript("asset_1", []))).toBe(false);
	});

	it("is true as soon as one word came back", () => {
		expect(transcriptHasSpeech(transcript("asset_1", ["hello"]))).toBe(true);
	});
});

describe("deriveAssetStatus", () => {
	it("reports a live job over an existing transcript (regenerate)", () => {
		const derived = deriveAssetStatus({
			assetId: "asset_1",
			job: { status: "running", phase: "transcribing" },
			transcript: transcript("asset_1", ["hello"]),
		});
		expect(derived).toEqual({ assetId: "asset_1", status: "running", phase: "transcribing" });
	});

	it("carries chunk progress through to the view", () => {
		const derived = deriveAssetStatus({
			assetId: "asset_1",
			job: {
				status: "running",
				phase: "transcribing",
				progress: { completedSec: 90, totalSec: 300 },
			},
		});
		expect(derived.progress).toEqual({ completedSec: 90, totalSec: 300 });
		expect(progressFraction(derived.progress)).toBeCloseTo(0.3);
	});

	it("leaves progress absent while nothing measurable is running", () => {
		// Audio extraction and the model download have no fraction to report; the
		// UI must get `undefined` so it keeps the spinner instead of a 0% bar.
		const derived = deriveAssetStatus({
			assetId: "asset_1",
			job: { status: "running", phase: "extracting-audio" },
		});
		expect(derived.progress).toBeUndefined();
		expect(progressFraction(derived.progress)).toBeNull();
	});

	it("reports ready from the document, with no job at all", () => {
		expect(
			deriveAssetStatus({ assetId: "asset_1", transcript: transcript("asset_1", ["hello"]) })
				.status,
		).toBe("ready");
	});

	it("distinguishes an empty transcript from a ready one", () => {
		expect(
			deriveAssetStatus({ assetId: "asset_1", transcript: transcript("asset_1", []) }).status,
		).toBe("empty");
	});

	it("keeps a stored transcript ready when a regenerate over it failed", () => {
		// The failed retry left the previous transcript untouched on the document:
		// reading the asset as "failed" would disable Smart cuts over a transcript
		// that is right there and usable.
		const derived = deriveAssetStatus({
			assetId: "asset_1",
			job: { status: "failed", failure: { kind: "error", message: "whisper-server exited" } },
			transcript: transcript("asset_1", ["hello"]),
		});
		expect(derived.status).toBe("ready");
		// …and the failure still travels, so a tooltip can explain the red flash.
		expect(derived.failure?.message).toBe("whisper-server exited");
	});

	it("reports failed only when nothing was ever produced", () => {
		const derived = deriveAssetStatus({
			assetId: "asset_1",
			job: { status: "failed", failure: { kind: "error", message: "boom" } },
		});
		expect(derived.status).toBe("failed");
	});

	it("falls back to the failure remembered on the asset across reloads", () => {
		const derived = deriveAssetStatus({
			assetId: "asset_1",
			persistedFailure: { kind: "no-audio", message: "No audio track found in this video." },
		});
		expect(derived.status).toBe("failed");
		expect(derived.failure?.kind).toBe("no-audio");
	});

	it("is idle when nothing has been attempted", () => {
		expect(deriveAssetStatus({ assetId: "asset_1" }).status).toBe("idle");
	});
});

describe("resolveTranscriptGate", () => {
	it("blocks with no-media when the project is empty", () => {
		expect(resolveTranscriptGate([])).toEqual({
			state: "blocked",
			reason: "no-media",
			pendingCount: 0,
		});
	});

	it("opens once an asset has speech", () => {
		expect(resolveTranscriptGate([view("a", "ready")]).state).toBe("ready");
	});

	it("waits while any asset is still in flight, even next to a ready one", () => {
		const gate = resolveTranscriptGate([view("a", "ready"), view("b", "running")]);
		expect(gate.state).toBe("pending");
		expect(gate.pendingCount).toBe(1);
	});

	it("counts queued assets as pending", () => {
		expect(resolveTranscriptGate([view("a", "queued"), view("b", "queued")]).pendingCount).toBe(2);
	});

	it("blocks on no-audio when every media is silent", () => {
		const gate = resolveTranscriptGate([
			view("a", "failed", "no-audio"),
			view("b", "failed", "unsupported-audio"),
		]);
		expect(gate.state).toBe("blocked");
		expect(gate.reason).toBe("no-audio");
	});

	it("blocks on failed (retryable) as soon as one failure is not about silence", () => {
		const gate = resolveTranscriptGate([
			view("a", "failed", "no-audio"),
			view("b", "failed", "error"),
		]);
		expect(gate.reason).toBe("failed");
		expect(gate.message).toContain("boom");
	});

	it("stays ready when a failed retry sits on top of a usable transcript", () => {
		const gate = resolveTranscriptGate([
			{
				assetId: "a",
				status: "ready",
				failure: { kind: "error", message: "whisper-server exited" },
			},
		]);
		expect(gate.state).toBe("ready");
	});

	it("blocks on no-speech when the transcripts came back empty", () => {
		expect(resolveTranscriptGate([view("a", "empty")]).reason).toBe("no-speech");
	});

	it("blocks on not-started when nothing ran (no local engine)", () => {
		expect(resolveTranscriptGate([view("a", "idle")]).reason).toBe("not-started");
	});
});

const base = {
	schemaVersion: 7 as const,
	project: {
		id: "proj_1",
		title: "T",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
	},
	transcript: null,
	transcripts: [],
	annotations: [],
	zoomRanges: [],
	audioTracks: [],
	legacyEditor: null,
};

function doc(assetIds: string[], clipAssetIds: string[]): AxcutDocument {
	return {
		...base,
		assets: assetIds.map((id) => ({
			id,
			kind: "video" as const,
			label: id,
			originalPath: `/tmp/${id}.mp4`,
			cameraTrack: null,
		})),
		timeline: {
			clips: clipAssetIds.map((assetId, i) => ({
				id: `clip_${i}`,
				assetId,
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: i * 10,
				timelineEndSec: i * 10 + 10,
				wordRefs: [],
				origin: "system" as const,
				reason: "",
			})),
			gaps: [],
			trimRanges: [],
			insertRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
	} as AxcutDocument;
}

describe("transcriptRelevantAssetIds", () => {
	it("only counts the assets the timeline plays", () => {
		expect(transcriptRelevantAssetIds(doc(["a", "b"], ["a", "a"]))).toEqual(["a"]);
	});

	it("falls back to the whole media bin while the timeline is empty", () => {
		expect(transcriptRelevantAssetIds(doc(["a", "b"], []))).toEqual(["a", "b"]);
	});

	it("ignores clips pointing at a removed asset", () => {
		expect(transcriptRelevantAssetIds(doc(["a"], ["ghost"]))).toEqual(["a"]);
	});

	it("has nothing to say about a missing document", () => {
		expect(transcriptRelevantAssetIds(null)).toEqual([]);
	});
});

describe("firstTimelineBusyView", () => {
	it("ignores a busy job on an asset the timeline does not play", () => {
		// "b" is in the bin and mid-transcription, but the timeline only plays
		// "a" — the timeline-scoped label must stay idle, like the gate does.
		const views = { b: view("b", "running") };
		expect(firstTimelineBusyView(doc(["a", "b"], ["a"]), views)).toBeUndefined();
	});

	it("reports a busy job on a timeline asset", () => {
		const views = { a: view("a", "running"), b: view("b", "running") };
		expect(firstTimelineBusyView(doc(["a", "b"], ["a"]), views)?.assetId).toBe("a");
	});

	it("keeps the empty-timeline fallback: whole-bin jobs count", () => {
		const views = { b: view("b", "queued") };
		expect(firstTimelineBusyView(doc(["a", "b"], []), views)?.assetId).toBe("b");
	});

	it("is quiet when nothing relevant is busy", () => {
		const views = { a: view("a", "ready") };
		expect(firstTimelineBusyView(doc(["a"], ["a"]), views)).toBeUndefined();
	});
});

describe("realtimeSpeed", () => {
	// The engine reports RTF (wall-clock / audio, lower is faster); the UI shows
	// its reciprocal, which is the figure the POC report headlines.
	it("inverts the engine's RTF into x-real-time", () => {
		expect(realtimeSpeed(0.5)).toBe(2);
		expect(realtimeSpeed(0.19)).toBeCloseTo(5.26, 2);
	});

	// Null rather than 0: a helper binary older than the `timing` field reports
	// nothing at all, and "0.0x" would read as a measurement rather than a gap.
	it.each([
		["undefined", undefined],
		["zero", 0],
		["negative", -1],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
	])("has no answer for %s", (_label, rtf) => {
		expect(realtimeSpeed(rtf)).toBeNull();
	});
});

describe("isCpuBackend", () => {
	it("singles out the CPU path and nothing else", () => {
		expect(isCpuBackend("whispercpp-cpu")).toBe(true);
		expect(isCpuBackend("whispercpp-vulkan")).toBe(false);
		expect(isCpuBackend("whispercpp-metal")).toBe(false);
		expect(isCpuBackend("whispercpp-cuda")).toBe(false);
		expect(isCpuBackend(undefined)).toBe(false);
	});
});

describe("model download bytes", () => {
	it("is in-flight only when totalBytes is positive and download is incomplete", () => {
		expect(isModelDownloadInFlight({ downloadedBytes: 10, totalBytes: 100 })).toBe(true);
		expect(isModelDownloadInFlight({ downloadedBytes: 100, totalBytes: 100 })).toBe(false);
		expect(isModelDownloadInFlight({})).toBe(false);
	});

	it("prefers a running view over a queued one for pane copy", () => {
		const busy = firstBusyView([
			view("a", "queued"),
			{ assetId: "b", status: "running", phase: "loading-model" },
		]);
		expect(busy?.assetId).toBe("b");
	});
});

describe("deriveAssetStatus carries the engine's own report", () => {
	// Both facts come from the main process on the chunk status events, and the
	// view is the only thing the three status surfaces read.
	it("passes the running job's backend and rtf onto the view", () => {
		const derived = deriveAssetStatus({
			assetId: "a",
			job: { status: "running", backend: "whispercpp-cpu", rtf: 1.1 },
		});
		expect(derived.backend).toBe("whispercpp-cpu");
		expect(derived.rtf).toBe(1.1);
	});

	// A finished run's transcript says nothing about the device that produced it,
	// so the view must not carry a stale badge over a "ready" asset.
	it("drops them once a transcript exists", () => {
		const derived = deriveAssetStatus({
			assetId: "a",
			job: { status: "failed", backend: "whispercpp-cpu", rtf: 1.1 },
			transcript: transcript("a", ["hello"]),
		});
		expect(derived.status).toBe("ready");
		expect(derived.backend).toBeUndefined();
		expect(derived.rtf).toBeUndefined();
	});
});

describe("assetCanCarrySpeech", () => {
	/** A document with one video asset and one imported audio asset. */
	const doc = (audioTracks: Array<Record<string, unknown>>) =>
		({
			assets: [
				{ id: "vid", kind: "video" },
				{ id: "aud", kind: "audio" },
			],
			audioTracks,
		}) as unknown as Parameters<typeof assetCanCarrySpeech>[0];

	const track = (kind: "voiceover" | "music", assetId = "aud") => ({
		id: `t_${kind}`,
		assetId,
		kind,
	});

	it("says yes to footage without consulting the timeline", () => {
		// Video is the case that always carried speech; the guard must not regress it.
		expect(assetCanCarrySpeech(doc([]), "vid")).toBe(true);
	});

	it("says yes to an audio asset played on a voiceover lane", () => {
		expect(assetCanCarrySpeech(doc([track("voiceover")]), "aud")).toBe(true);
	});

	it("says no to a music bed", () => {
		// The whole point: 35s of inference at editor open, to transcribe music.
		expect(assetCanCarrySpeech(doc([track("music")]), "aud")).toBe(false);
	});

	it("says yes when the same file is on both lanes", () => {
		// One voiceover placement is enough — the file demonstrably carries speech,
		// whatever else it is also used for.
		expect(assetCanCarrySpeech(doc([track("music"), track("voiceover")]), "aud")).toBe(true);
	});

	it("says no to an audio asset no region plays", () => {
		// Nothing is asking for it, so nothing should pay for it.
		expect(assetCanCarrySpeech(doc([]), "aud")).toBe(false);
	});

	it("ignores regions playing a different file", () => {
		expect(assetCanCarrySpeech(doc([track("voiceover", "other")]), "aud")).toBe(false);
	});

	it("says no to an asset that is not in the document", () => {
		expect(assetCanCarrySpeech(doc([]), "ghost")).toBe(false);
	});
});
