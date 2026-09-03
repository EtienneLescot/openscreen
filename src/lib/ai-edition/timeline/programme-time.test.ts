// Issue #560. These hold the one claim the whole change rests on: that
// `programme-time.ts` and `resolvePlaybackSegments` answer "is this raw moment in the
// film" the same way. They are the same walk now, so the interesting assertions are the
// ones that would catch it drifting apart again — and the two boundary rules that do NOT
// follow from the definition (a trimmed tail is removed, unfilmed time past the last clip
// is not).

import { describe, expect, it } from "vitest";
import { projectRawTimelineSecToPlayback, resolvePlaybackSegments } from "../document/timeline";
import type { AxcutClip, AxcutTrimRange } from "../schema";
import { keptRawSpans, removalAt, removedRawSpans, subtractRemoved } from "./programme-time";

function clip(over: Partial<AxcutClip> & { id: string }): AxcutClip {
	return {
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
		...over,
	} as AxcutClip;
}

function trim(over: Partial<AxcutTrimRange> & { id: string }): AxcutTrimRange {
	return {
		assetId: "a1",
		startSec: 0,
		endSec: 1,
		origin: "user",
		reason: "",
		...over,
	} as AxcutTrimRange;
}

/** Two clips laid end to end over one 20s asset, cut at source 10. */
function twoClips(): AxcutClip[] {
	return [
		clip({
			id: "c1",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
		}),
		clip({
			id: "c2",
			sourceStartSec: 10,
			sourceEndSec: 20,
			timelineStartSec: 10,
			timelineEndSec: 20,
		}),
	];
}

const total = (spans: Array<{ startSec: number; endSec: number }>) =>
	spans.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);

/** Deterministic LCG — a failure here has to be reproducible, so no Math.random. */
function lcg(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

describe("keptRawSpans agrees with playback", () => {
	it("keeps exactly what resolvePlaybackSegments plays, over randomised fixtures", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const rand = lcg(seed);
			const clipCount = 1 + Math.floor(rand() * 3);
			const clips: AxcutClip[] = [];
			let cursor = 0;
			for (let i = 0; i < clipCount; i++) {
				const len = 4 + Math.floor(rand() * 8);
				const sourceStart = Math.floor(rand() * 5);
				clips.push(
					clip({
						id: `c${i}`,
						// Two clips over one asset on purpose: it is the case that separates a
						// per-clip walk from a per-asset one.
						assetId: rand() < 0.5 ? "a1" : "a2",
						sourceStartSec: sourceStart,
						sourceEndSec: sourceStart + len,
						timelineStartSec: cursor,
						timelineEndSec: cursor + len,
					}),
				);
				// Sometimes a gap before the next clip.
				cursor += len + (rand() < 0.3 ? 1 + Math.floor(rand() * 3) : 0);
			}
			const trims: AxcutTrimRange[] = [];
			const trimCount = Math.floor(rand() * 4);
			for (let i = 0; i < trimCount; i++) {
				const host = clips[Math.floor(rand() * clips.length)];
				const start = host.sourceStartSec + rand() * 4;
				trims.push(
					trim({
						id: `t${i}`,
						assetId: host.assetId,
						// Half anchored, half pre-v7 style, so both branches of
						// `trimAppliesToClip` are exercised.
						...(rand() < 0.5 ? { clipId: host.id } : {}),
						startSec: start,
						endSec: start + 0.5 + rand() * 3,
					}),
				);
			}

			const played = resolvePlaybackSegments(clips, trims).reduce(
				(sum, seg) => sum + ((seg.sourceEndSec ?? seg.sourceStartSec) - seg.sourceStartSec),
				0,
			);
			const kept = keptRawSpans(clips, trims);
			expect(total(kept), `seed ${seed} total`).toBeCloseTo(played, 6);

			// The sum alone is blind to ORDER, and order is the whole reason this walk was
			// lifted rather than reimplemented: `projectRawTimelineSecToPlayback` accumulates
			// one output cursor across the spans in the order they arrive. So check each
			// span's head projects to the output length of everything before it — which is
			// only true if the walk yields them in playback order.
			let before = 0;
			for (const [i, span] of kept.entries()) {
				expect(
					projectRawTimelineSecToPlayback(clips, trims, span.startSec, []),
					`seed ${seed} span ${i}`,
				).toBeCloseTo(before, 6);
				before += span.endSec - span.startSec;
			}
		}
	});

	it("is caught out when the spans arrive in the wrong order", () => {
		// Guards the guard: if `keptRawSpans` ever returned globally sorted spans instead of
		// playback-ordered ones, the assertion above has to fail. Two clips whose ruler order
		// is the reverse of their array order make the two orderings differ.
		const clips = [
			clip({
				id: "late",
				sourceStartSec: 0,
				sourceEndSec: 4,
				timelineStartSec: 6,
				timelineEndSec: 10,
			}),
			clip({
				id: "early",
				sourceStartSec: 0,
				sourceEndSec: 6,
				timelineStartSec: 0,
				timelineEndSec: 6,
			}),
		];
		expect(keptRawSpans(clips, []).map((s) => s.startSec)).toEqual([0, 6]);
	});

	it("leaves the projection identical to what it produced before the lift", () => {
		const clips = twoClips();
		const trims = [trim({ id: "t1", clipId: "c1", startSec: 2, endSec: 4 })];
		// Raw 2..4 is gone, so everything after it plays 2s earlier; inside the cut the
		// playhead lands on the output edge just before it.
		expect(projectRawTimelineSecToPlayback(clips, trims, 1, [])).toBeCloseTo(1, 6);
		expect(projectRawTimelineSecToPlayback(clips, trims, 3, [])).toBeCloseTo(2, 6);
		expect(projectRawTimelineSecToPlayback(clips, trims, 6, [])).toBeCloseTo(4, 6);
		expect(projectRawTimelineSecToPlayback(clips, trims, 20, [])).toBeCloseTo(18, 6);
		// Past the programme the projection is the identity, which is what lets a voiceover
		// hang off the end and keep playing.
		expect(projectRawTimelineSecToPlayback(clips, trims, 25, [])).toBeCloseTo(23, 6);
	});
});

describe("removedRawSpans", () => {
	it("partitions the programme with no overlap and no hole", () => {
		const clips = twoClips();
		const trims = [
			trim({ id: "t1", clipId: "c1", startSec: 2, endSec: 4 }),
			trim({ id: "t2", clipId: "c2", startSec: 15, endSec: 16 }),
		];
		const kept = [...keptRawSpans(clips, trims)].sort((a, b) => a.startSec - b.startSec);
		const removed = removedRawSpans(clips, trims);
		const all = [...kept, ...removed].sort((a, b) => a.startSec - b.startSec);

		let cursor = 0;
		for (const span of all) {
			expect(span.startSec).toBeCloseTo(cursor, 6); // no hole, no overlap
			cursor = span.endSec;
		}
		expect(cursor).toBeCloseTo(20, 6); // the last clip's raw end
	});

	it("reports an inter-clip gap as removed by nothing", () => {
		const clips = [
			twoClips()[0],
			clip({
				id: "c2",
				sourceStartSec: 10,
				sourceEndSec: 20,
				timelineStartSec: 13,
				timelineEndSec: 23,
			}),
		];
		const gap = removedRawSpans(clips, []).find((s) => s.startSec === 10);
		expect(gap).toMatchObject({ startSec: 10, endSec: 13 });
		// No trim took it, so the pane must not offer a restore.
		expect(gap?.trimIds).toEqual([]);
	});

	it("removes a trimmed tail of the last clip but never the time past it", () => {
		const clips = [twoClips()[0]];
		const trims = [trim({ id: "t1", clipId: "c1", startSec: 8, endSec: 10 })];
		const removed = removedRawSpans(clips, trims);
		expect(removed).toEqual([{ startSec: 8, endSec: 10, trimIds: ["t1"] }]);
		// Raw 12 is unfilmed, not removed — the distinction a voiceover overhanging the
		// programme depends on.
		expect(removalAt(removed, 12)).toBeNull();
		expect(removalAt(removed, 9)).toMatchObject({ trimIds: ["t1"] });
	});

	it("covers BOTH clips of an asset for a pre-v7 un-anchored trim", () => {
		// The regression guard. `trimToTimelineSpan`'s un-anchored branch resolves such a
		// trim through the FIRST clip whose source range contains its start, so a primitive
		// built on it would leave c2's words reading kept over film that is gone. The
		// playback walk cuts on overlap, per clip, and this must match it.
		const clips = twoClips();
		const trims = [trim({ id: "t1", startSec: 5, endSec: 15 })]; // no clipId
		const removed = removedRawSpans(clips, trims);
		expect(removalAt(removed, 6)).toMatchObject({ trimIds: ["t1"] }); // inside c1
		expect(removalAt(removed, 12)).toMatchObject({ trimIds: ["t1"] }); // inside c2
		expect(removalAt(removed, 2)).toBeNull();
		expect(removalAt(removed, 18)).toBeNull();
	});

	it("names every overlapping trim that took a stretch", () => {
		const clips = [twoClips()[0]];
		const trims = [
			trim({ id: "t1", clipId: "c1", startSec: 2, endSec: 5 }),
			trim({ id: "t2", clipId: "c1", startSec: 4, endSec: 7 }),
		];
		// `subtractInterval` merges the two into one hole; both ids come with it, so
		// restoring from the pane can drop the whole pill.
		expect(removedRawSpans(clips, trims)).toEqual([
			{ startSec: 2, endSec: 7, trimIds: ["t1", "t2"] },
		]);
	});

	it("returns nothing for a document with no clips", () => {
		expect(removedRawSpans([], [trim({ id: "t1" })])).toEqual([]);
	});
});

describe("subtractRemoved", () => {
	it("splits a span that crosses a cut into the pieces that survive", () => {
		const clips = twoClips();
		const removed = removedRawSpans(clips, [
			trim({ id: "t1", clipId: "c1", startSec: 3, endSec: 5 }),
		]);
		// A voiceover from raw 1 to raw 8 plays as two pieces, not as one take cut short.
		expect(subtractRemoved(1, 8, removed)).toEqual([
			{ startSec: 1, endSec: 3 },
			{ startSec: 5, endSec: 8 },
		]);
	});

	it("yields nothing for a span buried inside a cut, and the whole span when untouched", () => {
		const clips = twoClips();
		const removed = removedRawSpans(clips, [
			trim({ id: "t1", clipId: "c1", startSec: 3, endSec: 8 }),
		]);
		expect(subtractRemoved(4, 6, removed)).toEqual([]);
		expect(subtractRemoved(10, 14, removed)).toEqual([{ startSec: 10, endSec: 14 }]);
		// Past the programme is not removed, so an overhanging take keeps its tail.
		expect(subtractRemoved(18, 25, removed)).toEqual([{ startSec: 18, endSec: 25 }]);
	});
});

// ─── The pause the projection used to ignore ─────────────────────────────────
// A pause occupies ZERO raw seconds and D OUTPUT seconds, which a flat kept-interval list
// cannot express — so it was left out, and every audio track after a pause landed D seconds
// early in both the preview and the export. `filmInserts` is required precisely so no call
// site can quietly keep that bug.

describe("projectRawTimelineSecToPlayback with the film's pauses", () => {
	const clips = twoClips();
	const pause = { id: "i1", wordId: "w1", atRawSec: 5, durationSec: 1 };

	it("pushes everything after a pause later by exactly what it bought", () => {
		expect(projectRawTimelineSecToPlayback(clips, [], 8, [])).toBeCloseTo(8, 6);
		expect(projectRawTimelineSecToPlayback(clips, [], 8, [pause])).toBeCloseTo(9, 6);
	});

	it("leaves everything before it where it was", () => {
		expect(projectRawTimelineSecToPlayback(clips, [], 3, [pause])).toBeCloseTo(3, 6);
	});

	it("starts a track whose head sits exactly on the pause WITH the pause", () => {
		// Strict, matching `expandRawSec`: arriving at the pause's moment is the beginning
		// of the hold, not the end of it.
		expect(projectRawTimelineSecToPlayback(clips, [], 5, [pause])).toBeCloseTo(5, 6);
	});

	it("counts two pauses, in order", () => {
		const second = { id: "i2", wordId: "w2", atRawSec: 7, durationSec: 0.5 };
		expect(projectRawTimelineSecToPlayback(clips, [], 9, [pause, second])).toBeCloseTo(10.5, 6);
		// Order of the argument must not matter: the walk sorts.
		expect(projectRawTimelineSecToPlayback(clips, [], 9, [second, pause])).toBeCloseTo(10.5, 6);
	});

	it("never reaches a pause a trim removed", () => {
		// The moment it holds is not in the film any more, so neither is the pause — the
		// same rule `resolvePlaybackSegments` already follows.
		const trims = [trim({ id: "t1", clipId: "c1", startSec: 4, endSec: 6 })];
		expect(projectRawTimelineSecToPlayback(clips, trims, 8, [pause])).toBeCloseTo(
			projectRawTimelineSecToPlayback(clips, trims, 8, []),
			6,
		);
	});

	it("compresses the film around a pause but never the pause itself", () => {
		// A voice plays at 1x. A 2x region halves the film either side; the second the pause
		// bought is still a second.
		const speed = [{ startMs: 0, endMs: 20_000, speed: 2 }];
		expect(projectRawTimelineSecToPlayback(clips, [], 8, [], speed)).toBeCloseTo(4, 6);
		expect(projectRawTimelineSecToPlayback(clips, [], 8, [pause], speed)).toBeCloseTo(5, 6);
	});
});
