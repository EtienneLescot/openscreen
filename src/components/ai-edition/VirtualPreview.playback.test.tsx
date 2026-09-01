// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutClip, AxcutTrimRange } from "@/lib/ai-edition/schema";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";

// The rAF tick is the whole subject here, so it is driven by hand rather than by the
// browser: `tick()` runs exactly one frame, which is what makes "what did the loop decide
// at 9.96 s?" an assertion instead of a race.
let frameCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
	frameCallbacks = [];
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		frameCallbacks.push(cb);
		return frameCallbacks.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {
		// Frames are drained by `tick()`, never scheduled, so there is nothing to cancel —
		// the stub only exists so the effect's cleanup has something to call.
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function tick() {
	const pending = frameCallbacks;
	frameCallbacks = [];
	act(() => {
		for (const cb of pending) cb(0);
	});
}

function clip(
	id: string,
	assetId: string,
	sourceStartSec: number,
	sourceEndSec: number,
	timelineStartSec: number,
): AxcutClip {
	return {
		id,
		assetId,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

/** A `<video>` jsdom will not drive: its clock is set by the test, and play/pause are
 *  recorded rather than performed (jsdom implements neither). */
function driveVideo(element: HTMLVideoElement) {
	let currentTime = 0;
	let paused = true;
	const pauseCalls: number[] = [];
	Object.defineProperty(element, "currentTime", {
		configurable: true,
		get: () => currentTime,
		set: (next: number) => {
			currentTime = next;
		},
	});
	Object.defineProperty(element, "paused", { configurable: true, get: () => paused });
	Object.defineProperty(element, "readyState", { configurable: true, get: () => 4 });
	Object.defineProperty(element, "duration", { configurable: true, get: () => 10 });
	element.play = vi.fn(() => {
		paused = false;
		return Promise.resolve();
	});
	element.pause = vi.fn(() => {
		paused = true;
		pauseCalls.push(currentTime);
	});
	return {
		pauseCalls,
		play: () => {
			paused = false;
		},
		seekTo: (next: number) => {
			currentTime = next;
		},
		get currentTime() {
			return currentTime;
		},
	};
}

function mount(clips: AxcutClip[], trimRanges: AxcutTrimRange[] = []) {
	const onTimeChange = vi.fn();
	const sources: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
	const { container } = render(
		<VirtualPreview
			videoSources={sources}
			clips={clips}
			trimRanges={trimRanges}
			onTimeChange={onTimeChange}
		/>,
	);
	const element = container.querySelector("video");
	if (!element) throw new Error("no <video> rendered");
	const video = driveVideo(element as HTMLVideoElement);
	// How the real app resolves its first clip: metadata arrives, the component seeks to
	// its current virtual time, and that seek is what names the active clip.
	act(() => {
		fireEvent.loadedMetadata(element);
	});
	return { onTimeChange, video, element: element as HTMLVideoElement };
}

const reportedTimes = (onTimeChange: ReturnType<typeof vi.fn>) =>
	onTimeChange.mock.calls.map((call) => call[0] as number);

describe("VirtualPreview playback across a clip boundary", () => {
	// The reported bug: with two clips over ONE recording, playback stopped on reaching
	// the second clip and the playhead landed at the end of the timeline.
	it("crosses into the second clip of the same recording instead of stopping", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const { onTimeChange, video } = mount(clips);

		video.play();
		// Play out clip_1 up to the frame where the boundary advance fires.
		for (const t of [1, 5, 9, 9.96]) {
			video.seekTo(t);
			tick();
		}

		expect(video.pauseCalls).toHaveLength(0);
		// The playhead must never have been reported inside clip_2's span, let alone at the
		// end of the timeline (20), while clip_1 was still playing.
		expect(Math.max(...reportedTimes(onTimeChange))).toBeLessThanOrEqual(10.001);
		// …and the advance rewound the media to clip_2's source in-point and kept playing.
		expect(video.currentTime).toBe(0);
		expect(reportedTimes(onTimeChange).at(-1)).toBeCloseTo(10, 5);

		// Now play clip_2 out; only NOW may playback stop, at the end of the timeline.
		for (const t of [1, 5, 9.96]) {
			video.seekTo(t);
			tick();
		}
		expect(video.pauseCalls).toHaveLength(1);
		expect(reportedTimes(onTimeChange).at(-1)).toBeCloseTo(20, 5);
	});

	it("crosses the boundary the same way whatever order the clips are laid in", () => {
		// The layout that used to escape the bug (a foreign clip last) and the ones that did
		// not must now behave identically.
		const layouts: Array<[string, AxcutClip[]]> = [
			[
				"twins then a foreign clip",
				[clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)],
			],
			[
				"a foreign clip between the twins",
				[
					clip("clip_1", "a1", 0, 10, 0),
					clip("clip_3", "c1", 0, 10, 10),
					clip("clip_2", "a1", 0, 10, 20),
				],
			],
		];
		for (const [label, clips] of layouts) {
			const { onTimeChange, video } = mount(clips);
			video.play();
			for (const t of [5, 9.96]) {
				video.seekTo(t);
				tick();
			}
			expect(video.pauseCalls, label).toHaveLength(0);
			expect(Math.max(...reportedTimes(onTimeChange)), label).toBeLessThanOrEqual(10.001);
			cleanup();
		}
	});

	it("skips a cut authored on the playing clip even when its twin keeps that stretch", () => {
		// clip_1 cuts source 4–6; clip_2 is the same recording, uncut. The cut must apply
		// while clip_1 plays — the twin keeping the stretch used to answer for it.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const trims: AxcutTrimRange[] = [
			{
				id: "trim_1",
				assetId: "a1",
				clipId: "clip_1",
				startSec: 4,
				endSec: 6,
				origin: "user",
				reason: "",
			},
		];
		const { video } = mount(clips, trims);

		video.play();
		video.seekTo(3);
		tick();
		expect(video.currentTime).toBe(3); // before the cut: untouched

		video.seekTo(5); // inside clip_1's cut
		tick();
		expect(video.currentTime).toBe(6); // jumped to where clip_1's content resumes
		expect(video.pauseCalls).toHaveLength(0);
	});
});

// Issue #350 — imported audio tracks follow the RAW virtual playhead. The
// decision math is unit-tested in VirtualPreview.audio.test.ts; here we prove the
// rAF loop applies it to the mounted <audio> element (seek + play/pause).
function driveAudioEl(el: HTMLAudioElement) {
	let currentTime = 0;
	let paused = true;
	Object.defineProperty(el, "currentTime", {
		configurable: true,
		get: () => currentTime,
		set: (next: number) => {
			currentTime = next;
		},
	});
	Object.defineProperty(el, "paused", { configurable: true, get: () => paused });
	Object.defineProperty(el, "duration", { configurable: true, get: () => 10 });
	el.play = vi.fn(() => {
		paused = false;
		return Promise.resolve();
	});
	el.pause = vi.fn(() => {
		paused = true;
	});
	return {
		get currentTime() {
			return currentTime;
		},
	};
}

describe("VirtualPreview imported audio tracks", () => {
	// Playing the file from 1s, over ruler 2..4 → occupies output 2..4 on source 1..3.
	// The element is keyed by the PILL id, which for a single-fragment region is its own id.
	const track = {
		id: "trk",
		startMs: 2000,
		endMs: 4000,
		clipId: "c1",
		sourceStartSec: 2,
		sourceEndSec: 4,
		audioAssetId: "aud",
		kind: "music" as const,
		offsetSec: 1,
		gainDb: 0,
		origin: "user" as const,
	};

	function mountWithAudio() {
		const sources: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
		const audioSources: VideoSource[] = [{ id: "aud", src: "file:///tmp/vo.mp3", label: "vo" }];
		const { container } = render(
			<VirtualPreview
				videoSources={sources}
				audioRegions={[track]}
				audioSources={audioSources}
				clips={[clip("c1", "a1", 0, 10, 0)]}
				onTimeChange={vi.fn()}
			/>,
		);
		const videoEl = container.querySelector("video");
		if (!videoEl) throw new Error("no <video>");
		const video = driveVideo(videoEl as HTMLVideoElement);
		act(() => fireEvent.loadedMetadata(videoEl));
		const audioEl = container.querySelector<HTMLAudioElement>(
			'[data-testid="preview-audio-track-trk"]',
		);
		if (!audioEl) throw new Error("no track <audio>");
		return { video, audioEl, audio: driveAudioEl(audioEl) };
	}

	it("mounts one <audio> per track with the asset's URL", () => {
		const { audioEl } = mountWithAudio();
		expect(audioEl.getAttribute("src")).toBe("file:///tmp/vo.mp3");
	});

	it("plays inside the window at the trim-offset source time, pauses outside", () => {
		const { video, audioEl, audio } = mountWithAudio();
		video.play();
		// virtualTime lands one tick after the video seek, and the audio loop reads
		// last frame's virtualTime, so two ticks settle the decision.
		video.seekTo(3); // virtual 3 → 1s into the 2..4 span
		tick();
		tick();
		expect(audioEl.play).toHaveBeenCalled();
		expect(audio.currentTime).toBeCloseTo(2, 1); // trimStart 1 + 1s in

		video.seekTo(5); // virtual 5 → past the window end (4)
		tick();
		tick();
		expect(audioEl.pause).toHaveBeenCalled();
	});
});

// Issue #350 — a track boosted past 0 dB must sound boosted in the preview too, not just
// in the export. `element.volume` caps at 1, so the boost has to ride a WebAudio gain node.
// jsdom has no WebAudio, so install a minimal fake context and watch the nodes it mints.
class FakeAudioNode {
	connect = vi.fn();
	disconnect = vi.fn();
}
class FakeGainNode extends FakeAudioNode {
	gain = { value: 1 };
}
let createdGains: FakeGainNode[] = [];
class FakeAudioContext {
	state = "running";
	destination = new FakeAudioNode();
	resume = vi.fn(() => Promise.resolve());
	close = vi.fn(() => Promise.resolve());
	createMediaElementSource = vi.fn(() => new FakeAudioNode());
	createGain = vi.fn(() => {
		const node = new FakeGainNode();
		createdGains.push(node);
		return node;
	});
}

describe("VirtualPreview imported audio track boost", () => {
	beforeEach(() => {
		createdGains = [];
		vi.stubGlobal("AudioContext", FakeAudioContext);
	});

	// +6.0206 dB is exactly ×2 in linear gain — a boost `element.volume` (max 1) could never
	// reach. The graph mints the output gain first, then one gain per track, so the track's
	// node is the last one created.
	const boosted = {
		id: "trk",
		startMs: 2000,
		endMs: 4000,
		clipId: "c1",
		sourceStartSec: 2,
		sourceEndSec: 4,
		audioAssetId: "aud",
		kind: "music" as const,
		offsetSec: 1,
		gainDb: 6.0206,
		origin: "user" as const,
	};

	it("drives a per-track gain node past unity instead of capping element.volume", () => {
		const sources: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
		const audioSources: VideoSource[] = [{ id: "aud", src: "file:///tmp/vo.mp3", label: "vo" }];
		const { container } = render(
			<VirtualPreview
				videoSources={sources}
				audioRegions={[boosted]}
				audioSources={audioSources}
				clips={[clip("c1", "a1", 0, 10, 0)]}
				onTimeChange={vi.fn()}
			/>,
		);
		const videoEl = container.querySelector("video");
		if (!videoEl) throw new Error("no <video>");
		driveVideo(videoEl as HTMLVideoElement);
		act(() => fireEvent.loadedMetadata(videoEl));
		const audioEl = container.querySelector<HTMLAudioElement>(
			'[data-testid="preview-audio-track-trk"]',
		);
		if (!audioEl) throw new Error("no track <audio>");
		driveAudioEl(audioEl);

		tick(); // let the rAF stamp the live gain onto the node
		const trackGain = createdGains.at(-1);
		expect(trackGain?.gain.value).toBeCloseTo(2, 3); // boosted, NOT clamped to 1
		expect(audioEl.volume).toBe(1); // volume left at unity so it doesn't double-attenuate
	});
});
