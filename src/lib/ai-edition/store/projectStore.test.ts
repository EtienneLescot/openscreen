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
	});

	afterEach(() => {
		vi.clearAllMocks();
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
