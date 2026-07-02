import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument, documentSchema } from "../schema";
import { suggestZoomRegions } from "./zoomSuggestions";

function fixtureDocument(overrides: Partial<AxcutDocument> = {}): AxcutDocument {
	const base = createEmptyDocument({ title: "Test", projectId: "proj_zoom" });
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Recording",
				originalPath: "C:/videos/rec.mp4",
				durationSec: 60,
			},
		],
		transcripts: [
			{
				assetId: "asset_1",
				language: "en",
				segments: [
					// Long speech — should produce a suggestion.
					{ id: "seg_1", kind: "speech", startSec: 0, endSec: 10, text: "Intro…", wordIds: [] },
					// Silence — ignored.
					{ id: "seg_2", kind: "silence", startSec: 10, endSec: 20, text: "", wordIds: [] },
					// Too short — ignored.
					{ id: "seg_3", kind: "speech", startSec: 20, endSec: 22, text: "Uh", wordIds: [] },
					// Long speech — second suggestion.
					{
						id: "seg_4",
						kind: "speech",
						startSec: 30,
						endSec: 40,
						text: "Deep dive…",
						wordIds: [],
					},
				],
				words: [],
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 60,
					timelineStartSec: 0,
					timelineEndSec: 60,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
		...overrides,
	});
}

describe("suggestZoomRegions", () => {
	it("proposes auto zoom regions over sustained speech segments", () => {
		const suggestions = suggestZoomRegions(fixtureDocument());
		expect(suggestions).toHaveLength(2);
		expect(suggestions[0]).toMatchObject({
			depth: 2,
			focusMode: "auto",
			source: "auto",
		});
		// Padded 0.4s inside the 0–10s segment, mapped 1:1 (single full clip).
		expect(suggestions[0].startMs).toBe(400);
		expect(suggestions[0].endMs).toBe(9600);
		expect(suggestions[1].startMs).toBe(30400);
	});

	it("skips segments that overlap existing zoom ranges", () => {
		const doc = fixtureDocument();
		const withZoom = {
			...doc,
			zoomRanges: [
				{
					id: "zoom_existing",
					startMs: 0,
					endMs: 12000,
					depth: 3 as const,
					focus: { cx: 0.5, cy: 0.5 },
				},
			] as AxcutDocument["zoomRanges"],
		};
		const suggestions = suggestZoomRegions(withZoom);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].startMs).toBe(30400);
	});

	it("returns nothing without a transcript", () => {
		const doc = { ...fixtureDocument(), transcripts: [], transcript: null };
		expect(suggestZoomRegions(doc)).toEqual([]);
	});

	it("skips speech that was cut out of the timeline", () => {
		const doc = fixtureDocument();
		// Timeline keeps only 0–20s of source: the 30–40s speech is gone.
		const trimmed = {
			...doc,
			timeline: {
				...doc.timeline,
				clips: [{ ...doc.timeline.clips[0], sourceEndSec: 20, timelineEndSec: 20 }],
			},
		};
		const suggestions = suggestZoomRegions(trimmed);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].startMs).toBe(400);
	});
});
