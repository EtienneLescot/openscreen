import { describe, expect, it } from "vitest";
import {
	applyPreviewAudioSettings,
	type PreviewAudioGraph,
	resolveAudioTrackPlayback,
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
