// The v1.7 (PROJECT_VERSION 2) import path, end to end.
//
// That format has no clip list — one recording plus regions — so migration mints a
// single clip with NO source extent and leaves every region unanchored (anchoring
// needs a clip with real extent; dropping the regions instead would lose user data).
// The duration only arrives later, when the renderer loads the media. These tests pin
// the moment that gap closes: the clip gets its real length AND the regions become
// anchored, so nothing is left on the fragile raw-ms-only representation.

import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../schema";
import { documentSchema } from "../schema";
import { migrateProjectDataToAxcutDocument } from "./migrate";
import { applyProbedDuration, PLACEHOLDER_DURATION_SEC } from "./timeline";

/** A v1.7 project file: one recording, one zoom region at 6–8s of that recording. */
function legacyProjectWithZoom() {
	return {
		version: 2,
		videoPath: "C:/rec/screen.webm",
		media: { videoPath: "C:/rec/screen.webm" },
		editor: {
			zoomRegions: [
				{ id: "z1", startMs: 6000, endMs: 8000, depth: 2, focus: { cx: 0.5, cy: 0.5 } },
			],
			annotationRegions: [],
			trimRegions: [],
			speedRegions: [],
			cameraFullscreenRegions: [],
		},
	} as never;
}

/** The CANONICAL zoom collection — what the native scene and the exporter read.
 *  (`legacyEditor.zoomRegions` is the v2 envelope kept for round-tripping back to the
 *  old format; nothing on the render path reads it.) */
const zoomsOf = (doc: AxcutDocument) =>
	(doc.zoomRanges ?? []) as unknown as Array<Record<string, unknown>>;

describe("applyProbedDuration — the v1.7 import gap", () => {
	it("opens a legacy project with an extent-less clip and unanchored regions", () => {
		// Documents the STARTING state this function exists to repair. If migration ever
		// learns the duration itself, this expectation is what will flag it.
		const doc = documentSchema.parse(migrateProjectDataToAxcutDocument(legacyProjectWithZoom()));
		const clip = doc.timeline.clips[0];
		expect(clip.sourceEndSec ?? 0).toBeLessThanOrEqual(clip.sourceStartSec);
		expect(zoomsOf(doc)[0].clipId).toBeUndefined();
	});

	it("gives the clip its real length and anchors the region once duration arrives", () => {
		const doc = documentSchema.parse(migrateProjectDataToAxcutDocument(legacyProjectWithZoom()));
		const assetId = doc.assets[0].id;
		const next = applyProbedDuration(doc, assetId, 30);

		const clip = next.timeline.clips[0];
		expect(clip.sourceEndSec).toBe(30);
		expect(clip.timelineEndSec).toBe(30);
		expect(next.assets[0].durationSec).toBe(30);

		// The region keeps the source moment it was authored on (6–8s of the recording),
		// now stated as an anchor rather than a ruler coordinate.
		const zoom = zoomsOf(next)[0];
		expect(zoom.clipId).toBe(clip.id);
		expect(zoom.sourceStartSec).toBeCloseTo(6, 5);
		expect(zoom.sourceEndSec).toBeCloseTo(8, 5);
		expect(zoom.startMs).toBe(6000);
		expect(zoom.endMs).toBe(8000);
	});

	it("also replaces the pre-probe placeholder length", () => {
		// The other clip that waits for a duration: inserted before its media reported one.
		const doc = documentSchema.parse(migrateProjectDataToAxcutDocument(legacyProjectWithZoom()));
		const assetId = doc.assets[0].id;
		const seeded: AxcutDocument = {
			...doc,
			timeline: {
				...doc.timeline,
				clips: [
					{
						...doc.timeline.clips[0],
						sourceEndSec: PLACEHOLDER_DURATION_SEC,
						timelineEndSec: PLACEHOLDER_DURATION_SEC,
					},
				],
			},
		};
		const next = applyProbedDuration(seeded, assetId, 12);
		expect(next.timeline.clips[0].sourceEndSec).toBe(12);
		expect(next.timeline.clips[0].timelineEndSec).toBe(12);
	});

	it("leaves a clip the user has already trimmed alone", () => {
		const doc = documentSchema.parse(migrateProjectDataToAxcutDocument(legacyProjectWithZoom()));
		const assetId = doc.assets[0].id;
		const trimmed: AxcutDocument = {
			...doc,
			timeline: {
				...doc.timeline,
				clips: [{ ...doc.timeline.clips[0], sourceEndSec: 9, timelineEndSec: 9 }],
			},
		};
		expect(applyProbedDuration(trimmed, assetId, 30)).toBe(trimmed);
	});

	it("ignores an unusable duration rather than stamping a bogus extent", () => {
		const doc = documentSchema.parse(migrateProjectDataToAxcutDocument(legacyProjectWithZoom()));
		const assetId = doc.assets[0].id;
		expect(applyProbedDuration(doc, assetId, 0)).toBe(doc);
		expect(applyProbedDuration(doc, assetId, Number.NaN)).toBe(doc);
	});

	it("only touches clips of the asset that reported its duration", () => {
		// Two assets both awaiting a duration: the one that didn't fire must not move.
		const doc = documentSchema.parse(migrateProjectDataToAxcutDocument(legacyProjectWithZoom()));
		const assetId = doc.assets[0].id;
		const other = { ...doc.timeline.clips[0], id: "clip_other", assetId: "asset_other" };
		const twoClips: AxcutDocument = {
			...doc,
			timeline: { ...doc.timeline, clips: [doc.timeline.clips[0], other] },
		};
		const next = applyProbedDuration(twoClips, assetId, 20);
		expect(next.timeline.clips[0].sourceEndSec).toBe(20);
		expect(next.timeline.clips[1].sourceEndSec ?? 0).toBeLessThanOrEqual(
			next.timeline.clips[1].sourceStartSec,
		);
		// …and the untouched clip is pushed down the ruler by exactly the widening.
		expect(next.timeline.clips[1].timelineStartSec).toBe(20);
	});
});
