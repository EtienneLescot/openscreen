// Issue #560, step 4. A cut authored from the voiceover lane used to be anchored on an
// AUDIO FRAGMENT — `resolvePlaybackSegments` matched nothing for it, so the word turned
// red and the film, the preview and the export were all unchanged. A silent lie.
//
// The pane now emits a RAW span and the write site resolves the clips under it. These pin
// the arithmetic that does it; the pane's own clamp is pinned in TranscriptPane.lanes.

import { describe, expect, it } from "vitest";
import { resolvePlaybackSegments } from "../document/timeline";
import type { AxcutClip, AxcutTrimRange } from "../schema";
import { placementRawSec, voiceoverPlacements } from "./aggregated-transcript";
import {
	coalescedTrimGroups,
	dropTrimPillsByIds,
	ventilateTimelineSpanToTrims,
} from "./trim-mapping";

/** Two 6s clips over one asset, laid end to end. */
const CLIPS: AxcutClip[] = [
	{
		id: "c1",
		assetId: "rec",
		sourceStartSec: 0,
		sourceEndSec: 6,
		timelineStartSec: 0,
		timelineEndSec: 6,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
	{
		id: "c2",
		assetId: "rec",
		sourceStartSec: 20,
		sourceEndSec: 26,
		timelineStartSec: 6,
		timelineEndSec: 12,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

/** The write site's arithmetic: a raw span becomes trim rows on the clips under it. */
function cut(startSec: number, endSec: number): AxcutTrimRange[] {
	return ventilateTimelineSpanToTrims(startSec, endSec, CLIPS).map((range, i) => ({
		id: `t${i}`,
		assetId: range.assetId,
		clipId: range.clipId,
		startSec: range.sourceStartSec,
		endSec: range.sourceEndSec,
		origin: "user" as const,
		reason: "",
	}));
}

const filmSec = (trims: AxcutTrimRange[]) =>
	resolvePlaybackSegments(CLIPS, trims).reduce(
		(sum, seg) => sum + ((seg.sourceEndSec ?? seg.sourceStartSec) - seg.sourceStartSec),
		0,
	);

const VOICE = {
	id: "vo",
	trackId: "vo",
	assetId: "aud",
	kind: "voiceover" as const,
	startMs: 0,
	endMs: 12_000,
	durationSec: 12,
	offsetMs: 0,
	gainDb: 0,
	loop: false,
	fadeInMs: 0,
	fadeOutMs: 0,
	muted: false,
	label: "",
	origin: "user" as const,
};

describe("a cut authored from the voiceover lane", () => {
	it("lands on a real clip, and the film gets shorter", () => {
		// A word at raw 2..3 of the take. The take carries no clip, so the old anchoring
		// wrote `clipId: "vo"` here and removed nothing at all.
		// biome-ignore lint/suspicious/noExplicitAny: fixture, not a schema exercise
		const [placement] = voiceoverPlacements([VOICE as any]);
		const rows = cut(placementRawSec(placement, 2, []), placementRawSec(placement, 3, []));
		expect(rows).toHaveLength(1);
		expect(CLIPS.map((c) => c.id)).toContain(rows[0].clipId);
		expect(filmSec([])).toBeCloseTo(12, 6);
		expect(filmSec(rows)).toBeCloseTo(11, 6);
	});

	it("becomes several rows and one pill when it crosses a clip boundary", () => {
		const rows = cut(5, 7);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.clipId)).toEqual(["c1", "c2"]);
		// Source time is per asset and the two clips draw from different positions, so the
		// rows cannot be one range — but they are one thing on the ruler.
		expect(rows.map((r) => [r.startSec, r.endSec])).toEqual([
			[5, 6],
			[20, 21],
		]);
		expect(coalescedTrimGroups(rows, CLIPS)).toHaveLength(1);
		expect(filmSec(rows)).toBeCloseTo(10, 6);
	});

	it("drops every row of the pill when one of them is restored", () => {
		const rows = cut(5, 7);
		// Restoring must not leave half the cut behind, with the word still gone and
		// nothing on the ruler to click.
		expect(dropTrimPillsByIds(rows, CLIPS, [rows[0].id])).toEqual([]);
	});

	it("writes nothing where there is no film", () => {
		const gapped = [CLIPS[0], { ...CLIPS[1], timelineStartSec: 9, timelineEndSec: 15 }];
		// Over an inter-clip gap...
		expect(ventilateTimelineSpanToTrims(7, 8, gapped)).toEqual([]);
		// ...and past the end of the programme. The caller shows an error rather than
		// falling back to the nearest clip: cutting the closest thing would remove
		// something the user never pointed at.
		expect(ventilateTimelineSpanToTrims(20, 22, CLIPS)).toEqual([]);
	});

	it("stays inside its own clip when a word straddles the edge", () => {
		// A word from raw 5.5 to 6.5 clamped to c1's extent cuts only c1 — unclamped it
		// would take the head of c2 with it, which the user never asked for.
		expect(cut(5.5, 6).map((r) => r.clipId)).toEqual(["c1"]);
		expect(cut(5.5, 6.5).map((r) => r.clipId)).toEqual(["c1", "c2"]);
	});
});
