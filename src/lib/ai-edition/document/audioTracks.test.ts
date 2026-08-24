import { describe, expect, it } from "vitest";
import { createAudioTrack, createEmptyDocument } from "../schema";
import {
	appendAudioTrack,
	moveAudioTrack,
	removeAudioTrack,
	setAudioTrackGain,
	setAudioTrackMute,
	setAudioTrackTrim,
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

	it("moveAudioTrack repositions the head and floors negatives at 0", () => {
		const { doc, track } = docWithTrack();
		expect(moveAudioTrack(doc, track.id, 9).audioTracks[0]?.timelineStartSec).toBe(9);
		expect(moveAudioTrack(doc, track.id, -4).audioTracks[0]?.timelineStartSec).toBe(0);
		expect(moveAudioTrack(doc, track.id, Number.NaN).audioTracks[0]?.timelineStartSec).toBe(0);
	});

	it("setAudioTrackTrim keeps trimEnd >= trimStart so the result stays schema-valid", () => {
		const { doc, track } = docWithTrack();
		const trimmed = setAudioTrackTrim(doc, track.id, { trimStartSec: 4, trimEndSec: 2 });
		expect(trimmed.audioTracks[0]?.trimStartSec).toBe(4);
		// trimEnd was pulled up to trimStart rather than left below it.
		expect(trimmed.audioTracks[0]?.trimEndSec).toBe(4);
	});

	it("setAudioTrackTrim clears the tail trim when trimEndSec is undefined", () => {
		const { doc, track } = docWithTrack();
		const withTail = setAudioTrackTrim(doc, track.id, { trimStartSec: 1, trimEndSec: 10 });
		const cleared = setAudioTrackTrim(withTail, track.id, { trimStartSec: 1 });
		expect(cleared.audioTracks[0]?.trimEndSec).toBeUndefined();
	});

	it("setAudioTrackGain stores a finite dB and defaults NaN to 0", () => {
		const { doc, track } = docWithTrack();
		expect(setAudioTrackGain(doc, track.id, -6).audioTracks[0]?.gainDb).toBe(-6);
		expect(setAudioTrackGain(doc, track.id, Number.NaN).audioTracks[0]?.gainDb).toBe(0);
	});

	it("setAudioTrackMute toggles mute without touching gain", () => {
		const { doc, track } = docWithTrack();
		const withGain = setAudioTrackGain(doc, track.id, -3);
		const muted = setAudioTrackMute(withGain, track.id, true);
		expect(muted.audioTracks[0]?.mute).toBe(true);
		expect(muted.audioTracks[0]?.gainDb).toBe(-3);
	});

	it("update ops leave other tracks untouched", () => {
		const a = createAudioTrack({ assetId: "asset_1", durationSec: 10 });
		const b = createAudioTrack({ assetId: "asset_2", durationSec: 20 });
		const doc = appendAudioTrack(appendAudioTrack(emptyDoc(), a), b);
		const next = moveAudioTrack(doc, b.id, 7);
		expect(next.audioTracks[0]).toEqual(a);
		expect(next.audioTracks[1]?.timelineStartSec).toBe(7);
	});
});
