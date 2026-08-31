import { describe, expect, it } from "vitest";
import { projectRawTimelineSecToPlayback } from "@/lib/ai-edition/document/timeline";
import type { AxcutAudioTrack, AxcutClip, AxcutTrimRange } from "@/lib/ai-edition/schema";
import {
	applyPreviewAudioSettings,
	type PreviewAudioGraph,
	resolveAudioTrackPlayback,
	resolveTimelineAudioPlayback,
} from "./VirtualPreview";

/** Minimal stand-in: the function only ever touches `gain.gain.value`. */
function fakeGraph(): PreviewAudioGraph {
	return {
		context: {} as AudioContext,
		gain: { gain: { value: Number.NaN } } as GainNode,
	};
}

describe("resolveAudioTrackPlayback", () => {
	it("mirrors the video's time", () => {
		expect(resolveAudioTrackPlayback(1, 10)).toEqual({ targetTimeSec: 1, shouldPlay: true });
	});

	it("parks at the end of a track that is shorter than the video", () => {
		// The supplemental track is extracted separately, so it can run out before the
		// video does; seeking past its end leaves the element stuck in `seeking`.
		expect(resolveAudioTrackPlayback(12, 10)).toEqual({ targetTimeSec: 10, shouldPlay: false });
	});

	it("treats a zero-length track as already ended", () => {
		// An empty extraction is a KNOWN length, not an unknown one. Reading it as
		// unknown parks the element at the video's time with shouldPlay true, and the
		// rAF loop then seeks and calls play() on it for the whole timeline.
		expect(resolveAudioTrackPlayback(1, 0)).toEqual({ targetTimeSec: 0, shouldPlay: false });
	});

	it("plays while the duration is still unknown", () => {
		expect(resolveAudioTrackPlayback(1, Number.NaN)).toEqual({
			targetTimeSec: 1,
			shouldPlay: true,
		});
		// A negative duration is not a length either — same fallback as NaN.
		expect(resolveAudioTrackPlayback(1, -1)).toEqual({ targetTimeSec: 1, shouldPlay: true });
	});

	it("never seeks to a negative time", () => {
		expect(resolveAudioTrackPlayback(-0.5, 10)).toEqual({ targetTimeSec: 0, shouldPlay: false });
	});
});

describe("applyPreviewAudioSettings", () => {
	// This is the PR's parity claim, on the preview side. `finish_audio` applies
	// `10f32.powf(gain_db / 20.0)` per sample natively and has its own test pinning that
	// identity; if these two ever disagree, the editor stops meaning what it plays.
	it("feeds the gain node the same scalar the export applies", () => {
		for (const gainDb of [-12, -6.0206, 0, 6.0206, 12]) {
			const graph = fakeGraph();
			applyPreviewAudioSettings(graph, [], gainDb);
			expect(graph.gain.gain.value).toBeCloseTo(10 ** (gainDb / 20), 6);
		}
	});

	it("caps the element-volume fallback at unity, which is why the gain node exists", () => {
		const element = { volume: Number.NaN } as HTMLAudioElement;

		// Attenuation survives the fallback intact...
		applyPreviewAudioSettings(null, [element, null], -6.0206);
		expect(element.volume).toBeCloseTo(0.5, 4);

		// ...but `HTMLMediaElement.volume` has no headroom above 1, so a boost is lost
		// wherever WebAudio is unavailable. Degraded on purpose, not silent.
		applyPreviewAudioSettings(null, [element], 6.0206);
		expect(element.volume).toBe(1);
	});

	it("leaves the elements alone once the graph is carrying the gain", () => {
		// Their audio no longer reaches the default output, so `volume` would only
		// scale the signal a second time on its way into the node.
		const graph = fakeGraph();
		const element = { volume: 0.25 } as HTMLAudioElement;
		applyPreviewAudioSettings(graph, [element], -6.0206);
		expect(element.volume).toBe(0.25);
		expect(graph.gain.gain.value).toBeCloseTo(0.5, 4);
	});
});

describe("resolveTimelineAudioPlayback", () => {
	// A 6s track placed 10s into the RAW timeline, playing the source from 2s in.
	const track: AxcutAudioTrack = {
		id: "t1",
		assetId: "a1",
		startMs: 10_000,
		endMs: 16_000,
		durationSec: 20,
		offsetMs: 2000,
		gainDb: 0,
		label: "",
		origin: "user",
	};
	const spanSec = (t: AxcutAudioTrack) => (t.endMs - t.startMs) / 1000;

	// Second arg is the track head projected to output seconds; with no trims it is
	// just the raw head (10), so these read the same as before the output-space
	// change — the projection is exercised separately below.
	it("maps the playhead to a source position offset by the track offset", () => {
		// 3s into the track's span → 2 (offset) + 3 = 5s of source.
		expect(resolveTimelineAudioPlayback(13, 10, track, spanSec(track))).toEqual({
			targetTimeSec: 5,
			shouldPlay: true,
		});
	});

	it("does not play before the track starts, parked at the in-point", () => {
		expect(resolveTimelineAudioPlayback(9, 10, track, spanSec(track))).toEqual({
			targetTimeSec: 2,
			shouldPlay: false,
		});
	});

	it("does not play past the end of its span, parked at the out-point", () => {
		expect(resolveTimelineAudioPlayback(16, 10, track, spanSec(track))).toEqual({
			targetTimeSec: 8,
			shouldPlay: false,
		});
	});

	it("goes silent when the file runs out before the span does", () => {
		// A 5s file under a 10s span: at 6s in there is no source left, and the
		// element holds at the end rather than restarting.
		const short = { ...track, endMs: 20_000, offsetMs: 0, durationSec: 5 };
		expect(resolveTimelineAudioPlayback(14, 10, short, spanSec(short))).toEqual({
			targetTimeSec: 4,
			shouldPlay: true,
		});
		expect(resolveTimelineAudioPlayback(16, 10, short, spanSec(short)).shouldPlay).toBe(false);
	});

	// The regression: an interior trim must NOT skip the track's own content, so the
	// preview stays byte-for-byte with `audio::mix_external_tracks`, which overlays the
	// decoded window contiguously. Same scenario as Etienne's review and the projection's
	// own test: a 10s clip with raw 2..4 cut, background track at raw head 0 spanning 0..10.
	it("plays contiguously across an interior trim, matching the export", () => {
		const clip: AxcutClip = {
			id: "clip_1",
			assetId: "asset_1",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
			wordRefs: [],
			origin: "user",
			reason: "",
		};
		const trim: AxcutTrimRange = {
			id: "trim_1",
			assetId: "asset_1",
			startSec: 2,
			endSec: 4,
			origin: "user",
			reason: "",
		};
		const bgm: AxcutAudioTrack = {
			...track,
			id: "bgm",
			assetId: "a2",
			startMs: 0,
			endMs: 10_000,
			durationSec: 10,
			offsetMs: 0,
		};
		const project = (rawSec: number) => projectRawTimelineSecToPlayback([clip], [trim], rawSec);
		const outputStart = project(bgm.startMs / 1000); // 0

		// Raw playhead 5 sits 1s past the 2s cut → output 3. The track is a contiguous
		// block, so it must be at source 3 — NOT source 5, which the old raw-space
		// `local` produced (the 2s desync).
		expect(resolveTimelineAudioPlayback(project(5), outputStart, bgm, spanSec(bgm))).toEqual({
			targetTimeSec: 3,
			shouldPlay: true,
		});
		// Just before the cut is unaffected: raw 1 → output 1 → source 1.
		expect(
			resolveTimelineAudioPlayback(project(1), outputStart, bgm, spanSec(bgm)).targetTimeSec,
		).toBeCloseTo(1, 6);
	});
});
