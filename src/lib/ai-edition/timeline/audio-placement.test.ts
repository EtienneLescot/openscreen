import { describe, expect, it } from "vitest";
import type { AxcutAudioRegion, AxcutClip, AxcutTrimRange } from "../schema";
import { placeAudioRegions, resolveAudioPlayback } from "./audio-placement";

function clip(over: Partial<AxcutClip> = {}): AxcutClip {
	return {
		id: "clip_1",
		assetId: "asset_1",
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

function region(over: Partial<AxcutAudioRegion> = {}): AxcutAudioRegion {
	return {
		id: "audio_1",
		startMs: 0,
		endMs: 10_000,
		clipId: "clip_1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		audioAssetId: "bgm",
		kind: "music",
		offsetSec: 0,
		gainDb: 0,
		origin: "user",
		...over,
	} as AxcutAudioRegion;
}

const trim = (over: Partial<AxcutTrimRange> = {}): AxcutTrimRange =>
	({
		id: "trim_1",
		assetId: "asset_1",
		clipId: "clip_1",
		startSec: 2,
		endSec: 4,
		origin: "user",
		reason: "",
		...over,
	}) as AxcutTrimRange;

describe("placeAudioRegions", () => {
	it("places an untrimmed region at its raw position, playing from its in-point", () => {
		const [p] = placeAudioRegions([region({ offsetSec: 3 })], [clip()], [], []);
		expect(p).toMatchObject({
			outputStartSec: 0,
			outputEndSec: 10,
			sourceInSec: 3,
			sourceOutSec: 13,
		});
	});

	it("pulls a region after a cut earlier by the removed duration", () => {
		const r = region({ startMs: 6000, endMs: 10_000, sourceStartSec: 6, sourceEndSec: 10 });
		const [p] = placeAudioRegions([r], [clip()], [trim()], []);
		// Raw 6 is 2s past the 2s cut → output 4.
		expect(p.outputStartSec).toBeCloseTo(4, 6);
		expect(p.outputEndSec).toBeCloseTo(8, 6);
	});

	it("shortens a region a cut runs through, rather than desynchronising what follows", () => {
		// The bed spans the whole clip and the cut removes 2s of it: 8s of programme is left,
		// so the bed plays 8s of file. Nothing after it moves relative to the picture.
		const [p] = placeAudioRegions([region()], [clip()], [trim()], []);
		expect(p.outputStartSec).toBeCloseTo(0, 6);
		expect(p.outputEndSec).toBeCloseTo(8, 6);
		expect(p.sourceOutSec - p.sourceInSec).toBeCloseTo(8, 6);
	});

	it("consumes only as much file as a sped-up stretch leaves room for", () => {
		// A 2x region over the whole clip: 10s of picture becomes 5s of programme, so the bed
		// plays 5s of file at 1x. The media is never pitched — only its span compresses.
		const speed = [
			{
				startMs: 0,
				endMs: 10_000,
				speed: 2,
				clipId: "clip_1",
				sourceStartSec: 0,
				sourceEndSec: 10,
			},
		];
		const [p] = placeAudioRegions([region()], [clip()], [], speed);
		expect(p.outputEndSec).toBeCloseTo(5, 6);
		expect(p.sourceOutSec).toBeCloseTo(5, 6);
	});

	it("advances each fragment of one pill to where the previous stopped", () => {
		// THE structural cost of the anchor model on continuous media: ventilation copies the
		// payload verbatim, so both fragments carry offsetSec 0. Handing that to the mixer
		// restarts the bed at the clip boundary — audible, and the reason this walk exists.
		const clipA = clip({ id: "clip_1" });
		const clipB = clip({
			id: "clip_2",
			assetId: "asset_2",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 10,
			timelineEndSec: 20,
		});
		const placements = placeAudioRegions(
			[
				region({
					id: "audio_1",
					startMs: 4000,
					endMs: 10_000,
					sourceStartSec: 4,
					sourceEndSec: 10,
				}),
				region({
					id: "audio_2",
					startMs: 10_000,
					endMs: 13_000,
					clipId: "clip_2",
					sourceStartSec: 0,
					sourceEndSec: 3,
				}),
			],
			[clipA, clipB],
			[],
			[],
		);
		expect(placements).toHaveLength(2);
		expect(placements[0]).toMatchObject({ sourceInSec: 0, sourceOutSec: 6 });
		expect(placements[1]).toMatchObject({ sourceInSec: 6, sourceOutSec: 9 });
		// Both fragments are ONE pill, so the inspector and the ruler address them together.
		expect(placements[0].pillId).toBe(placements[1].pillId);
	});

	it("does not advance the cursor for a fragment a trim removed entirely", () => {
		// The fragment plays nothing, so the fragment after it must carry on where the LAST
		// AUDIBLE one stopped — not skip the silenced fragment's worth of file.
		const clipA = clip({ id: "clip_1", sourceEndSec: 6, timelineEndSec: 6 });
		const clipB = clip({
			id: "clip_2",
			assetId: "asset_2",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 6,
			timelineEndSec: 10,
		});
		const placements = placeAudioRegions(
			[
				region({ id: "audio_1", startMs: 2000, endMs: 6000, sourceStartSec: 2, sourceEndSec: 6 }),
				region({
					id: "audio_2",
					startMs: 6000,
					endMs: 10_000,
					clipId: "clip_2",
					sourceStartSec: 0,
					sourceEndSec: 4,
				}),
			],
			[clipA, clipB],
			// Cut the whole of the first fragment's span out of clip_1.
			[trim({ startSec: 2, endSec: 6 })],
			[],
		);
		expect(placements).toHaveLength(1);
		expect(placements[0]).toMatchObject({ regionId: "audio_2", sourceInSec: 0, sourceOutSec: 4 });
	});

	it("drops a fragment whose clip was deleted", () => {
		const placements = placeAudioRegions([region({ clipId: "gone" })], [clip()], [], []);
		expect(placements).toEqual([]);
	});

	it("keeps two beds from different files apart", () => {
		// `assetId` is in NON_IDENTITY_FIELDS, which is why the field is named
		// `audioAssetId`: touching regions playing DIFFERENT files must not merge into one
		// pill and share an in-point cursor.
		const placements = placeAudioRegions(
			[
				region({ id: "a", startMs: 0, endMs: 5000, sourceStartSec: 0, sourceEndSec: 5 }),
				region({
					id: "b",
					audioAssetId: "other",
					startMs: 5000,
					endMs: 10_000,
					sourceStartSec: 5,
					sourceEndSec: 10,
				}),
			],
			[clip()],
			[],
			[],
		);
		expect(placements).toHaveLength(2);
		expect(placements[0].pillId).not.toBe(placements[1].pillId);
		// Each starts its own file at 0 rather than the second continuing the first.
		expect(placements[1].sourceInSec).toBe(0);
	});

	it("is empty for a project with no audio", () => {
		expect(placeAudioRegions([], [clip()], [], [])).toEqual([]);
	});
});

describe("resolveAudioPlayback", () => {
	const placements = placeAudioRegions(
		[region({ startMs: 2000, endMs: 8000, sourceStartSec: 2, sourceEndSec: 8, offsetSec: 1 })],
		[clip()],
		[],
		[],
	);

	it("maps the output playhead onto the file, offset by the in-point", () => {
		expect(resolveAudioPlayback(placements, 5)).toEqual({ targetTimeSec: 4, shouldPlay: true });
	});

	it("does not play before the region starts", () => {
		expect(resolveAudioPlayback(placements, 1).shouldPlay).toBe(false);
	});

	it("does not play past the region's end", () => {
		expect(resolveAudioPlayback(placements, 8).shouldPlay).toBe(false);
	});

	it("parks at the first in-point when there is nothing to play", () => {
		expect(resolveAudioPlayback(placements, 0).targetTimeSec).toBe(1);
		expect(resolveAudioPlayback([], 0)).toEqual({ targetTimeSec: 0, shouldPlay: false });
	});
});
