import { describe, expect, it } from "vitest";
import { resolveAudioTrackPlayback } from "./VirtualPreview";

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
