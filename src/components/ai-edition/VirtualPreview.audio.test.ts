import { describe, expect, it } from "vitest";
import { projectRawTimelineSecToPlayback } from "@/lib/ai-edition/document/timeline";
import type { AxcutAudioTrack, AxcutClip, AxcutTrimRange } from "@/lib/ai-edition/schema";
import { removedRawSpans } from "@/lib/ai-edition/timeline/programme-time";
import {
	applyPreviewAudioSettings,
	type PreviewAudioGraph,
	resolveAudioTrackPlayback,
	resolveTimelineAudioPlayback,
	resolveVoiceoverPlayback,
	timelineAudioFadeAt,
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
		kind: "music",
		startMs: 10_000,
		endMs: 16_000,
		durationSec: 20,
		offsetMs: 2000,
		gainDb: 0,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted: false,
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

	it("folds a looping track back into its window, in phase with the export", () => {
		// 4s of source (offset 0, 4s file) under a 10s span.
		const looped = { ...track, endMs: 20_000, offsetMs: 0, durationSec: 4, loop: true };
		const span = spanSec(looped);
		expect(resolveTimelineAudioPlayback(13, 10, looped, span).targetTimeSec).toBeCloseTo(3, 6);
		// 5s in is 1s into the second repeat — the export's second mix entry agrees.
		expect(resolveTimelineAudioPlayback(15, 10, looped, span).targetTimeSec).toBeCloseTo(1, 6);
		expect(resolveTimelineAudioPlayback(15, 10, looped, span).shouldPlay).toBe(true);
		// Past the span it stops, however much file is left.
		expect(resolveTimelineAudioPlayback(21, 10, looped, span).shouldPlay).toBe(false);
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
		const project = (rawSec: number) => projectRawTimelineSecToPlayback([clip], [trim], rawSec, []);
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

describe("resolveTimelineAudioPlayback under a trim", () => {
	const clip: AxcutClip = {
		id: "clip_1",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 20,
		timelineStartSec: 0,
		timelineEndSec: 20,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
	const trim: AxcutTrimRange = {
		id: "trim_1",
		assetId: "asset_1",
		startSec: 4,
		endSec: 8,
		origin: "user",
		reason: "",
	};
	const project = (rawSec: number) => projectRawTimelineSecToPlayback([clip], [trim], rawSec, []);

	const buried: AxcutAudioTrack = {
		id: "buried",
		assetId: "a1",
		kind: "music",
		startMs: 5000,
		endMs: 7000,
		durationSec: 30,
		offsetMs: 0,
		gainDb: 0,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted: false,
		label: "",
		origin: "user",
	};

	it("never plays a track buried inside the trim", () => {
		// Both ends project onto the cut, so the track's OUTPUT span is zero. Read
		// off the raw span instead it stayed 2s long and played at the boundary,
		// with nothing on screen to explain the sound.
		const outStart = project(buried.startMs / 1000);
		const outSpan = project(buried.endMs / 1000) - outStart;
		expect(outSpan).toBeCloseTo(0, 6);
		for (const raw of [3, 5, 6, 9, 12]) {
			expect(resolveTimelineAudioPlayback(project(raw), outStart, buried, outSpan).shouldPlay).toBe(
				false,
			);
		}
	});

	it("plays a track that merely crosses the trim, for the length that survives", () => {
		const crossing = { ...buried, id: "crossing", startMs: 2000, endMs: 12_000 };
		const outStart = project(crossing.startMs / 1000);
		const outSpan = project(crossing.endMs / 1000) - outStart;
		// Raw 2..12 with raw 4..8 cut leaves 6s of programme.
		expect(outSpan).toBeCloseTo(6, 6);
		expect(resolveTimelineAudioPlayback(project(3), outStart, crossing, outSpan).shouldPlay).toBe(
			true,
		);
		// Just past the end of what survives.
		expect(
			resolveTimelineAudioPlayback(outStart + 6.1, outStart, crossing, outSpan).shouldPlay,
		).toBe(false);
	});
});

describe("timelineAudioFadeAt", () => {
	const track: AxcutAudioTrack = {
		id: "t1",
		assetId: "a1",
		kind: "music",
		startMs: 0,
		endMs: 10_000,
		durationSec: 20,
		offsetMs: 0,
		gainDb: 0,
		loop: false,
		fadeInMs: 1000,
		fadeOutMs: 2000,
		muted: false,
		label: "",
		origin: "user",
	};

	it("ramps in and out over the track's own edges", () => {
		expect(timelineAudioFadeAt(track, 0, 10)).toBe(0);
		expect(timelineAudioFadeAt(track, 0.5, 10)).toBeCloseTo(0.5, 6);
		expect(timelineAudioFadeAt(track, 5, 10)).toBe(1);
		expect(timelineAudioFadeAt(track, 9, 10)).toBeCloseTo(0.5, 6);
		expect(timelineAudioFadeAt(track, 10, 10)).toBe(0);
	});

	it("is silent when muted", () => {
		expect(timelineAudioFadeAt({ ...track, muted: true }, 5, 10)).toBe(0);
	});

	it("still reaches full volume when a fade is longer than the span", () => {
		// Unreduced, the ramp never completes and the track plays near-silent.
		const long = { ...track, fadeInMs: 20_000, fadeOutMs: 0 };
		expect(timelineAudioFadeAt(long, 2, 2)).toBe(1);
	});
});

// ─── A cut under a voiceover ──────────────────────────────────────────────────
// Issue #560. The preview and the export have to agree about this, or a word the
// transcript pane shows struck through is still audible in one of them.

describe("resolveVoiceoverPlayback", () => {
	const CLIPS = [
		{
			id: "c1",
			assetId: "scr",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
			wordRefs: [],
			origin: "user" as const,
			reason: "",
		},
	];
	/** Raw 4..6 is out of the film. */
	const TRIMS = [
		{
			id: "t1",
			assetId: "scr",
			clipId: "c1",
			startSec: 4,
			endSec: 6,
			reason: "",
			origin: "user" as const,
		},
	];
	const removed = removedRawSpans(CLIPS, TRIMS);

	const voice = {
		id: "vo",
		assetId: "aud",
		kind: "voiceover" as const,
		startMs: 0,
		endMs: 10_000,
		durationSec: 30,
		offsetMs: 0,
		gainDb: 0,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted: false,
		label: "",
		origin: "user" as const,
	} as unknown as AxcutAudioTrack;

	it("goes silent exactly where the film lost its moment", () => {
		expect(resolveVoiceoverPlayback(voice, 3.9, removed).shouldPlay).toBe(true);
		expect(resolveVoiceoverPlayback(voice, 4.5, removed).shouldPlay).toBe(false);
		expect(resolveVoiceoverPlayback(voice, 6.1, removed).shouldPlay).toBe(true);
	});

	it("keeps the take's own clock running through the cut", () => {
		// It does NOT rewind or skip: raw 7 is second 7 of the take either way, which is
		// what makes the words after the cut still line up with the ones on screen.
		expect(resolveVoiceoverPlayback(voice, 7, removed).targetTimeSec).toBeCloseTo(7, 6);
		expect(
			resolveVoiceoverPlayback({ ...voice, offsetMs: 2000 }, 7, removed).targetTimeSec,
		).toBeCloseTo(9, 6);
	});

	it("stays silent outside its own span, and past the end of its file", () => {
		expect(resolveVoiceoverPlayback({ ...voice, startMs: 2000 }, 1, removed).shouldPlay).toBe(
			false,
		);
		expect(resolveVoiceoverPlayback(voice, 11, removed).shouldPlay).toBe(false);
		// A 3s file under a 10s span: silent after its own end rather than seeking past it.
		const short = { ...voice, durationSec: 3 } as AxcutAudioTrack;
		expect(resolveVoiceoverPlayback(short, 2.5, removed).shouldPlay).toBe(true);
		expect(resolveVoiceoverPlayback(short, 3.5, removed).shouldPlay).toBe(false);
	});

	it("schedules the same source seconds the export writes into the mix", () => {
		// Walk the take frame by frame and collect the contiguous runs of source time the
		// preview would play; they must be the export's entries, piece for piece.
		const runs: Array<{ from: number; to: number }> = [];
		for (let raw = 0; raw < 10; raw += 0.05) {
			const at = resolveVoiceoverPlayback(voice, raw, removed);
			if (!at.shouldPlay) continue;
			const last = runs.at(-1);
			if (last && Math.abs(at.targetTimeSec - last.to) < 0.06) last.to = at.targetTimeSec;
			else runs.push({ from: at.targetTimeSec, to: at.targetTimeSec });
		}
		expect(runs).toHaveLength(2);
		expect(runs[0].from).toBeCloseTo(0, 1);
		expect(runs[0].to).toBeCloseTo(4, 1);
		// The second run resumes at source 6 — the two seconds the cut took are never heard.
		expect(runs[1].from).toBeCloseTo(6, 1);
		expect(runs[1].to).toBeCloseTo(10, 1);
	});
});
