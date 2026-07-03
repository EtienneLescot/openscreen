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
			skipRanges: [
				{
					id: "skip_1",
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
	it("declares the six roadmap tools with mutation flags", () => {
		const names = AGENT_TOOL_SPECS.map((t) => t.name);
		expect(names).toEqual([
			"getCurrentDocument",
			"getTranscript",
			"addSkip",
			"setSkipRange",
			"setClipRange",
			"replaceTimeline",
		]);
		expect(isMutatingTool("getTranscript")).toBe(false);
		expect(isMutatingTool("replaceTimeline")).toBe(true);
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
		expect(snapshot.skipRanges[0].id).toBe("skip_1");
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

	it("addSkip appends an agent-origin skip range and normalizes reversed bounds", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addSkip",
			JSON.stringify({ startSec: 22, endSec: 20, reason: "silence" }),
		);
		expect(result.ok).toBe(true);
		expect(result.document).toBeDefined();
		const added = result.document?.timeline.skipRanges.at(-1);
		expect(added?.startSec).toBe(20);
		expect(added?.endSec).toBe(22);
		expect(added?.origin).toBe("agent");
		expect(result.summary).toMatch(/added skip 0:20\.0 – 0:22\.0/);
	});

	it("addSkip rejects unknown assets", () => {
		const result = executeAgentTool(
			fixtureDocument(),
			"addSkip",
			JSON.stringify({ startSec: 0, endSec: 1, assetId: "asset_missing" }),
		);
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
	});

	it("setSkipRange moves an existing range and errors on unknown ids", () => {
		const ok = executeAgentTool(
			fixtureDocument(),
			"setSkipRange",
			JSON.stringify({ skipRangeId: "skip_1", startSec: 14, endSec: 18 }),
		);
		expect(ok.ok).toBe(true);
		expect(ok.document?.timeline.skipRanges[0]).toMatchObject({ startSec: 14, endSec: 18 });

		const missing = executeAgentTool(
			fixtureDocument(),
			"setSkipRange",
			JSON.stringify({ skipRangeId: "skip_x", startSec: 0, endSec: 1 }),
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
		expect(timeline?.skipRanges.map((s) => [s.startSec, s.endSec])).toEqual([
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
		expect(payload.error).toMatch(/addSkip/);
	});

	it("rejects malformed JSON arguments and unknown tools", () => {
		expect(executeAgentTool(fixtureDocument(), "addSkip", "{not json").ok).toBe(false);
		expect(executeAgentTool(fixtureDocument(), "flyToTheMoon", "{}").ok).toBe(false);
	});
});
