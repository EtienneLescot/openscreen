// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { RELOAD_WINDOW_MS, RETRY_DELAYS_MS } from "./mediaError";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";

// Same hand-driven rAF as VirtualPreview.playback.test.tsx: the tick is a
// subject here too (it must go quiet while a reload is in flight), so frames are
// run one at a time rather than by the browser.
let frameCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
	frameCallbacks = [];
	vi.useFakeTimers();
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		frameCallbacks.push(cb);
		return frameCallbacks.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {
		// Frames are drained by `tick()`, never scheduled, so there is nothing to
		// cancel — the stub only exists so the effect's cleanup has something to call.
	});
	// Every case here deliberately provokes the logging the fix added; silence it
	// so a passing run stays readable.
	for (const level of ["debug", "warn", "error"] as const) {
		vi.spyOn(console, level).mockImplementation(() => {
			// swallowed on purpose
		});
	}
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function tick() {
	const pending = frameCallbacks;
	frameCallbacks = [];
	act(() => {
		for (const cb of pending) cb(0);
	});
}

function advance(ms: number) {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

function clip(id: string, assetId: string, timelineStartSec: number): AxcutClip {
	return {
		id,
		assetId,
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec,
		timelineEndSec: timelineStartSec + 10,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

/** A `<video>` jsdom will not drive: the test owns its clock, and load/play/pause
 *  are recorded rather than performed (jsdom implements none of them). */
function driveVideo(element: HTMLVideoElement) {
	let currentTime = 0;
	let paused = true;
	let error: { code: number; message: string } | null = null;
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
	Object.defineProperty(element, "error", { configurable: true, get: () => error });
	element.load = vi.fn(() => {
		// What the real load() does to the position, and why the resume point
		// cannot be read off the element after a failure.
		currentTime = 0;
	});
	element.play = vi.fn(() => {
		paused = false;
		return Promise.resolve();
	});
	element.pause = vi.fn(() => {
		paused = true;
	});
	return {
		play: () => {
			paused = false;
		},
		seekTo: (next: number) => {
			currentTime = next;
		},
		/** Fire an `error` event carrying a real MediaError code. */
		fail: (code: number | null, message = `code ${code}`) => {
			error = code === null ? null : { code, message };
			act(() => {
				fireEvent.error(element);
			});
		},
		loadedMetadata: () => {
			error = null;
			act(() => {
				fireEvent.loadedMetadata(element);
			});
		},
		get currentTime() {
			return currentTime;
		},
		get loadCalls() {
			return (element.load as ReturnType<typeof vi.fn>).mock.calls.length;
		},
		get pauseCalls() {
			return (element.pause as ReturnType<typeof vi.fn>).mock.calls.length;
		},
		get playCalls() {
			return (element.play as ReturnType<typeof vi.fn>).mock.calls.length;
		},
	};
}

const SOURCES: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];

function mount(clips: AxcutClip[] = [clip("clip_1", "a1", 0)], sources: VideoSource[] = SOURCES) {
	const onVideoError = vi.fn<(assetId: string, detail: string) => void>();
	const onVideoRecovered = vi.fn<(assetId: string) => void>();
	const onTimeChange = vi.fn<(timeSec: number) => void>();
	let seekRequestId = 0;
	let activeSources = sources;
	const tree = (
		retryToken: number,
		seekTarget: { timeSec: number; requestId: number } | null = null,
	) => (
		<VirtualPreview
			videoSources={activeSources}
			clips={clips}
			onTimeChange={onTimeChange}
			onVideoError={onVideoError}
			onVideoRecovered={onVideoRecovered}
			retryToken={retryToken}
			seekTarget={seekTarget}
		/>
	);
	const view = render(tree(0));
	const element = view.container.querySelector("video");
	if (!element) throw new Error("no <video> rendered");
	const video = driveVideo(element as HTMLVideoElement);
	// How the real app resolves its first clip: metadata arrives, the component
	// seeks to its current virtual time, and that seek names the active clip.
	video.loadedMetadata();
	onVideoRecovered.mockClear();
	return {
		view,
		video,
		element: element as HTMLVideoElement,
		onVideoError,
		onVideoRecovered,
		onTimeChange,
		bumpRetryToken: (token: number) => view.rerender(tree(token)),
		/** Re-point the mounted asset at a different file, keeping its id. */
		repointSourceTo: (src: string) =>
			act(() => {
				activeSources = activeSources.map((source) => ({ ...source, src }));
				view.rerender(tree(0));
			}),
		/** Move the playhead the way the shell does — a new seekTarget requestId. */
		scrubTo: (timeSec: number) =>
			act(() => {
				seekRequestId += 1;
				view.rerender(tree(0, { timeSec, requestId: seekRequestId }));
			}),
	};
}

describe("VirtualPreview media-error recovery (issue #395)", () => {
	// THE bug. A cross-asset clip boundary remounts the keyed <video> mid-load and
	// Chromium reports MEDIA_ERR_ABORTED for it — ordinary, expected, and it used
	// to be enough to collapse the whole preview for the rest of the session.
	it("ignores an aborted load entirely", () => {
		const { video, onVideoError } = mount();

		video.fail(1);
		advance(5_000);

		expect(onVideoError).not.toHaveBeenCalled();
		expect(video.loadCalls).toBe(0);
		expect(video.pauseCalls).toBe(0);
	});

	it("reloads the source after a decode failure instead of reporting it", () => {
		const { video, onVideoError } = mount();

		video.fail(3);
		expect(onVideoError).not.toHaveBeenCalled();
		expect(video.loadCalls).toBe(0);

		advance(RETRY_DELAYS_MS[0]);
		expect(video.loadCalls).toBe(1);
		expect(onVideoError).not.toHaveBeenCalled();
	});

	// The resume point has to be resolved from the playhead at reload time:
	// `video.currentTime` reads 0 after load(), so trusting the element would
	// silently rewind the user to the start of the clip.
	it("comes back at the playhead, not at zero", () => {
		const { video } = mount();

		video.play();
		video.seekTo(4);
		tick();

		video.fail(3);
		advance(RETRY_DELAYS_MS[0]);
		expect(video.currentTime).toBe(0); // load() reset it

		video.loadedMetadata();
		expect(video.currentTime).toBeCloseTo(4, 5);
		// …and playback resumes, because it was playing when the failure hit.
		expect(video.playCalls).toBeGreaterThan(0);
	});

	// …and "at reload time" is the load-bearing half. Resolving it when the error
	// fired, or from the last position sampled off the element, both give 4 here —
	// only reading the live playhead when the timer runs gives 7.
	it("honours a scrub made during the backoff", () => {
		const { video, scrubTo } = mount();

		video.play();
		video.seekTo(4);
		tick();

		video.fail(3);
		scrubTo(7);
		advance(RETRY_DELAYS_MS[0]);

		video.loadedMetadata();
		expect(video.currentTime).toBeCloseTo(7, 5);
	});

	// An `error` does not fire `pause`, so `v.paused` — the gate the rest of the
	// tick relies on — is still false while the decoder is dead. Without its own
	// guard the tick would keep taking clip-boundary decisions on a frozen clock
	// and clobber the seek queued for the reload.
	it("stops steering the timeline while a reload is in flight", () => {
		const clips = [clip("clip_1", "a1", 0), clip("clip_2", "a1", 10)];
		const { video, onTimeChange } = mount(clips);

		video.play();
		video.seekTo(9.96); // the frame where the boundary advance would fire
		video.fail(3);
		onTimeChange.mockClear();

		tick();

		expect(onTimeChange).not.toHaveBeenCalled();
		expect(video.currentTime).toBe(9.96);
	});

	it("gives up after the retry budget and reports the media error", () => {
		const { video, onVideoError } = mount();

		for (const delay of RETRY_DELAYS_MS) {
			video.fail(3);
			advance(delay);
		}
		expect(onVideoError).not.toHaveBeenCalled();
		expect(video.loadCalls).toBe(RETRY_DELAYS_MS.length);

		video.fail(3);
		advance(5_000);

		expect(onVideoError).toHaveBeenCalledWith("a1", "MEDIA_ERR_DECODE (3) — code 3");
		expect(video.loadCalls).toBe(RETRY_DELAYS_MS.length); // no further reload
		expect(video.pauseCalls).toBe(1); // transport told, once, on the way out
	});

	it("gives an unsupported source exactly one look", () => {
		const { video, onVideoError } = mount();

		video.fail(4);
		advance(RETRY_DELAYS_MS[0]);
		expect(video.loadCalls).toBe(1);
		expect(onVideoError).not.toHaveBeenCalled();

		video.fail(4);
		expect(onVideoError).toHaveBeenCalledWith("a1", "MEDIA_ERR_SRC_NOT_SUPPORTED (4) — code 4");
	});

	// THE long-session guarantee, and the answer to "can a user run out of
	// recoveries?". The budget counts reloads inside a window, so it empties by
	// itself: hiccups spaced minutes apart — which is what a seek storm across
	// an editing session looks like — each get the full budget. A lifetime
	// counter would have made this third failure terminal.
	it("gives a later failure the full budget again once the window has emptied", () => {
		const { video, onVideoError } = mount();

		for (const delay of RETRY_DELAYS_MS) {
			video.fail(3);
			advance(delay);
		}
		expect(onVideoError).not.toHaveBeenCalled();
		expect(video.loadCalls).toBe(RETRY_DELAYS_MS.length);

		advance(RELOAD_WINDOW_MS + 1_000);

		video.fail(3);
		advance(RETRY_DELAYS_MS[0]);
		expect(onVideoError).not.toHaveBeenCalled();
		expect(video.loadCalls).toBe(RETRY_DELAYS_MS.length + 1);
	});

	// The livelock this fix originally shipped with. `loadedmetadata` only means
	// the container header parsed — a truncated recording re-fires it on every
	// reload — so re-arming the budget there handed it back faster than failures
	// could spend it: a 400 ms reload loop, forever, and the user never saw the
	// card. Progress past the failure point, not a completed load, is the signal.
	it("still gives up on a file that reloads cleanly and fails at the same spot", () => {
		const { video, onVideoError } = mount();

		video.play();
		video.seekTo(4);
		tick();

		// Three rounds of "the header parses, the data does not".
		for (let round = 0; round < RETRY_DELAYS_MS.length + 1; round += 1) {
			video.fail(3);
			advance(5_000);
			video.loadedMetadata(); // header fine, decoder willing
			video.seekTo(4); // …and straight back to the byte that killed it
			tick();
		}

		expect(onVideoError).toHaveBeenCalledWith("a1", "MEDIA_ERR_DECODE (3) — code 3");
		expect(video.loadCalls).toBe(RETRY_DELAYS_MS.length);
	});

	it("treats an error with no MediaError as transient", () => {
		const { video, onVideoError } = mount();

		video.fail(null);
		advance(RETRY_DELAYS_MS[0]);

		expect(video.loadCalls).toBe(1);
		expect(onVideoError).not.toHaveBeenCalled();
	});

	// The user's lever: it must work even from the terminal state, and even while
	// a backoff is pending.
	it("reloads immediately when the retry token is bumped", () => {
		const { video, onVideoError, bumpRetryToken } = mount();

		for (const delay of [...RETRY_DELAYS_MS, 0]) {
			video.fail(3);
			advance(delay);
		}
		expect(onVideoError).toHaveBeenCalledTimes(1);
		const loadsBefore = video.loadCalls;

		act(() => bumpRetryToken(1));
		advance(0);

		expect(video.loadCalls).toBe(loadsBefore + 1);
	});

	// Field regression, caught by breaking a real recording: once the card is up,
	// playback getting past the failure point must NOT hand the budget back. It
	// used to, so the next bad spot started the whole retry cycle again — three
	// full episodes for one broken file.
	it("does not re-arm itself after it has given up", () => {
		const { video, onVideoError } = mount();

		video.play();
		video.seekTo(4);
		tick();
		for (const delay of [...RETRY_DELAYS_MS, 0]) {
			video.fail(3);
			advance(delay);
		}
		expect(onVideoError).toHaveBeenCalledTimes(1);
		const loadsAtGiveUp = video.loadCalls;

		// Playback carries on past where it died — the shape that used to re-arm.
		video.seekTo(6);
		tick();
		video.fail(3);
		advance(5_000);

		expect(video.loadCalls).toBe(loadsAtGiveUp);
		expect(onVideoError).toHaveBeenCalledTimes(2); // still terminal, no new cycle
	});

	// The other half: a file failing FAST does not get to loop quietly. Three
	// failures inside one window is not "an occasional hiccup", and the user is
	// told once — and stays told, because the window emptying afterwards must
	// not restart the cycle behind the card.
	it("reaches the card on a burst inside the window, and stays there", () => {
		const { video, onVideoError } = mount();

		for (const delay of [...RETRY_DELAYS_MS, 0]) {
			video.fail(3);
			advance(delay);
		}
		expect(onVideoError).toHaveBeenCalledTimes(1);
		const loadsAtGiveUp = video.loadCalls;

		// Long enough for every reload to age out of the window.
		advance(RELOAD_WINDOW_MS * 3);
		video.fail(3);
		advance(5_000);

		expect(video.loadCalls).toBe(loadsAtGiveUp);
		expect(onVideoError).toHaveBeenCalledTimes(2);
	});

	// The element is keyed on the asset id alone, so pointing an asset at a new
	// file reloads the SAME element — and a budget spent on the old file must not
	// be charged to the new one. Nothing in the app re-points an asset today, but
	// it is the shape a "relink the moved file" flow would take, and this is the
	// component's own contract rather than the app's current use of it.
	it("gives a re-pointed source a fresh budget", () => {
		const { video, onVideoError, repointSourceTo } = mount();

		for (const delay of [...RETRY_DELAYS_MS, 0]) {
			video.fail(3);
			advance(delay);
		}
		expect(onVideoError).toHaveBeenCalledTimes(1);

		repointSourceTo("file:///tmp/a1-restored.mp4");
		onVideoError.mockClear();
		const loadsBefore = video.loadCalls;

		video.fail(3);
		advance(RETRY_DELAYS_MS[0]);

		expect(onVideoError).not.toHaveBeenCalled();
		expect(video.loadCalls).toBe(loadsBefore + 1);
	});

	// A reload scheduled for an element that is going away must never fire: the
	// <video> is keyed on the asset id, so the timer can outlive its element.
	it("does not reload an unmounted element", () => {
		const { view, video } = mount();

		video.fail(3);
		// Assert the cancellation itself: `reloadActiveSource` bails on a null
		// videoRef anyway, so a surviving timer would still leave loadCalls at 0
		// and prove nothing about the cleanup this test exists for.
		expect(vi.getTimerCount()).toBe(1);
		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
		advance(5_000);

		expect(video.loadCalls).toBe(0);
	});
});
