import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "./projectStore";

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
	schemaVersion: 3,
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
});
