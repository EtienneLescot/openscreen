// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "./projectStore";
import { clearHistory, past, pushHistory } from "./undoStack";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	error: vi.fn(),
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

vi.mock("sonner", () => ({
	toast: { error: toastMocks.error },
}));

const sampleDoc = {
	// ponytail: the bridge contract after the migration hoist is v6 — every
	// load site (DocumentService, browserShim) runs `migrateRawDocumentToCurrent`
	// before returning, and the renderer's `parseDocument` is a pure v6
	// validator. Test fixtures model the post-hoist contract.
	// `as const` and not a bare 7: the document type pins this field to the
	// LITERAL 7, and an unannotated object literal widens it to `number` — so
	// every `document: sampleDoc` below fails to type-check for a fixture that
	// is, in fact, exactly right.
	schemaVersion: 7 as const,
	project: {
		id: "proj_test",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
	},
	assets: [],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [],
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

describe("useProjectStore", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		for (const mock of Object.values(bridgeMocks)) {
			mock.mockReset();
		}
		toastMocks.error.mockReset();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI = { findRecordingCamera: vi.fn() };
	});

	afterEach(() => {
		vi.clearAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		delete (window as any).electronAPI;
	});

	it("createProject stores the returned document and bumps revision", async () => {
		bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });

		const doc = await useProjectStore.getState().createProject("Test");

		expect(doc.project.id).toBe("proj_test");
		const state = useProjectStore.getState();
		expect(state.projectId).toBe("proj_test");
		expect(state.document?.project.title).toBe("Test");
		expect(state.revision).toBe(1);
		expect(state.status).toBe("ready");
	});

	it("loadProject handles a failed bridge response by setting error status", async () => {
		bridgeMocks.get.mockResolvedValue({ success: false, error: "not found" });

		await useProjectStore.getState().loadProject("proj_x");

		const state = useProjectStore.getState();
		expect(state.status).toBe("error");
		expect(state.error).toBe("not found");
	});

	it("addAsset replaces the document and bumps revision", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		const updatedDoc = {
			...sampleDoc,
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "screen.webm",
					originalPath: "/tmp/screen.webm",
				},
			],
			project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
		};
		bridgeMocks.addAsset.mockResolvedValue({ assetId: "asset_1", document: updatedDoc });

		const asset = await useProjectStore.getState().addAsset("/tmp/screen.webm");

		expect(asset?.id).toBe("asset_1");
		expect(useProjectStore.getState().revision).toBe(2);
		expect(useProjectStore.getState().document?.assets).toHaveLength(1);
	});

	it("addAsset resolves an independent camera for every asset added, not just the first", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockImplementation(async (path: string) => {
			if (path === "/tmp/screen1.webm") {
				return { success: true, webcamVideoPath: "/tmp/screen1-webcam.webm", offsetMs: 0 };
			}
			if (path === "/tmp/screen2.webm") {
				return { success: true, webcamVideoPath: "/tmp/screen2-webcam.webm", offsetMs: 0 };
			}
			return { success: false, error: "No camera attached to this recording" };
		});

		bridgeMocks.addAsset.mockResolvedValueOnce({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{
						id: "asset_1",
						kind: "video",
						label: "screen1.webm",
						originalPath: "/tmp/screen1.webm",
					},
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});
		await useProjectStore.getState().addAsset("/tmp/screen1.webm");

		bridgeMocks.addAsset.mockResolvedValueOnce({
			assetId: "asset_2",
			document: {
				...useProjectStore.getState().document,
				assets: [
					...useProjectStore.getState().document!.assets,
					{
						id: "asset_2",
						kind: "video",
						label: "screen2.webm",
						originalPath: "/tmp/screen2.webm",
					},
				],
			},
		});
		await useProjectStore.getState().addAsset("/tmp/screen2.webm");

		const assets = useProjectStore.getState().document?.assets ?? [];
		expect(assets).toHaveLength(2);
		expect(assets.find((a) => a.id === "asset_1")?.cameraTrack?.sourcePath).toBe(
			"/tmp/screen1-webcam.webm",
		);
		expect(assets.find((a) => a.id === "asset_2")?.cameraTrack?.sourcePath).toBe(
			"/tmp/screen2-webcam.webm",
		);
	});

	it("addAsset links the camera when the recorder measured a sub-millisecond offset", async () => {
		// The native capture paths derive this from `performance.now()` (100 µs
		// resolution), so the offset is almost never a whole number — while
		// `cameraTrackSchema.offsetMs` is an int. Unrounded, the document failed
		// validation, the catch below treated it as a lookup failure, and a
		// recording that HAD a camera silently lost it.
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		bridgeMocks.save.mockImplementation(async (document) => ({ success: true, document }));
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockResolvedValue({
			success: true,
			webcamVideoPath: "/tmp/screen-webcam.webm",
			offsetMs: -192.80000000447035,
		});
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "screen.mp4", originalPath: "/tmp/screen.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/screen.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).not.toHaveBeenCalled();
		const camera = useProjectStore.getState().document?.assets[0]?.cameraTrack;
		expect(camera?.sourcePath).toBe("/tmp/screen-webcam.webm");
		expect(camera?.offsetMs).toBe(-193);
	});

	it("addAsset stays silent (no toast) when a plain imported video has no camera", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockResolvedValue({
			success: false,
			error: "No camera attached to this recording",
		});
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "video.mp4", originalPath: "/tmp/video.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/video.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).not.toHaveBeenCalled();
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.assets[0]?.cameraTrack).toBeNull();
	});

	it("addAsset toasts when the camera lookup itself throws", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
		(window as any).electronAPI.findRecordingCamera.mockRejectedValue(new Error("bridge exploded"));
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{ id: "asset_1", kind: "video", label: "video.mp4", originalPath: "/tmp/video.mp4" },
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		await useProjectStore.getState().addAsset("/tmp/video.mp4");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toastMocks.error).toHaveBeenCalledTimes(1);
		expect(toastMocks.error.mock.calls[0][0]).toContain("video.mp4");
	});

	// The save boundary. Every write in the app funnels through `saveDocument`, and
	// almost every caller `void`s it from a click handler, so what this function does
	// with a failure IS what the user sees.
	describe("saveDocument reports a failed write instead of rejecting", () => {
		it("resolves false, tells the user, and leaves the document alone", async () => {
			useProjectStore.setState({
				projectId: "proj_test",
				document: sampleDoc,
				revision: 3,
				status: "ready",
				dirty: true,
			});
			bridgeMocks.save.mockResolvedValue({ success: false, error: "EACCES" });

			const edited = { ...sampleDoc, project: { ...sampleDoc.project, title: "Edited" } };
			await expect(
				useProjectStore.getState().saveDocument(edited, { history: true }),
			).resolves.toBe(false);

			expect(toastMocks.error).toHaveBeenCalledWith("Failed to save project", {
				description: "EACCES",
			});
			const state = useProjectStore.getState();
			expect(state.document?.project.title).toBe("Test");
			expect(state.revision).toBe(3);
			// Still dirty: `dirty` is the only input to the beforeunload guard and to
			// `setHasUnsavedChanges`, so a failed write is the last moment to claim clean.
			expect(state.dirty).toBe(true);
		});

		it("never rejects, so a detached caller cannot leak an unhandled rejection", async () => {
			useProjectStore.setState({ projectId: "proj_test", document: sampleDoc, dirty: true });
			bridgeMocks.save.mockRejectedValue(new Error("bridge is gone"));

			await expect(
				useProjectStore.getState().saveDocument(sampleDoc, { history: true }),
			).resolves.toBe(false);
			expect(toastMocks.error).toHaveBeenCalledWith("Failed to save project", {
				description: "bridge is gone",
			});
		});

		it("resolves true and commits on success", async () => {
			const saved = { ...sampleDoc, project: { ...sampleDoc.project, title: "Saved" } };
			useProjectStore.setState({ projectId: "proj_test", document: sampleDoc, dirty: true });
			bridgeMocks.save.mockResolvedValue({ success: true, document: saved });

			await expect(useProjectStore.getState().saveDocument(saved, { history: true })).resolves.toBe(
				true,
			);

			expect(toastMocks.error).not.toHaveBeenCalled();
			const state = useProjectStore.getState();
			expect(state.document?.project.title).toBe("Saved");
			expect(state.dirty).toBe(false);
		});
	});

	it("removeAsset requires a loaded project", async () => {
		await expect(useProjectStore.getState().removeAsset("asset_x")).rejects.toThrow(
			"No project loaded",
		);
	});

	it("clear resets the store", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 5,
			status: "ready",
			error: null,
		});
		useProjectStore.getState().clear();
		expect(useProjectStore.getState()).toMatchObject({
			projectId: null,
			document: null,
			revision: 0,
			status: "idle",
			error: null,
		});
	});

	it("clear drops the undo history with the project", () => {
		// Explicit rather than leaning on the `beforeEach`, which reaches this same code.
		clearHistory();
		useProjectStore.setState({ projectId: "proj_test", document: sampleDoc });
		pushHistory({ projectId: "proj_test", doc: sampleDoc });
		expect(past).toHaveLength(1);

		useProjectStore.getState().clear();

		// Hygiene rather than a restore hazard -- `undo` refuses a snapshot whose
		// projectId does not match, and there is no projectId left to match. What the
		// stack was actually holding is up to fifty cloned documents, kept alive until
		// the next project load.
		expect(past).toHaveLength(0);
	});

	it("clear supersedes a save that was already in flight", async () => {
		// `clear()`'s one production caller deletes the open project. A background save
		// issued a moment earlier -- a transcript, a duration probe -- used to resolve
		// after it and reinstall the deleted project's document over the empty state,
		// with `dirty: false` and a fresh `lastSavedAt` claiming it was on disk.
		const renamed = { ...sampleDoc, project: { ...sampleDoc.project, title: "Renamed" } };
		clearHistory();
		useProjectStore.setState({ projectId: "proj_test", document: sampleDoc, dirty: true });
		let release: (() => void) | undefined;
		bridgeMocks.save.mockReturnValue(
			new Promise((resolve) => {
				release = () => resolve({ success: true, document: renamed });
			}),
		);

		const inFlight = useProjectStore.getState().saveDocument(renamed, { history: true });
		useProjectStore.getState().clear();
		release?.();

		await expect(inFlight).resolves.toBe(false);
		expect(useProjectStore.getState().document).toBeNull();
		expect(useProjectStore.getState().dirty).toBe(false);
		// And nothing recorded either: the write that would have pushed the pre-rename
		// document is the one being dropped.
		expect(past).toHaveLength(0);
	});
	describe("addAsset drops work the user has already moved on from", () => {
		// `addAsset` awaits the native add, a camera lookup, a dimension probe and a save,
		// and then writes the store unconditionally. Anything the user does in those gaps
		// -- deleting the open project, switching to another one -- used to lose to the
		// write that landed last.
		function pendingAdd() {
			let release!: (value: { document: typeof sampleDoc }) => void;
			bridgeMocks.addAsset.mockReturnValue(
				new Promise((resolve) => {
					release = resolve;
				}),
			);
			return { release };
		}

		beforeEach(() => {
			// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the legacy contextBridge surface
			(window as any).electronAPI = {
				findRecordingCamera: vi.fn().mockResolvedValue({ success: false }),
			};
		});

		it("does not reinstall a deleted project's document", async () => {
			bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });
			await useProjectStore.getState().createProject("Test");

			const { release } = pendingAdd();
			const pending = useProjectStore.getState().addAsset("C:/clip.mp4");

			// The user deletes the project while the add is still in flight.
			useProjectStore.getState().clear();
			release({ document: sampleDoc });

			await expect(pending).resolves.toBeNull();
			expect(useProjectStore.getState().document).toBeNull();
			expect(useProjectStore.getState().projectId).toBeNull();
		});

		it("does not drop one project's asset into the project the user switched to", async () => {
			bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });
			await useProjectStore.getState().createProject("Test");

			const { release } = pendingAdd();
			const pending = useProjectStore.getState().addAsset("C:/clip.mp4");

			const other = {
				...sampleDoc,
				project: { ...sampleDoc.project, id: "proj_other", title: "Other" },
			};
			bridgeMocks.get.mockResolvedValue({ success: true, document: other });
			await useProjectStore.getState().loadProject("proj_other");

			release({ document: sampleDoc });

			await expect(pending).resolves.toBeNull();
			// Still the project the user chose, not the one the add was building on.
			expect(useProjectStore.getState().projectId).toBe("proj_other");
			expect(useProjectStore.getState().document?.project.id).toBe("proj_other");
		});
	});
});
