// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";

// The root cause of issue #395, in a test.
//
// Dragging the playhead publishes a new time every rAF, the shell mints a
// seekTarget per publish, and this component used to turn each one into a
// `currentTime` write — ~60 demuxer seeks a second on a 1080p H.264 file the
// native compositor is decoding at the same time. Chromium eventually fails
// one (`PIPELINE_ERROR_READ: FFmpegDemuxer: demuxer seek failed`, observed on a
// file ffmpeg decodes end to end without a defect), and on main any media error
// emptied the editor.

afterEach(cleanup);

const SOURCES: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
const CLIPS: AxcutClip[] = [
	{
		id: "clip_1",
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

/** A `<video>` that behaves like a real one on the only axis this file tests:
 *  a `currentTime` write starts a seek, and the element stays `seeking` until
 *  the browser says otherwise. */
function driveVideo(element: HTMLVideoElement) {
	let currentTime = 0;
	let seeking = false;
	const writes: number[] = [];
	Object.defineProperty(element, "currentTime", {
		configurable: true,
		get: () => currentTime,
		set: (next: number) => {
			currentTime = next;
			seeking = true;
			writes.push(next);
		},
	});
	Object.defineProperty(element, "seeking", { configurable: true, get: () => seeking });
	Object.defineProperty(element, "paused", { configurable: true, get: () => true });
	Object.defineProperty(element, "readyState", { configurable: true, get: () => 4 });
	Object.defineProperty(element, "duration", { configurable: true, get: () => 10 });
	element.play = vi.fn(() => Promise.resolve());
	element.pause = vi.fn();
	return {
		writes,
		get currentTime() {
			return currentTime;
		},
		/** What the browser does when the demuxer is done. */
		finishSeek: () => {
			seeking = false;
			act(() => {
				fireEvent.seeked(element);
			});
		},
	};
}

function mount() {
	let requestId = 0;
	const tree = (seekTarget: { timeSec: number; requestId: number } | null) => (
		<VirtualPreview videoSources={SOURCES} clips={CLIPS} seekTarget={seekTarget} />
	);
	const view = render(tree(null));
	const element = view.container.querySelector("video");
	if (!element) throw new Error("no <video> rendered");
	const video = driveVideo(element as HTMLVideoElement);
	act(() => {
		fireEvent.loadedMetadata(element);
	});
	video.writes.length = 0;
	return {
		video,
		/** One rAF-throttled scrub publish, the way the shell emits them. */
		scrubTo: (timeSec: number) =>
			act(() => {
				requestId += 1;
				view.rerender(tree({ timeSec, requestId }));
			}),
	};
}

describe("VirtualPreview keeps one demuxer seek in flight (issue #395 root cause)", () => {
	it("does not stack a seek onto an element that is still seeking", () => {
		const { video, scrubTo } = mount();

		scrubTo(2);
		expect(video.writes).toEqual([2]); // demuxer busy from here

		scrubTo(4);
		scrubTo(6);
		scrubTo(8);

		// Three more scrub publishes, no extra seeks: this is the storm that made
		// the demuxer fail.
		expect(video.writes).toEqual([2]);
	});

	it("applies the newest target once the demuxer is free, not the queued ones", () => {
		const { video, scrubTo } = mount();

		scrubTo(2);
		scrubTo(4);
		scrubTo(6);
		scrubTo(8);

		video.finishSeek();

		// The last position the user asked for — the intermediate ones were never
		// destinations, and replaying them would be the storm again, delayed.
		expect(video.writes).toEqual([2, 8]);
		expect(video.currentTime).toBe(8);
	});

	it("stops seeking once the playhead settles", () => {
		const { video, scrubTo } = mount();

		scrubTo(5);
		video.finishSeek();
		expect(video.writes).toEqual([5]);

		// The drag ended on the position already reached: nothing more to do.
		scrubTo(5);
		video.finishSeek();
		expect(video.writes).toEqual([5]);
	});

	it("still serves an ordinary seek immediately when nothing is in flight", () => {
		const { video, scrubTo } = mount();

		scrubTo(3);
		video.finishSeek();
		scrubTo(7);

		expect(video.writes).toEqual([3, 7]);
	});
});
