import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import { AGENT_TOOL_SPECS, executeAgentTool, isMutatingTool } from "./agent-tools";

function fixtureDocument(): AxcutDocument {
	const base = createEmptyDocument({ title: "Test", projectId: "proj_1" });
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
					{ id: "seg_1", kind: "speech", startSec: 0, endSec: 5, text: "Hello", wordIds: [] },
					{ id: "seg_2", kind: "silence", startSec: 5, endSec: 8, text: "", wordIds: [] },
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
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
				{
					id: "clip_2",
					assetId: "asset_1",
					sourceStartSec: 30,
					sourceEndSec: 60,
					timelineStartSec: 30,
					timelineEndSec: 60,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			trimRanges: [
				{
					id: "trim_1",
					assetId: "asset_1",
					startSec: 10,
					endSec: 12,
					reason: "",
					origin: "user",
				},
			],
		},
	});
}

describe("agent-tools specs", () => {
	it("declares the clip/trim + effect tools with mutation flags", () => {
		const names = AGENT_TOOL_SPECS.map((t) => t.name);
		expect(names).toEqual([
			"getCurrentDocument",
			"getTranscript",
			"addTrim",
			"setTrim",
			"setClipRange",
			"replaceTimeline",
			"addZoom",
			"setZoom",
			"addSpeed",
			"setSpeed",
			"addAnnotation",
			"setAnnotation",
		]);
		expect(isMutatingTool("getTranscript")).toBe(false);
		expect(isMutatingTool("replaceTimeline")).toBe(true);
		expect(isMutatingTool("addZoom")).toBe(true);
		expect(isMutatingTool("setAnnotation")).toBe(true);
		expect(isMutatingTool("nope")).toBe(false);
	});
});

describe("executeAgentTool", () => {
	it("getCurrentDocument returns a compact snapshot with ids and times", () => {
		const result = executeAgentTool(fixtureDocument(), "getCurrentDocument", "");
		expect(result.ok).toBe(true);
		const snapshot = JSON.parse(result.resultJson);
		expect(snapshot.primaryAssetId).toBe("asset_1");
		expect(snapshot.clips.map((c: { id: string }) => c.id)).toEqual(["clip_1", "clip_2"]);
		expect(snapshot.trimRanges[0].id).toBe("trim_1");
		expect(snapshot.hasTranscript).toBe(true);
		expect(result.document).toBeUndefined();
	});

	it("getTranscript returns segments for the primary asset by default", () => {
		const result = executeAgentTool(fixtureDocument(), "getTranscript", "{}");
		expect(result.ok).toBe(true);
		const payload = JSON.parse(result.resultJson);
		expect(payload.assetId).toBe("asset_1");
		expect(payload.segments).toHaveLength(2);
		expect(payload.segments[1].kind).toBe("silence");
	});

	it("getTranscript fails cleanly when no transcript exists", () => {
		const doc = { ...fixtureDocument(), transcripts: [], transcript: null };
		const result = executeAgentTool(doc, "getTranscript", "{}");
		expect(result.ok).toBe(false);
		expect(JSON.parse(result.resultJson).error).toMatch(/No transcript/);
	});

	it("addTrim appends an agent-origin skip range and normalizes reversed bounds", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addTrim",
			JSON.stringify({ startSec: 22, endSec: 20, reason: "silence" }),
		);
		expect(result.ok).toBe(true);
		expect(result.document).toBeDefined();
		const added = result.document?.timeline.trimRanges.at(-1);
		expect(added?.startSec).toBe(20);
		expect(added?.endSec).toBe(22);
		expect(added?.origin).toBe("agent");
		expect(result.summary).toMatch(/added trim 0:20\.0 – 0:22\.0/);
	});

	it("addTrim rejects unknown assets", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addTrim",
			JSON.stringify({ startSec: 0, endSec: 1, assetId: "asset_missing" }),
		);
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
	});

	it("setTrim moves an existing range and errors on unknown ids", () => {
		const ok = executeAgentTool(
			fixtureDocument(),
			"setTrim",
			JSON.stringify({ trimRangeId: "trim_1", startSec: 14, endSec: 18 }),
		);
		expect(ok.ok).toBe(true);
		expect(ok.document?.timeline.trimRanges[0]).toMatchObject({ startSec: 14, endSec: 18 });

		const missing = executeAgentTool(
			fixtureDocument(),
			"setTrim",
			JSON.stringify({ trimRangeId: "trim_x", startSec: 0, endSec: 1 }),
		);
		expect(missing.ok).toBe(false);
	});

	it("setClipRange trims the clip and resequences downstream clips", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"setClipRange",
			JSON.stringify({ clipId: "clip_1", sourceStartSec: 0, sourceEndSec: 10 }),
		);
		expect(result.ok).toBe(true);
		const clips = result.document?.timeline.clips ?? [];
		expect(clips[0]).toMatchObject({
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
		});
		// Downstream clip reflows to start where the trimmed clip now ends.
		expect(clips[1]).toMatchObject({ timelineStartSec: 10, timelineEndSec: 40 });
	});

	it("replaceTimeline rebuilds clips and inverse skip ranges", () => {
		const doc = fixtureDocument();
		// Test the rebuild path: strip user-placed clips first so the tool
		// is allowed to operate (it refuses when origin:user clips are present).
		const stripped: AxcutDocument = {
			...doc,
			timeline: { ...doc.timeline, clips: [] },
		};
		const result = executeAgentTool(
			stripped,
			"replaceTimeline",
			JSON.stringify({
				intervals: [
					{ startSec: 0, endSec: 10 },
					{ startSec: 20, endSec: 30 },
				],
				reason: "cut silences",
			}),
		);
		expect(result.ok).toBe(true);
		const timeline = result.document?.timeline;
		expect(timeline?.clips).toHaveLength(2);
		expect(timeline?.trimRanges.map((s) => [s.startSec, s.endSec])).toEqual([
			[10, 20],
			[30, 60],
		]);
		expect(result.summary).toMatch(/2 intervals/);
	});

	it("replaceTimeline refuses when the timeline has user-placed clips", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"replaceTimeline",
			JSON.stringify({
				intervals: [{ startSec: 0, endSec: 30 }],
				reason: "remove silences",
			}),
		);
		expect(result.ok).toBe(false);
		const payload = JSON.parse(result.resultJson) as { error: string };
		expect(payload.error).toMatch(/user-placed clip/);
		expect(payload.error).toMatch(/addTrim/);
	});

	it("rejects malformed JSON arguments and unknown tools", () => {
		expect(executeAgentTool(fixtureDocument(), "addTrim", "{not json").ok).toBe(false);
		expect(executeAgentTool(fixtureDocument(), "flyToTheMoon", "{}").ok).toBe(false);
	});

	it("addZoom adds a schema-valid zoom in virtual-ms and normalizes bounds", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 12, endSec: 8, depth: 4, focus: { cx: 0.3, cy: 0.7 } }),
		);
		expect(result.ok).toBe(true);
		const zoom = result.document?.zoomRanges.at(-1);
		expect(zoom).toMatchObject({
			startMs: 8000,
			endMs: 12000,
			depth: 4,
			focus: { cx: 0.3, cy: 0.7 },
		});
		// The produced document must round-trip through the schema.
		expect(() => documentSchema.parse(result.document)).not.toThrow();
	});

	it("setZoom patches only the fields passed", () => {
		const withZoom = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 2, endSec: 4 }),
		).document as AxcutDocument;
		const id = withZoom.zoomRanges[0].id;
		const result = executeAgentTool(withZoom, "setZoom", JSON.stringify({ zoomId: id, depth: 6 }));
		expect(result.ok).toBe(true);
		expect(result.document?.zoomRanges[0]).toMatchObject({ startMs: 2000, endMs: 4000, depth: 6 });
		expect(executeAgentTool(withZoom, "setZoom", JSON.stringify({ zoomId: "nope" })).ok).toBe(
			false,
		);
	});

	it("addSpeed writes a legacyEditor speed region the snapshot exposes", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addSpeed",
			JSON.stringify({ startSec: 5, endSec: 9, speed: 2 }),
		);
		expect(result.ok).toBe(true);
		const legacy = result.document?.legacyEditor as Record<string, unknown>;
		const regions = legacy.speedRegions as Array<{ startMs: number; endMs: number; speed: number }>;
		expect(regions.at(-1)).toMatchObject({ startMs: 5000, endMs: 9000, speed: 2 });
		expect(() => documentSchema.parse(result.document)).not.toThrow();
	});

	it("addAnnotation adds a schema-valid text annotation", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addAnnotation",
			JSON.stringify({ startSec: 1, endSec: 3, text: "Look here", x: 20, y: 80 }),
		);
		expect(result.ok).toBe(true);
		const ann = result.document?.annotations.at(-1);
		expect(ann).toMatchObject({
			startMs: 1000,
			endMs: 3000,
			type: "text",
			textContent: "Look here",
			position: { x: 20, y: 80 },
		});
		expect(() => documentSchema.parse(result.document)).not.toThrow();
	});

	it("snapshot exposes clips/trims/effects as virtual-time groups with a time-base note", () => {
		const withEffects = executeAgentTool(
			fixtureDocument(),
			"addZoom",
			JSON.stringify({ startSec: 3, endSec: 6, depth: 2 }),
		).document as AxcutDocument;
		const snapshot = JSON.parse(executeAgentTool(withEffects, "getCurrentDocument", "").resultJson);
		expect(snapshot.timeBaseNote).toMatch(/virtual/);
		expect(snapshot.zoomRanges[0]).toMatchObject({ startSec: 3, endSec: 6, depth: 2 });
		expect(snapshot.trimRanges[0].id).toBe("trim_1");
		// counts-only fields are gone in favour of the labelled effect lists.
		expect(snapshot.zoomRangeCount).toBeUndefined();
		expect(snapshot.annotationCount).toBeUndefined();
	});
});
