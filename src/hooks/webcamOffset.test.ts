import { describe, expect, it } from "vitest";
import { cameraTrackSchema } from "@/lib/ai-edition/schema";
import type { RecorderHandle } from "./recorderHandle";
import { webcamOffsetMsFrom } from "./useScreenRecorder";

// The offset the native macOS/Linux paths measure lands in `cameraTrack.offsetMs`,
// which the document schema declares as an integer. Both ends are checked here,
// because the failure was invisible in between: an unrounded offset made
// `parseDocument` throw inside the camera auto-link, the throw was caught as a
// lookup failure, and a recording that had a camera opened without one.
const recorder = {} as RecorderHandle;

describe("webcamOffsetMsFrom", () => {
	it("rounds the sub-millisecond gap performance.now() reports", () => {
		expect(webcamOffsetMsFrom(recorder, 1_000.1, 1_192.9000000044703)).toBe(-193);
		expect(webcamOffsetMsFrom(recorder, 0, 202.10000000149012)).toBe(-202);
	});

	it("produces a value the document schema accepts", () => {
		const offsetMs = webcamOffsetMsFrom(recorder, 1_000.1, 1_192.9000000044703);
		const parsed = cameraTrackSchema.safeParse({
			sourcePath: "/rec/recording-1-webcam.webm",
			startMs: 0,
			offsetMs,
			visible: true,
		});
		expect(parsed.success).toBe(true);
	});

	it("is null when this session recorded no webcam", () => {
		expect(webcamOffsetMsFrom(null, 1_000, 1_200)).toBeNull();
		expect(webcamOffsetMsFrom(recorder, null, 1_200)).toBeNull();
	});

	it("keeps the sign: the webcam always starts first", () => {
		expect(webcamOffsetMsFrom(recorder, 100, 350)).toBe(-250);
	});
});
