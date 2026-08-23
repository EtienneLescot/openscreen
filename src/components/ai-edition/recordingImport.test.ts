// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceTimeline as replaceTimelineOp } from "@/lib/ai-edition/document/timeline";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { undo } from "@/lib/ai-edition/store/undo";
import { clearHistory, past } from "@/lib/ai-edition/store/undoStack";
import { importPendingRecording } from "./recordingImport";

// The first describe stubs the store actions, so the bridge is never reached
// there. The second one runs the REAL store against these, which is the only way
// to see what the import leaves on the undo stack.
const bridge = vi.hoisted(() => ({
	create: vi.fn(),
	addAsset: vi.fn(),
	save: vi.fn(),
}));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: bridge } }));

const createProject = vi.fn(async () => undefined);
const addAsset = vi.fn(async () => null);
const replaceTimeline = vi.fn(async () => undefined);

// Read before anything stubs them: the first describe replaces these actions on the
// live store, and `clear()` resets the DATA, not the actions.
const realActions = {
	createProject: useProjectStore.getState().createProject,
	addAsset: useProjectStore.getState().addAsset,
	replaceTimeline: useProjectStore.getState().replaceTimeline,
};

/** Stands in for the main-process recording slot: one value, set and read. */
function stubElectronApi(screenVideoPath: string | null) {
	let session = screenVideoPath ? { screenVideoPath, createdAt: 0 } : null;
	const api = {
		getCurrentRecordingSession: vi.fn(async () =>
			session ? { success: true, session } : { success: false },
		),
		setCurrentRecordingSession: vi.fn(async (next: typeof session) => {
			session = next;
			return { success: true };
		}),
	};
	// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the contextBridge surface
	(window as any).electronAPI = api;
	return api;
}

describe("importPendingRecording", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useProjectStore.setState({
			document: null,
			// biome-ignore lint/suspicious/noExplicitAny: partial action stubs, the rest of the store is untouched
			createProject: createProject as any,
			// biome-ignore lint/suspicious/noExplicitAny: partial action stubs, the rest of the store is untouched
			addAsset: addAsset as any,
			replaceTimeline,
		});
	});

	it("does nothing when no recording is waiting", async () => {
		stubElectronApi(null);
		await expect(importPendingRecording()).resolves.toBe(false);
		expect(createProject).not.toHaveBeenCalled();
	});

	it("imports the recording into a new project and consumes the hand-off", async () => {
		const api = stubElectronApi("C:\\recordings\\recording-1.mp4");

		await expect(importPendingRecording()).resolves.toBe(true);

		expect(createProject).toHaveBeenCalledTimes(1);
		expect(addAsset).toHaveBeenCalledWith("C:\\recordings\\recording-1.mp4", "recording-1.mp4");
		expect(api.setCurrentRecordingSession).toHaveBeenCalledWith(null);
	});

	// The regression: the editor window is destroyed and recreated on every open,
	// so a session left in the slot was imported again — a second project on the
	// same recording, at default settings, with the user's saved ones stranded in
	// the first one.
	it("imports one recording once, however often the editor mounts", async () => {
		stubElectronApi("C:\\recordings\\recording-1.mp4");

		await importPendingRecording();
		await expect(importPendingRecording()).resolves.toBe(false);

		expect(createProject).toHaveBeenCalledTimes(1);
		expect(addAsset).toHaveBeenCalledTimes(1);
	});

	it("seeds a placeholder clip when the imported asset has none", async () => {
		stubElectronApi("/recordings/recording-1.webm");
		addAsset.mockImplementationOnce(async () => {
			useProjectStore.setState({
				// biome-ignore lint/suspicious/noExplicitAny: only the two fields the seed reads
				document: { assets: [{ id: "a1" }], timeline: { clips: [] } } as any,
			});
			return null;
		});

		await importPendingRecording();

		expect(replaceTimeline).toHaveBeenCalledWith(
			[{ startSec: 0, endSec: 60 }],
			"Auto-imported recording",
			{ history: false },
		);
	});
});

// The whole hand-off, against the real store: stop the recording, land in the
// editor, press Ctrl+Z.
//
// The user has made no edit at this point -- the editor built this project for
// them, unattended, on mount. The seed below used to record itself as an undo
// step because `projectStore.replaceTimeline` hardcoded `{ history: true }` inside
// itself, where the option was invisible to its caller. So a brand-new project
// opened with `past.length === 1`, the first Ctrl+Z restored the state before the
// seed -- an empty timeline -- and `NewEditorShell`'s post-undo persist wrote that
// empty timeline to disk.
describe("what the recording import leaves on the undo stack", () => {
	const PROJECT_ID = "project_imported";
	const SCREEN_PATH = "/recordings/recording-1.webm";

	/** The document the main process actually returns from `addAsset`: an asset with
	 *  no `durationSec` (it stats the file, it does not probe it). */
	function withAsset(): AxcutDocument {
		const doc = createEmptyDocument({ projectId: PROJECT_ID, title: "Recording" });
		return {
			...doc,
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "recording-1.webm",
					originalPath: SCREEN_PATH,
					cameraTrack: null,
				},
			],
			project: { ...doc.project, primaryAssetId: "asset_1" },
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		useProjectStore.getState().clear();
		useProjectStore.setState(realActions);
		clearHistory();
		bridge.create.mockImplementation(async () => ({
			success: true,
			document: createEmptyDocument({ projectId: PROJECT_ID, title: "Recording" }),
		}));
		bridge.addAsset.mockImplementation(async () => ({ success: true, document: withAsset() }));
		bridge.save.mockImplementation(async (document: unknown) => ({ success: true, document }));
		stubElectronApi(SCREEN_PATH);
	});

	it("leaves it empty: the user has not edited anything yet", async () => {
		await importPendingRecording();

		expect(past).toHaveLength(0);
		expect(undo()).toBe(false);
	});

	it("still has its clip after the first Ctrl+Z", async () => {
		await importPendingRecording();

		// The `<video>` reports its duration and `NewEditorShell.handleLoadedMetadata`
		// folds it in -- which is when the clip the user sees actually appears, since
		// `replaceTimeline` sizes clips from `asset.durationSec` and the import has none.
		// Automatic too, hence `history: false`.
		const loaded = useProjectStore.getState().document as AxcutDocument;
		const probed: AxcutDocument = {
			...loaded,
			assets: loaded.assets.map((a) => ({ ...a, durationSec: 42 })),
		};
		await useProjectStore
			.getState()
			.saveDocument(replaceTimelineOp(probed, [{ startSec: 0, endSec: 42 }], "Auto-created"), {
				history: false,
			});
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);

		undo();

		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
	});
});
