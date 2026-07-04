import { describe, expect, it } from "vitest";
import {
	CAMERA_SYNC_TOLERANCE_PAUSED_SEC,
	CAMERA_SYNC_TOLERANCE_PLAYING_SEC,
	createPlaybackClockRef,
	type PlaybackClockSnapshot,
	resolveCameraSyncTarget,
} from "./playback-clock";

function clock(overrides: Partial<PlaybackClockSnapshot> = {}): PlaybackClockSnapshot {
	return { virtualTimeSec: 0, sourceTimeSec: 0, isPlaying: false, playbackRate: 1, ...overrides };
}

describe("createPlaybackClockRef", () => {
	it("starts at a stopped, rate-1 zero position", () => {
		expect(createPlaybackClockRef().current).toEqual({
			virtualTimeSec: 0,
			sourceTimeSec: 0,
			isPlaying: false,
			playbackRate: 1,
		});
	});
});

describe("resolveCameraSyncTarget", () => {
	it("returns null when there is no visible camera track", () => {
		expect(resolveCameraSyncTarget(clock(), null, 5)).toBeNull();
		expect(
			resolveCameraSyncTarget(clock(), { startMs: 0, offsetMs: 0, visible: false }, 5),
		).toBeNull();
	});

	it("returns null when the active clip's source position couldn't be resolved", () => {
		expect(
			resolveCameraSyncTarget(clock(), { startMs: 0, offsetMs: 0, visible: true }, null),
		).toBeNull();
	});

	it("subtracts the camera's start/offset adjustment from the clip's source time", () => {
		const target = resolveCameraSyncTarget(
			clock({ sourceTimeSec: 10 }),
			{ startMs: 2000, offsetMs: 500, visible: true },
			10,
		);
		// adjustment = (2000 + 500) / 1000 = 2.5s
		expect(target?.targetTimeSec).toBeCloseTo(7.5);
	});

	it("clamps the target time to zero instead of going negative", () => {
		const target = resolveCameraSyncTarget(
			clock(),
			{ startMs: 5000, offsetMs: 0, visible: true },
			1,
		);
		expect(target?.targetTimeSec).toBe(0);
	});

	it("carries the clock's playbackRate through so speed regions apply to the camera too", () => {
		const target = resolveCameraSyncTarget(
			clock({ playbackRate: 2 }),
			{ startMs: 0, offsetMs: 0, visible: true },
			3,
		);
		expect(target?.playbackRate).toBe(2);
	});

	it("uses the looser playing tolerance while playing, and the tighter paused tolerance while paused", () => {
		const playing = resolveCameraSyncTarget(
			clock({ isPlaying: true }),
			{ startMs: 0, offsetMs: 0, visible: true },
			1,
		);
		const paused = resolveCameraSyncTarget(
			clock({ isPlaying: false }),
			{ startMs: 0, offsetMs: 0, visible: true },
			1,
		);
		expect(playing?.toleranceSec).toBe(CAMERA_SYNC_TOLERANCE_PLAYING_SEC);
		expect(paused?.toleranceSec).toBe(CAMERA_SYNC_TOLERANCE_PAUSED_SEC);
		expect(paused?.toleranceSec).toBeLessThan(playing?.toleranceSec ?? Number.POSITIVE_INFINITY);
	});
});
