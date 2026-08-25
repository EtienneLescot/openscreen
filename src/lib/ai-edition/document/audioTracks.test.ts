import { describe, expect, it } from "vitest";
import { createAudioTrack, createEmptyDocument } from "../schema";
import {
	appendAudioTrack,
	removeAudioTrack,
	setAudioTrackGain,
	setAudioTrackPlacement,
} from "./audioTracks";

const emptyDoc = () => createEmptyDocument({ projectId: "p", title: "t" });

const docWithTrack = () => {
	const track = createAudioTrack({ assetId: "asset_1", durationSec: 30, timelineStartSec: 5 });
	return { doc: appendAudioTrack(emptyDoc(), track), track };
};

describe("audioTracks document ops (issue #350)", () => {
	it("appendAudioTrack adds the track without mutating the input", () => {
		const doc = emptyDoc();
		const track = createAudioTrack({ assetId: "asset_1", durationSec: 12 });
		const next = appendAudioTrack(doc, track);
		expect(next.audioTracks).toEqual([track]);
		expect(doc.audioTracks).toEqual([]);
	});

	it("removeAudioTrack drops the matching track and is a no-op for unknown ids", () => {
		const { doc, track } = docWithTrack();
		expect(removeAudioTrack(doc, track.id).audioTracks).toEqual([]);
		expect(removeAudioTrack(doc, "nope").audioTracks).toEqual([track]);
	});

	it("setAudioTrackGain stores a finite dB and defaults NaN to 0", () => {
		const { doc, track } = docWithTrack();
		expect(setAudioTrackGain(doc, track.id, -6).audioTracks[0]?.gainDb).toBe(-6);
		expect(setAudioTrackGain(doc, track.id, Number.NaN).audioTracks[0]?.gainDb).toBe(0);
	});

	it("setAudioTrackPlacement writes position and trim together, staying schema-valid", () => {
		const { doc, track } = docWithTrack();
		const placed = setAudioTrackPlacement(doc, track.id, {
			timelineStartSec: 8,
			trimStartSec: 3,
			trimEndSec: 12,
		});
		expect(placed.audioTracks[0]).toMatchObject({
			timelineStartSec: 8,
			trimStartSec: 3,
			trimEndSec: 12,
		});
		// Same guards as the single-field ops: negatives floor, trimEnd >= trimStart.
		const guarded = setAudioTrackPlacement(doc, track.id, {
			timelineStartSec: -2,
			trimStartSec: 5,
			trimEndSec: 1,
		});
		expect(guarded.audioTracks[0]).toMatchObject({
			timelineStartSec: 0,
			trimStartSec: 5,
			trimEndSec: 5,
		});
	});

	it("update ops leave other tracks untouched", () => {
		const a = createAudioTrack({ assetId: "asset_1", durationSec: 10 });
		const b = createAudioTrack({ assetId: "asset_2", durationSec: 20 });
		const doc = appendAudioTrack(appendAudioTrack(emptyDoc(), a), b);
		const next = setAudioTrackGain(doc, b.id, -6);
		expect(next.audioTracks[0]).toEqual(a);
		expect(next.audioTracks[1]?.gainDb).toBe(-6);
	});
});
