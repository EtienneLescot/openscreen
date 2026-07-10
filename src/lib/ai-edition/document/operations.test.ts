// ponytail: tests for the renderer-side timeline-operation union + dispatcher
// in `src/lib/ai-edition/document/operations.ts`. Mirrors the axcut chat UI
// parity work — same operations, same summary shape, same document mutation
// rules. The IPC + service layer is exercised separately in
// `electron/ai-edition/chat-service.test.ts`.

import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { applyTimelineOperation } from "./operations";

function makeDoc(): AxcutDocument {
	const base = createEmptyDocument({ title: "Test", projectId: "proj_ops" });
	const asset = {
		id: "asset_1",
		kind: "video" as const,
		label: "Recording",
		originalPath: "C:/videos/rec.mp4",
		durationSec: 60,
	};
	return {
		...base,
		project: { ...base.project, primaryAssetId: asset.id },
		assets: [asset],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: asset.id,
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
	};
}

describe("applyTimelineOperation.add_trim_range", () => {
	it("appends a user-origin skip and returns a one-line summary", () => {
		const result = applyTimelineOperation(makeDoc(), {
			type: "add_trim_range",
			startSec: 5,
			endSec: 8,
		});
		expect(result.summary).toMatch(/added trim 0:05\.0.0:08\.0/);
		const next = result.document;
		const skips = next.timeline.trimRanges.filter((s) => s.assetId === "asset_1");
		expect(skips).toHaveLength(1);
		expect(skips[0]).toMatchObject({
			startSec: 5,
			endSec: 8,
			origin: "user",
		});
		expect(next.preview.revision).toBe(1);
	});

	it("normalises reversed bounds (end < start)", () => {
		const result = applyTimelineOperation(makeDoc(), {
			type: "add_trim_range",
			startSec: 10,
			endSec: 4,
		});
		const skip = result.document.timeline.trimRanges.find((s) => s.assetId === "asset_1");
		expect(skip?.startSec).toBe(4);
		expect(skip?.endSec).toBe(10);
	});
});

describe("applyTimelineOperation.drop_range", () => {
	it("returns intervals that exclude the cut and a one-line summary", () => {
		const result = applyTimelineOperation(makeDoc(), {
			type: "drop_range",
			assetId: "asset_1",
			startSec: 10,
			endSec: 20,
		});
		expect(result.summary).toMatch(/dropped 0:10\.0.0:20\.0/);
		const next = result.document;
		const asset = next.assets[0];
		expect(asset).toBeDefined();
		const totalKeep = next.timeline.clips
			.filter((c) => c.assetId === "asset_1")
			.reduce((sum, c) => sum + (c.sourceEndSec - c.sourceStartSec), 0);
		expect(totalKeep).toBe(50);
	});
});

describe("applyTimelineOperation.replace_timeline", () => {
	it("rebuilds clips from the kept intervals", () => {
		const result = applyTimelineOperation(makeDoc(), {
			type: "replace_timeline",
			intervals: [
				{ startSec: 0, endSec: 5 },
				{ startSec: 10, endSec: 30 },
			],
			reason: "trim silences",
		});
		expect(result.summary).toMatch(/rebuilt timeline .2 interval/);
		const clips = result.document.timeline.clips.filter((c) => c.assetId === "asset_1");
		expect(clips).toHaveLength(2);
		const totalClip = clips.reduce((s, c) => s + (c.sourceEndSec - c.sourceStartSec), 0);
		expect(totalClip).toBe(25);
	});
});

describe("applyTimelineOperation.restore_full_timeline", () => {
	it("drops every skip and restores a single full clip", () => {
		const doc = applyTimelineOperation(makeDoc(), {
			type: "add_trim_range",
			startSec: 5,
			endSec: 10,
		}).document;
		const restored = applyTimelineOperation(doc, { type: "restore_full_timeline" });
		expect(restored.summary).toBe("restored full timeline");
		const asset = restored.document.assets[0];
		expect(asset).toBeDefined();
		const totalClip = restored.document.timeline.clips
			.filter((c) => c.assetId === "asset_1")
			.reduce((s, c) => s + (c.sourceEndSec - c.sourceStartSec), 0);
		expect(totalClip).toBe(60);
		expect(restored.document.timeline.trimRanges).toHaveLength(0);
	});
});

describe("applyTimelineOperation.update_clip_range", () => {
	it("trims the named clip and reseats the timeline", () => {
		const result = applyTimelineOperation(makeDoc(), {
			type: "update_clip_range",
			clipId: "clip_1",
			sourceStartSec: 10,
			sourceEndSec: 25,
		});
		const clip = result.document.timeline.clips.find((c) => c.id === "clip_1");
		expect(clip?.sourceStartSec).toBe(10);
		expect(clip?.sourceEndSec).toBe(25);
	});
});
