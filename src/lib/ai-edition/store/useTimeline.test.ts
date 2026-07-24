import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "./projectStore";
import { useTimeline } from "./useTimeline";

const probeVideoDurationMock = vi.hoisted(() => vi.fn());
const probeVideoDimensionsMock = vi.hoisted(() =>
	vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
);

vi.mock("../timeline/duration", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../timeline/duration")>();
	return {
		...actual,
		probeVideoDuration: probeVideoDurationMock,
		probeVideoDimensions: probeVideoDimensionsMock,
	};
});

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
			video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
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
		trimRanges: [],
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

describe("useTimeline.insertClipAt background duration probe", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDurationMock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [
					...sampleDoc.assets,
					{
						id: "asset_2",
						kind: "video",
						label: "long.webm",
						originalPath: "/tmp/long.webm",
						durationSec: undefined,
						video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
					},
				],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("only resizes the probed clip and leaves earlier clips' positions untouched", async () => {
		// clip_a already sits at 0..10 (a "short clip"). Insert a second clip
		// for asset_2 after it — insertClipAt has no cached duration for
		// asset_2, so it lands at the 60s placeholder, then the background
		// probe (mocked here to resolve to a much shorter real duration)
		// corrects it. Regression test for the bug where the probe used to
		// shift EVERY sibling clip (including ones before it) by the delta
		// between the real and placeholder duration, corrupting their
		// positions and producing visual overlap.
		probeVideoDurationMock.mockResolvedValue(5);
		const { result } = renderHook(() => useTimeline());

		await act(async () => {
			await result.current.insertClipAt("asset_2", 1);
		});

		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips).toHaveLength(2);
		const clipA = clips?.find((c) => c.id === "clip_a");
		const inserted = clips?.find((c) => c.assetId === "asset_2");
		expect(clipA).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(inserted).toMatchObject({
			sourceEndSec: 5,
			timelineStartSec: 10,
			timelineEndSec: 15,
		});
	});
});

describe("useTimeline.moveClip / duplicateClip (delegates to document/timeline.ts)", () => {
	const twoClipDoc = {
		...sampleDoc,
		timeline: {
			...sampleDoc.timeline,
			clips: [
				sampleDoc.timeline.clips[0],
				{
					id: "clip_b",
					assetId: "asset_1",
					sourceStartSec: 10,
					sourceEndSec: 20,
					timelineStartSec: 10,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
				},
			],
		},
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: twoClipDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("moveClip reorders clips and persists the resequenced timeline", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.moveClip("clip_a", 1);
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips?.map((c) => c.id)).toEqual(["clip_b", "clip_a"]);
		expect(clips?.[0]).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(clips?.[1]).toMatchObject({ timelineStartSec: 10, timelineEndSec: 20 });
	});

	it("moveClip no-ops for an unknown clip id", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.moveClip("clip_missing", 0);
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("duplicateClip inserts a copy right after the original and selects it", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.duplicateClip("clip_a");
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips).toHaveLength(3);
		expect(clips?.[0].id).toBe("clip_a");
		expect(clips?.[2].id).toBe("clip_b");
		const copyId = clips?.[1].id;
		expect(copyId).toBeTruthy();
		expect(copyId).not.toBe("clip_a");
		expect(result.current.clipSelection).toBe(copyId);
	});

	it("duplicateClip no-ops for an unknown clip id", async () => {
		const { result } = renderHook(() => useTimeline());
		await act(async () => {
			await result.current.duplicateClip("clip_missing");
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("useTimeline backfills missing source dimensions on load", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDimensionsMock.mockReset();
		probeVideoDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 });
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// The reported bug: a project saved with a duration but no probed `video` dims (nothing
	// re-probes it on open) drops that clip from everything reading asset.video — the ratio
	// picker's ORIGINAL list, the output resolution, the export badges.
	it("probes a used asset that has a duration but no video dims, and persists them", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [{ ...sampleDoc.assets[0], video: undefined }],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
		renderHook(() => useTimeline());
		await waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		const saved = useProjectStore.getState().document?.assets.find((a) => a.id === "asset_1");
		expect(saved?.video).toMatchObject({ width: 1920, height: 1080 });
	});

	it("leaves an asset that already has video dims untouched", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc, // asset_1 already carries 1920x1080
			revision: 1,
			status: "ready",
			error: null,
		});
		renderHook(() => useTimeline());
		// Give any stray effect a chance to fire before asserting it didn't.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(probeVideoDimensionsMock).not.toHaveBeenCalled();
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("does not re-probe a used asset with no reachable file more than once", async () => {
		probeVideoDimensionsMock.mockResolvedValue(null); // probe fails (unreadable file)
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				assets: [{ ...sampleDoc.assets[0], video: undefined }],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
		const { rerender } = renderHook(() => useTimeline());
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		rerender();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		// Attempted once; the failure is remembered so a document change doesn't spin it again.
		expect(probeVideoDimensionsMock).toHaveBeenCalledTimes(1);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});
