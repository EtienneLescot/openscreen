// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutDocument } from "../schema";
import { axcutSchemaVersion } from "../schema";
import { useProjectStore } from "./projectStore";
import { clearHistory, redo, undo } from "./undo";
import { future, past } from "./undoStack";
import { useTimeline } from "./useTimeline";

/**
 * `useTimeline` reads the locale — `addAnnotation` seeds a new region with the
 * translated default text — so it needs the provider. One helper rather than a
 * wrapper argument on every call site.
 */
const renderTimeline = () => renderHook(() => useTimeline(), { wrapper: I18nProvider });

const probeVideoDurationMock = vi.hoisted(() => vi.fn());
const probeVideoDimensionsMock = vi.hoisted(() =>
	vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
);
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

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

const sampleDoc: AxcutDocument = {
	// ponytail: the bridge contract after the migration hoist is the CURRENT version —
	// every load site (DocumentService, browserShim) runs `migrateRawDocumentToCurrent`
	// before returning, and the renderer's `parseDocument` is a pure current-version
	// validator. Test fixtures model the post-hoist contract, so they read the version
	// off `axcutSchemaVersion` instead of restating it.
	// Annotated `AxcutDocument` rather than left to inference: the document type
	// pins `schemaVersion` to the LITERAL 7 and `kind` to `"video"`, both of which
	// an unannotated object literal widens — and the annotation makes every
	// required field (`cameraTrack`) a compile error when it is missing instead of
	// a fixture that silently drifts from the schema.
	schemaVersion: axcutSchemaVersion,
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
			// No webcam was recorded alongside this screen capture.
			cameraTrack: null,
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
};

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
						cameraTrack: null,
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
		const { result } = renderTimeline();

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
	const twoClipDoc: AxcutDocument = {
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
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.moveClip("clip_a", 1);
		});
		const clips = useProjectStore.getState().document?.timeline.clips;
		expect(clips?.map((c) => c.id)).toEqual(["clip_b", "clip_a"]);
		expect(clips?.[0]).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		expect(clips?.[1]).toMatchObject({ timelineStartSec: 10, timelineEndSec: 20 });
	});

	it("moveClip no-ops for an unknown clip id", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.moveClip("clip_missing", 0);
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("duplicateClip inserts a copy right after the original and selects it", async () => {
		const { result } = renderTimeline();
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
		const { result } = renderTimeline();
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
		renderTimeline();
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
		renderTimeline();
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
		const { rerender } = renderTimeline();
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

describe("useTimeline.applyClipEdit (Edit-clip modal)", () => {
	const anchoredZoom = (id: string, s: number, e: number) => ({
		id,
		startMs: s * 1000,
		endMs: e * 1000,
		clipId: "clip_a",
		sourceStartSec: s,
		sourceEndSec: e,
		depth: 3 as const,
		focus: { cx: 0.5, cy: 0.5 },
	});

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: {
				...sampleDoc,
				zoomRanges: [anchoredZoom("z_keep", 2, 3), anchoredZoom("z_drop", 6, 8)],
			},
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("shrinks the clip's timeline width to match the narrowed source window", async () => {
		const { result } = renderTimeline();
		// Trim the 10s clip down to its first 4s of source.
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 4);
		});
		const clip = useProjectStore.getState().document?.timeline.clips[0];
		expect(clip).toMatchObject({ sourceStartSec: 0, sourceEndSec: 4 });
		// The width followed the edit instead of keeping its stale 10s extent.
		expect(clip?.timelineStartSec).toBe(0);
		expect(clip?.timelineEndSec).toBe(4);
	});

	it("drops a pill sitting over the truncated tail and keeps the one that survives", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 4);
		});
		const zooms = useProjectStore.getState().document?.zoomRanges ?? [];
		// z_keep (source 2-3) stays; z_drop (source 6-8) is entirely past the new 4s end.
		expect(zooms.map((z) => z.id)).toEqual(["z_keep"]);
		expect(zooms[0]).toMatchObject({
			sourceStartSec: 2,
			sourceEndSec: 3,
			startMs: 2000,
			endMs: 3000,
		});
	});

	it("shortens a pill that straddles the new clip end to the surviving overlap", async () => {
		useProjectStore.setState({
			document: {
				...sampleDoc,
				zoomRanges: [anchoredZoom("z_edge", 3, 7)],
			},
		});
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 5);
		});
		const zooms = useProjectStore.getState().document?.zoomRanges ?? [];
		expect(zooms).toHaveLength(1);
		// 3-7 clamped to the [0,5] window → 3-5.
		expect(zooms[0]).toMatchObject({
			sourceStartSec: 3,
			sourceEndSec: 5,
			startMs: 3000,
			endMs: 5000,
		});
	});

	// #355. Apply used to fire `updateClipSourceRange` and `updateClipCrop` as two
	// concurrent saves, each built from the same pre-Apply document — so the second
	// write clobbered the first and one of the two edits vanished with no error and no
	// toast. Which one survived depended on IPC timing, which is why it read as "the app
	// randomly forgets my crop".
	it("keeps BOTH the source range and the crop when Apply changes them together", async () => {
		const { result } = renderTimeline();
		const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 4, crop);
		});
		const clip = useProjectStore.getState().document?.timeline.clips[0];
		expect(clip).toMatchObject({ sourceStartSec: 0, sourceEndSec: 4, cropRegion: crop });
		// The width still followed the range edit — the crop is applied to the
		// RESEQUENCED clips, not to a stale copy of them.
		expect(clip?.timelineEndSec).toBe(4);
		// One user action, one document, one write: two saves is the race itself.
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
	});

	it("clears the crop on an explicit null and leaves it alone on undefined", async () => {
		useProjectStore.setState({
			document: {
				...sampleDoc,
				timeline: {
					...sampleDoc.timeline,
					clips: [
						{ ...sampleDoc.timeline.clips[0], cropRegion: { x: 0, y: 0, width: 0.5, height: 1 } },
					],
				},
			},
		});
		const { result } = renderTimeline();
		// `undefined` is the modal's "crop section untouched" — the stored region stays.
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 6);
		});
		expect(useProjectStore.getState().document?.timeline.clips[0].cropRegion).toEqual({
			x: 0,
			y: 0,
			width: 0.5,
			height: 1,
		});
		// `null` is "reset to no crop", stored as an absent field rather than the
		// identity region.
		await act(async () => {
			await result.current.applyClipEdit("clip_a", 0, 6, null);
		});
		expect(useProjectStore.getState().document?.timeline.clips[0].cropRegion).toBeUndefined();
	});
});

// #353. The toolbar button and the `C` shortcut both used to write a region on a
// project with no webcam: it persists into `legacyEditor.cameraFullscreenRegions`,
// renders nothing in the preview (PreviewCanvas short-circuits on a missing
// `webcamRect`) and nothing in the export, forever, with no feedback. The gate lives
// in the shared mutation so both entry points — and any future one — are covered.
describe("useTimeline.addCameraFullscreen (camera gate)", () => {
	const cameraAsset = {
		...sampleDoc.assets[0],
		cameraTrack: {
			sourcePath: "/tmp/camera.webm",
			startMs: 0,
			offsetMs: 0,
			visible: true,
			// Dimensions filled in so the hook's backfill probe has nothing to do — an
			// unprobed camera would fire its own `saveDocument` alongside this test's.
			width: 1280,
			height: 720,
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
			document: sampleDoc,
			currentTimeSec: 1,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("writes nothing when no clip on the timeline has a camera", async () => {
		// sampleDoc's only asset carries `cameraTrack: null`.
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraFullscreen();
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.legacyEditor).toBeNull();
		expect(result.current.cameraFullscreenRegions).toEqual([]);
	});

	it("still writes a region when a clip's asset carries a camera", async () => {
		useProjectStore.setState({ document: { ...sampleDoc, assets: [cameraAsset] } });
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCameraFullscreen();
		});
		const legacy = useProjectStore.getState().document?.legacyEditor as Record<string, unknown>;
		const regions = legacy.cameraFullscreenRegions as Array<{ startMs: number; endMs: number }>;
		expect(regions).toHaveLength(1);
		// 2s at the playhead (currentTimeSec = 1), the shared default.
		expect(regions[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
	});
});

describe("useTimeline.addAnnotation", () => {
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
			currentTimeSec: 1,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("creates a text annotation carrying the localised default text", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addAnnotation();
		});
		const annotations = useProjectStore.getState().document?.annotations ?? [];
		expect(annotations).toHaveLength(1);
		// Real text, not an empty field. An empty annotation renders nothing at
		// all, so adding one used to change nothing on the canvas; the
		// inspector's placeholder is CSS ghost text that never reaches `content`
		// and therefore never reached the compositor. DEFAULT_LOCALE is `en`.
		expect(annotations[0]).toMatchObject({ type: "text", content: "Hello" });
		// Still auto-selected, so its inspector opens ready to be typed over.
		expect(result.current.selection).toEqual({
			kind: "annotation",
			id: (annotations[0] as { id: string }).id,
		});
	});
});

describe("useTimeline zoom modifiers (rotation + focus mode)", () => {
	const docWithZoom: AxcutDocument = {
		...sampleDoc,
		zoomRanges: [
			{
				id: "zoom_a",
				startMs: 1000,
				endMs: 3000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				// v5 clip anchor: clip_a draws source 0..10 at timeline 0..10, so the
				// 1000..3000ms ruler span is source 1..3 of that clip. `startMs`/`endMs`
				// stay as the derived cache. (The fixture used to carry a
				// `clipStartOffsetMs` that exists in no schema and no reader.)
				clipId: "clip_a",
				sourceStartSec: 1,
				sourceEndSec: 3,
			},
		],
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
			document: docWithZoom,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("sets a 3D rotation preset on the region", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "iso");
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			id: "zoom_a",
			rotationPreset: "iso",
		});
	});

	it("clears the preset back to a flat frame", async () => {
		// "None" in the UI is the ABSENCE of a preset, not a fourth one: the schema field is
		// optional and the native side treats anything unrecognised as zero rotation.
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "iso");
		});
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", undefined);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].rotationPreset).toBeUndefined();
	});

	it("switches focus mode without disturbing the rotation preset", async () => {
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.updateZoomRotation("zoom_a", "left");
		});
		await act(async () => {
			await result.current.updateZoomFocusMode("zoom_a", "auto");
		});
		expect(useProjectStore.getState().document?.zoomRanges[0]).toMatchObject({
			rotationPreset: "left",
			focusMode: "auto",
		});
	});

	it("rolls a live focus edit back when its commit cannot be saved", async () => {
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "project file locked" });
		const { result } = renderTimeline();

		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));
		expect(useProjectStore.getState().document?.zoomRanges[0]?.focus).toEqual({
			cx: 0.8,
			cy: 0.2,
		});

		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(useProjectStore.getState().document?.zoomRanges[0]?.focus).toEqual({
			cx: 0.5,
			cy: 0.5,
		});
		// Still dirty, deliberately. The rollback target is the document this drag
		// started from, not the last SAVED one, so claiming "clean" would let the window
		// close on unsaved work without a prompt.
		expect(useProjectStore.getState().dirty).toBe(true);
		// The live edit advanced revision once; restoring a different document
		// advances it again so async work cannot mistake the rollback for the
		// optimistic document it replaced.
		expect(useProjectStore.getState().revision).toBe(3);
		expect(toastErrorMock).toHaveBeenCalledWith("Failed to save project", {
			description: "project file locked",
		});
	});

	it("does not restore another project's document after the project changed", async () => {
		// A drag does not always end in a commit: `ZoomFocusOverlay` unmounts the instant
		// `focusMode` flips to "auto", so `endDrag` never runs and the snapshot outlives
		// the project. Restoring it into the NEXT project put project A's document in
		// project B, and the following successful save wrote A over B on disk.
		const { result, rerender } = renderTimeline();

		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));

		const otherProjectDoc: AxcutDocument = {
			...docWithZoom,
			project: { ...docWithZoom.project, id: "proj_other", title: "Other" },
		};
		act(() => {
			useProjectStore.setState({ projectId: "proj_other", document: otherProjectDoc });
		});
		rerender();

		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "project file locked" });
		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(useProjectStore.getState().document?.project.id).toBe("proj_other");
	});
});

// Regression guard for the playhead-stutter fix. `currentTimeSec` is rewritten on
// every animation frame during playback, and `useTimeline()` is called by the editor
// shell — so subscribing to the playhead here re-rendered the entire editor (timeline,
// clips, waveforms, inspector) 60×/s, which is exactly what made the playhead itself
// stutter. The hook must read the playhead imperatively: zero re-renders per tick, but
// still the LIVE value at the moment an action fires.
describe("useTimeline is not re-rendered by playhead ticks", () => {
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
			currentTimeSec: 0,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not re-render across a second of 60 Hz playhead writes", () => {
		let renders = 0;
		renderHook(
			() => {
				renders++;
				return useTimeline();
			},
			{ wrapper: I18nProvider },
		);
		const baseline = renders;

		// One act() per write: a single batched act() would collapse all 60 into one
		// React pass and hide the very thing this asserts.
		for (let i = 1; i <= 60; i++) {
			act(() => {
				useProjectStore.getState().setCurrentTime(i / 60);
			});
		}

		expect(renders - baseline).toBe(0);
		expect(useProjectStore.getState().currentTimeSec).toBeCloseTo(1);
	});

	it("still anchors a new region at the live playhead", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(4.2);
		});
		await act(async () => {
			await result.current.addZoom();
		});
		expect(useProjectStore.getState().document?.zoomRanges.at(-1)).toMatchObject({
			startMs: 4200,
			endMs: 6200,
		});
	});

	// Pasting a copied trim is exactly this call: a trim carries no properties, so
	// all a copy holds is its length, and paste recreates one that long at the
	// playhead. Same primitive the toolbar's cut button uses.
	it("creates a trim of the requested length", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(3);
		});
		await act(async () => {
			await result.current.addTrim(1.25);
		});
		const trim = useProjectStore.getState().document?.timeline.trimRanges.at(-1);
		expect((trim?.endSec ?? 0) - (trim?.startSec ?? 0)).toBeCloseTo(1.25, 6);
	});

	// The timeline's toolbar passes a duration worth a fixed number of pixels at
	// the current zoom; every other entry point keeps the 2 s above.
	it("honours a caller-supplied duration", async () => {
		const { result } = renderTimeline();
		act(() => {
			useProjectStore.getState().setCurrentTime(4.2);
		});
		await act(async () => {
			await result.current.addZoom(0.4);
		});
		expect(useProjectStore.getState().document?.zoomRanges.at(-1)).toMatchObject({
			startMs: 4200,
			endMs: 4600,
		});
	});
});

describe("useTimeline selection", () => {
	// A pill and a clip are one selection, not two. While both could be set at
	// once, copy/paste keyed off "is a clip selected?" and so acted on the clip
	// whatever the user had actually clicked.
	it("lets a clip and a pill cancel each other", () => {
		const { result } = renderTimeline();

		act(() => result.current.selectClip("clip_1"));
		expect(result.current.clipSelection).toBe("clip_1");

		act(() => result.current.selectRegion("zoom", "z1"));
		expect(result.current.selection).toMatchObject({ kind: "zoom", id: "z1" });
		expect(result.current.clipSelection).toBeNull();

		act(() => result.current.selectClip("clip_2"));
		expect(result.current.clipSelection).toBe("clip_2");
		expect(result.current.selection).toBeNull();
		expect(result.current.multiSelection).toEqual([]);

		act(() => result.current.clearSelection());
		expect(result.current.selection).toBeNull();
		expect(result.current.clipSelection).toBeNull();
	});
});

describe("useTimeline save failures", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		toastErrorMock.mockReset();
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	it("surfaces a rejected mutation without applying it or leaking the rejection", async () => {
		const { result } = renderTimeline();

		await act(async () => {
			await expect(result.current.removeClip("clip_a")).resolves.toBeUndefined();
		});

		expect(toastErrorMock).toHaveBeenCalledWith("Failed to save project", {
			description: "disk full",
		});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
		expect(useProjectStore.getState().document?.timeline.clips[0]?.id).toBe("clip_a");
	});

	it("reports 0 zooms added when the bulk write fails", async () => {
		// The count is what the Auto-enhance caller shows in its success toast, so a
		// failed write returning `suggestions.length` produced "Added 3 automatic zooms"
		// stacked on "Failed to save project", with no zoom anywhere. The caller guards
		// on this 0 (`V4Timeline` runAutoZooms).
		const { result } = renderTimeline();

		let added: number | undefined;
		await act(async () => {
			added = await result.current.addZoomsBulk([
				{ span: { start: 1000, end: 2000 }, focus: { cx: 0.5, cy: 0.5 } },
			]);
		});

		expect(added).toBe(0);
		expect(useProjectStore.getState().document?.zoomRanges).toHaveLength(0);
	});
});

describe("useTimeline undo history", () => {
	// `addAsset` (electron/ai-edition/document-service.ts) never writes `durationSec`,
	// so EVERY freshly imported asset lands at the 60s placeholder and fires the
	// background probe. Anything the probe records is therefore on the undo stack of
	// every single drop, which is what makes these two the common case and not an
	// edge one.
	const unprobed = {
		id: "asset_3",
		kind: "video" as const,
		label: "fresh-import.mp4",
		originalPath: "/tmp/fresh-import.mp4",
		durationSec: undefined,
		// No `video` either: that is what `addAsset` produces, and it is what makes
		// `probeAndCorrectClip` save even once the clip it came for is gone.
		cameraTrack: null,
	};

	const docWithZoom: AxcutDocument = {
		...sampleDoc,
		zoomRanges: [
			{
				id: "zoom_a",
				startMs: 1000,
				endMs: 3000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				clipId: "clip_a",
				sourceStartSec: 1,
				sourceEndSec: 3,
			},
		],
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDurationMock.mockReset();
		probeVideoDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 });
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	function seed(document: AxcutDocument) {
		useProjectStore.setState({
			projectId: "proj_test",
			document,
			revision: 1,
			status: "ready",
			error: null,
		});
	}

	it("keeps the background duration probe off the undo stack", async () => {
		// Without `{ history: false }` on `probeAndCorrectClip`'s save, dropping a clip
		// left `past` = [beforeDrop, dropWithPlaceholderClip]: the first Ctrl+Z snapped
		// the clip back to a 60s placeholder instead of removing it.
		seed({ ...sampleDoc, assets: [...sampleDoc.assets, unprobed] });
		probeVideoDurationMock.mockResolvedValue(5);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.insertClipAt("asset_3", 1);
		});
		await waitFor(() => {
			const inserted = useProjectStore
				.getState()
				.document?.timeline.clips.find((c) => c.assetId === "asset_3");
			expect(inserted?.sourceEndSec).toBe(5);
		});

		// One step for the drop the user made, none for the probe that corrected it.
		expect(past).toHaveLength(1);
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
	});

	it("does not let a probe landing after an undo destroy the redo", async () => {
		// The probe is detached from the drop, so it can resolve at any point — including
		// after the user has already pressed Ctrl+Z. A recording save there ran
		// `pushHistory`, which clears `future` on its way past: redo was gone, wiped by a
		// write the user never made and never saw.
		seed({ ...sampleDoc, assets: [...sampleDoc.assets, unprobed] });
		let landProbe!: (durationSec: number) => void;
		probeVideoDurationMock.mockReturnValue(
			new Promise<number>((resolvePromise) => {
				landProbe = resolvePromise;
			}),
		);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.insertClipAt("asset_3", 1);
		});
		expect(past).toHaveLength(1);

		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
		expect(future).toHaveLength(1);

		await act(async () => {
			landProbe(5);
			// The clip is gone, so only the dimensions half of the probe still has
			// anything to write — and that is exactly the write that used to be recorded.
			await new Promise((resolveTick) => setTimeout(resolveTick, 0));
		});

		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);
		act(() => {
			expect(redo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(2);
	});

	it("leaves no undo step behind a focus drag whose commit failed", async () => {
		// The drag used to push its pre-drag document from the FIRST `setDocument`. When
		// the commit then failed, `commitZoomFocus` restored that same document through
		// `setState` — which cannot pop the entry. `past` was left holding a snapshot
		// identical to what was on screen (a Ctrl+Z that visibly does nothing) and
		// `future` had already been wiped by the push.
		seed(docWithZoom);
		const { result } = renderTimeline();

		// An edit and an undo, so there is a redo entry to lose.
		await act(async () => {
			await result.current.updateZoomDepth("zoom_a", 5);
		});
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);

		const beforeDrag = useProjectStore.getState().document;
		bridgeMocks.save.mockResolvedValue({ success: false, error: "disk full" });
		act(() => {
			result.current.updateZoomFocusLive("zoom_a", { cx: 0.2, cy: 0.3 });
			result.current.updateZoomFocusLive("zoom_a", { cx: 0.25, cy: 0.35 });
		});
		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(useProjectStore.getState().document).toBe(beforeDrag);
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);
		act(() => {
			expect(redo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].depth).toBe(5);
	});

	it("records one undo step for a whole focus drag once it commits", async () => {
		// The other half of the same change: moving the record to the commit must not
		// lose it. Sixty pointermoves, one Ctrl+Z, back to where the drag started.
		seed(docWithZoom);
		const { result } = renderTimeline();

		act(() => {
			for (let i = 0; i < 60; i++) {
				result.current.updateZoomFocusLive("zoom_a", { cx: 0.2 + i / 1000, cy: 0.3 });
			}
		});
		expect(past).toHaveLength(0);

		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(past).toHaveLength(1);
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.zoomRanges[0].focus).toEqual({
			cx: 0.5,
			cy: 0.5,
		});
	});
});

// What a drag's snapshot is allowed to still be holding once the drag is over.
//
// `zoomFocusRollbackRef` / `annotationRollbackRef` hold the document a drag started
// from, kept until the commit that records it. A drag does not always reach a commit,
// and both commits are reachable without one: the inspector's annotation `<textarea>`
// writes live on every keystroke and commits `onBlur`, so closing the panel unmounts the
// focused node before blur can fire (the region's own delete button is an `onClick`, which
// runs after blur, so that route does not reach here) -- and `SliderCell` wires
// mouseup/touchend/keyup straight to `onCommit` with no `onChange` in front, so a bare
// click on a stroke-width thumb reaches `commitAnnotationChange()` carrying that
// leftover. `NewEditorShell` builds ONE `useTimeline()` and hands it to the inspector,
// so the abandonable live write and the bare commit share an instance.
describe("useTimeline drag snapshots", () => {
	const docWithRegions: AxcutDocument = {
		...sampleDoc,
		zoomRanges: [
			{
				id: "zoom_a",
				startMs: 1000,
				endMs: 3000,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				clipId: "clip_a",
				sourceStartSec: 1,
				sourceEndSec: 3,
			},
		],
		annotations: [
			{
				id: "ann_a",
				startMs: 1000,
				endMs: 3000,
				clipId: "clip_a",
				sourceStartSec: 1,
				sourceEndSec: 3,
				type: "text",
				content: "before",
				textContent: "",
				position: { x: 50, y: 50 },
				size: { width: 30, height: 20 },
				style: {
					color: "#ffffff",
					backgroundColor: "transparent",
					fontSize: 32,
					fontFamily: "Inter",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					textAlign: "center",
					textAnimation: "none",
				},
				zIndex: 1,
			},
		],
	};

	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		probeVideoDimensionsMock.mockResolvedValue({ width: 1920, height: 1080 });
		bridgeMocks.save.mockImplementation(async (doc: typeof sampleDoc) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_test",
			document: docWithRegions,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		clearHistory();
		vi.clearAllMocks();
	});

	/** Two recording edits between the abandoned live write and the bare commit, so the
	 *  stale snapshot is one the stack has already buried. */
	async function twoZoomDepthEdits(result: { current: ReturnType<typeof useTimeline> }) {
		await act(async () => {
			await result.current.updateZoomDepth("zoom_a", 4);
		});
		await act(async () => {
			await result.current.updateZoomDepth("zoom_a", 5);
		});
	}

	it("does not hand a bare annotation commit a base the edits since have buried", async () => {
		const { result } = renderTimeline();

		// The keystrokes that never reach their `onBlur`.
		act(() => result.current.updateAnnotationLive("ann_a", { content: "typed" }));
		await twoZoomDepthEdits(result);
		expect(past).toHaveLength(2);

		// The bare click on a slider thumb.
		await act(async () => {
			await result.current.commitAnnotationChange();
		});

		// Same project, so nothing is cleared -- the cost is that one Ctrl+Z jumps over
		// BOTH zoom edits and lands on the document the abandoned typing started from.
		expect(past).toHaveLength(2);
		act(() => {
			expect(undo()).toBe(true);
		});
		const doc = useProjectStore.getState().document;
		expect(doc?.zoomRanges[0].depth).toBe(4);
		expect(doc?.annotations[0].content).toBe("typed");
	});

	it("does not restore a buried document when a bare annotation commit fails", async () => {
		// The worse half: `rollback` is used as a DOCUMENT here, not only as a
		// `historyBase`, so a failed bare commit wrote the stale snapshot back into the
		// store and both zoom edits were silently gone.
		const { result } = renderTimeline();

		act(() => result.current.updateAnnotationLive("ann_a", { content: "typed" }));
		await twoZoomDepthEdits(result);

		const onScreen = useProjectStore.getState().document;
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });
		await act(async () => {
			await result.current.commitAnnotationChange();
		});

		expect(useProjectStore.getState().document).toBe(onScreen);
		expect(onScreen?.zoomRanges[0].depth).toBe(5);
		expect(onScreen?.annotations[0].content).toBe("typed");
	});

	it("does not hand a bare focus commit a base the edits since have buried", async () => {
		// `ZoomFocusOverlay.handlePointerDown` sets `draggingRef` BEFORE its live write,
		// and that write returns early on a zero-size overlay rect -- so `endDrag` fires
		// `commitZoomFocus()` with nothing in front of it.
		const { result } = renderTimeline();

		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));
		await twoZoomDepthEdits(result);
		expect(past).toHaveLength(2);

		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(past).toHaveLength(2);
		act(() => {
			expect(undo()).toBe(true);
		});
		const doc = useProjectStore.getState().document;
		expect(doc?.zoomRanges[0].depth).toBe(4);
		expect(doc?.zoomRanges[0].focus).toEqual({ cx: 0.8, cy: 0.2 });
	});

	it("does not restore a buried document when a bare focus commit fails", async () => {
		const { result } = renderTimeline();

		act(() => result.current.updateZoomFocusLive("zoom_a", { cx: 0.8, cy: 0.2 }));
		await twoZoomDepthEdits(result);

		const onScreen = useProjectStore.getState().document;
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });
		await act(async () => {
			await result.current.commitZoomFocus();
		});

		expect(useProjectStore.getState().document).toBe(onScreen);
		expect(onScreen?.zoomRanges[0].depth).toBe(5);
	});

	it("still records the pre-drag document when an annotation drag reaches its commit", async () => {
		// The guard must not cost the feature it guards: a drag that ends the way a drag
		// normally ends is still ONE undo step, back to before it.
		const { result } = renderTimeline();

		act(() => result.current.updateAnnotationLive("ann_a", { content: "ty" }));
		act(() => result.current.updateAnnotationLive("ann_a", { content: "typed" }));
		await act(async () => {
			await result.current.commitAnnotationChange();
		});

		expect(past).toHaveLength(1);
		act(() => {
			expect(undo()).toBe(true);
		});
		expect(useProjectStore.getState().document?.annotations[0].content).toBe("before");
	});
});
