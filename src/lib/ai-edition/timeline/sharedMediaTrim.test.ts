// Cross-layer regression for the one bug class the unit tests can each only see a
// third of: a scene with TWO clips over the SAME media. Source time is per asset, so
// the two clips share a coordinate space, and a cut authored on the second used to be
// read back differently by every consumer — struck through in BOTH transcript blocks,
// drawn on the FIRST clip's ruler, and removed from BOTH clips in playback/export.
//
// This walks one trim through the real pipeline (`applyTimelineOperation` → the three
// readers) and asserts they agree. The per-layer unit tests live next to each layer;
// what this file adds is that they still agree with each other.
import { describe, expect, it } from "vitest";
import { applyTimelineOperation } from "@/lib/ai-edition/document/operations";
import { resolvePlaybackSegments } from "@/lib/ai-edition/document/timeline";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { buildAggregatedSections } from "@/lib/ai-edition/timeline/aggregated-transcript";
import { coalescedTrimGroups } from "@/lib/ai-edition/timeline/trim-mapping";

function doc(): AxcutDocument {
	const base = createEmptyDocument({ title: "repro", projectId: "p" });
	const asset = {
		id: "asset_1",
		kind: "video" as const,
		label: "recording-1785529823210.mp4",
		originalPath: "/rec.mp4",
		durationSec: 11.8,
		cameraTrack: null,
	};
	const clip = (id: string, at: number) => ({
		id,
		assetId: asset.id,
		sourceStartSec: 0,
		sourceEndSec: 11.8,
		timelineStartSec: at,
		timelineEndSec: at + 11.8,
		wordRefs: [],
		origin: "user" as const,
		reason: "",
	});
	return {
		...base,
		project: { ...base.project, primaryAssetId: asset.id },
		assets: [asset],
		transcripts: [
			{
				assetId: asset.id,
				language: "fr",
				segments: [],
				words: [
					{ id: "w1", segmentId: "s", startSec: 1.3, endSec: 3.0, text: "Salut, comment ça va ?" },
					{ id: "w2", segmentId: "s", startSec: 3.4, endSec: 5.0, text: "Ben voilà, c'est tout ?" },
					{ id: "w3", segmentId: "s", startSec: 5.0, endSec: 6.7, text: "Ben voilà." },
					{ id: "w4", segmentId: "s", startSec: 8.4, endSec: 10.4, text: "*sifflement*" },
				],
			},
		],
		timeline: { ...base.timeline, clips: [clip("clip_1", 0), clip("clip_2", 11.8)] },
	};
}

describe("repro: trim on clip 2 of two clips sharing one media", () => {
	it("lands on clip 2 only, in the transcript, on the ruler and in playback", () => {
		// The user selects "*sifflement*" in CLIP 2's block and hits Delete.
		const next = applyTimelineOperation(doc(), {
			type: "add_trim_range",
			assetId: "asset_1",
			clipId: "clip_2",
			startSec: 8.4,
			endSec: 10.4,
			reason: "Skip from transcript",
		}).document;

		// 1. Transcript pane — the word is struck through in clip 2's block, and ONLY there.
		const sections = buildAggregatedSections(
			next.timeline.clips,
			next.transcripts,
			next.assets,
			next.timeline.trimRanges,
		);
		expect(sections[0].trimRuns).toHaveLength(0);
		expect(sections[1].trimRuns).toHaveLength(1);
		expect(sections[0].words.filter((w) => !w.kept)).toHaveLength(0);
		expect(sections[1].words.filter((w) => !w.kept).map((w) => w.word.text)).toEqual([
			"*sifflement*",
		]);

		// 2. Ruler — one pill, over clip 2 (timeline 11.8 + 8.4 = 20.2 … 22.2).
		const pills = coalescedTrimGroups(next.timeline.trimRanges, next.timeline.clips);
		expect(pills).toHaveLength(1);
		expect(pills[0].start).toBeCloseTo(20.2, 6);
		expect(pills[0].end).toBeCloseTo(22.2, 6);

		// 3. Playback / export — clip 1 whole, clip 2 split around the cut.
		const segs = resolvePlaybackSegments(next.timeline.clips, next.timeline.trimRanges);
		expect(segs.map((s) => s.id)).toEqual(["clip_1", "clip_2_seg1", "clip_2_seg2"]);
		expect(segs.at(-1)?.timelineEndSec).toBeCloseTo(21.6, 6); // 23.6 − 2s cut, once.
	});
});
