import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { EditorEmptyState } from "./EditorEmptyState";

const bridgeMocks = vi.hoisted(() => ({
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	loadProjectFile: vi.fn(),
	loadProjectFileFromPath: vi.fn(),
	getPathForFile: vi.fn(),
	openVideoFilePicker: vi.fn(),
}));

const sampleDoc = vi.hoisted(() => ({
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
		speedRegions: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	legacyEditor: null,
	agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
	preview: { strategy: "seek", revision: 0 },
	export: { preset: "final-balanced", lastJobId: null },
	history: { revisions: [] },
}));

function setupElectronApi() {
	Object.assign(window, {
		electronAPI: {
			openVideoFilePicker: bridgeMocks.openVideoFilePicker,
			loadProjectFile: bridgeMocks.loadProjectFile,
			loadProjectFileFromPath: bridgeMocks.loadProjectFileFromPath,
			getPathForFile: bridgeMocks.getPathForFile,
		},
	});
}

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			create: bridgeMocks.create,
			save: bridgeMocks.save,
			addAsset: bridgeMocks.addAsset,
		},
	},
}));

vi.mock("@/lib/ai-edition/document/migrate", () => ({
	migrateProjectDataToAxcutDocument: (project: unknown) => ({
		...sampleDoc,
		project: {
			...sampleDoc.project,
			id: (project as { id?: string })?.id ?? "migrated",
		},
	}),
}));

describe("EditorEmptyState (new editor)", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		setupElectronApi();
		for (const mock of Object.values(bridgeMocks)) {
			mock.mockReset();
		}
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows the import button when a project is loaded but has no asset", () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 0,
			dirty: false,
			lastSavedAt: new Date(),
		});

		render(<EditorEmptyState hasProject={true} />);

		expect(screen.getByText(/add a video to get started/i)).toBeInTheDocument();
		// ponytail: no "Open project" button when a project is already loaded —
		// the import button does the job.
		expect(screen.queryByText(/open project/i)).not.toBeInTheDocument();
	});

	it("shows both import + open-project buttons when no project is loaded", () => {
		render(<EditorEmptyState hasProject={false} />);

		expect(screen.getByText(/no project open/i)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /new project \+ import video/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /open project/i })).toBeInTheDocument();
	});

	it("imports a video: file picker → addAsset on the existing project", async () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: sampleDoc,
			revision: 1,
			status: "ready",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 0,
			dirty: false,
			lastSavedAt: new Date(),
		});
		bridgeMocks.openVideoFilePicker.mockResolvedValue({
			success: true,
			path: "/tmp/recording.mp4",
		});
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: {
				...sampleDoc,
				assets: [
					{
						id: "asset_1",
						kind: "video",
						label: "recording.mp4",
						originalPath: "/tmp/recording.mp4",
					},
				],
				project: { ...sampleDoc.project, primaryAssetId: "asset_1" },
			},
		});

		render(<EditorEmptyState hasProject={true} />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /import video/i }));
		});

		await waitFor(() => {
			expect(bridgeMocks.openVideoFilePicker).toHaveBeenCalledTimes(1);
			// The store's addAsset signs projectId as the first arg.
			expect(bridgeMocks.addAsset).toHaveBeenCalledWith(
				"proj_test",
				"/tmp/recording.mp4",
				"recording.mp4",
			);
		});
	});

	it("creates a project when importing with no project loaded", async () => {
		bridgeMocks.create.mockResolvedValue({ success: true, document: sampleDoc });
		bridgeMocks.openVideoFilePicker.mockResolvedValue({
			success: true,
			path: "/tmp/recording.mp4",
		});
		bridgeMocks.addAsset.mockResolvedValue({
			assetId: "asset_1",
			document: sampleDoc,
		});

		render(<EditorEmptyState hasProject={false} />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /new project \+ import video/i }));
		});

		await waitFor(() => {
			expect(bridgeMocks.create).toHaveBeenCalledTimes(1);
			expect(bridgeMocks.addAsset).toHaveBeenCalledWith(
				"proj_test",
				"/tmp/recording.mp4",
				"recording.mp4",
			);
		});
	});

	it("opens a .openscreen project file via the load button", async () => {
		bridgeMocks.loadProjectFile.mockResolvedValue({
			success: true,
			project: { id: "loaded", title: "Loaded" },
		});
		bridgeMocks.save.mockResolvedValue({ success: true, document: sampleDoc });

		render(<EditorEmptyState hasProject={false} />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /open project/i }));
		});

		await waitFor(() => {
			expect(bridgeMocks.loadProjectFile).toHaveBeenCalledTimes(1);
			expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		});
	});

	it("shows the unsupported-format dialog when a non-.openscreen file is dropped", async () => {
		render(<EditorEmptyState hasProject={false} />);

		const file = new File([new Uint8Array([0, 1, 2])], "recording.mp4", { type: "video/mp4" });
		const dropZone = screen.getByText(/no project open/i).parentElement?.parentElement
			?.parentElement as HTMLElement;
		expect(dropZone).toBeTruthy();

		// ponytail: jsdom doesn't ship `DataTransfer`, so the file list is a
		// plain array on a stand-in. React's `files` getter on dataTransfer
		// is what the component reads.
		fireEvent.drop(dropZone, {
			dataTransfer: { files: [file] },
		});

		await waitFor(() => {
			expect(screen.getByText(/unsupported format/i)).toBeInTheDocument();
		});
	});
});
