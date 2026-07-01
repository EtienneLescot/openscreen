import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "./projectStore";
import { useTimeline } from "./useTimeline";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			get: bridgeMocks.get,
			create: bridgeMocks.create,
			save: bridgeMocks.save,
			addAsset: bridgeMocks.addAsset,
			removeAsset: bridgeMocks.removeAsset,
			listProjects: bridgeMocks.listProjects,
		},
	},
}));

const sampleDoc = {
	schemaVersion: 3,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
		primaryAssetId: "asset_1",
	},
	assets: [
		{
			id: "asset_1",
			kind: "video",
			label: "screen.webm",
			originalPath: "/tmp/screen.webm",
			durationSec: 30,
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "clip_a",
				assetId: "asset_1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		],
		gaps: [],
		skipRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	legacyEditor: null,
	agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
	preview: { strategy: "seek", revision: 0 },
	export: { preset: "final-balanced", lastJobId: null },
	history: { revisions: [] },
};

describe("useTimeline.editClip", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("updates the target clip in place and persists via the store", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.editClip("clip_a", {
				sourceStartSec: 1,
				sourceEndSec: 8,
				timelineStartSec: 2,
				timelineEndSec: 9,
			});
		});
		const doc = useProjectStore.getState().document;
		const updated = doc?.timeline.clips[0];
		expect(updated).toMatchObject({
			id: "clip_a",
			sourceStartSec: 1,
			sourceEndSec: 8,
			timelineStartSec: 2,
			timelineEndSec: 9,
		});
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
	});

	it("clamps end >= start when the user types them out of order", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.editClip("clip_a", {
				sourceStartSec: 7,
				sourceEndSec: 2,
			});
		});
		const updated = useProjectStore.getState().document?.timeline.clips[0];
		expect(updated?.sourceStartSec).toBe(2);
		expect(updated?.sourceEndSec).toBe(7);
	});

	it("no-ops when the clip id is unknown", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.editClip("clip_missing", { sourceStartSec: 1 });
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});
