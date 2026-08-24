// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceTimeline as replaceTimelineOp } from "@/lib/ai-edition/document/timeline";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { undo } from "@/lib/ai-edition/store/undo";
import { clearHistory, past } from "@/lib/ai-edition/store/undoStack";
import { probeVideoDimensions, probeVideoDuration } from "@/lib/ai-edition/timeline/duration";
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
vi.mock("@/lib/ai-edition/timeline/duration", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/ai-edition/timeline/duration")>();
	return { ...actual, probeVideoDimensions: vi.fn(), probeVideoDuration: vi.fn() };
});

const createProject = vi.fn(async () => undefined);
const addAsset = vi.fn(async () => null);
const saveDocument = vi.fn(
	async (_document: AxcutDocument, _options?: { history?: boolean }) => true,
);
const replaceTimeline = vi.fn(async () => undefined);

// Read before anything stubs them: the first describe replaces these actions on the
// live store, and `clear()` resets the DATA, not the actions.
const realActions = {
	createProject: useProjectStore.getState().createProject,
	addAsset: useProjectStore.getState().addAsset,
	saveDocument: useProjectStore.getState().saveDocument,
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
		vi.mocked(probeVideoDimensions).mockResolvedValue({ width: 2940, height: 1912 });
		vi.mocked(probeVideoDuration).mockResolvedValue(42);
		useProjectStore.setState({
			document: null,
			// biome-ignore lint/suspicious/noExplicitAny: partial action stubs, the rest of the store is untouched
			createProject: createProject as any,
			// biome-ignore lint/suspicious/noExplicitAny: partial action stubs, the rest of the store is untouched
			addAsset: addAsset as any,
			// biome-ignore lint/suspicious/noExplicitAny: partial action stubs, the rest of the store is untouched
			saveDocument: saveDocument as any,
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

	it("seeds the probed clip in the same automatic save", async () => {
		stubElectronApi("/recordings/recording-1.webm");
		addAsset.mockImplementationOnce(async () => {
			const document = createEmptyDocument({ projectId: "p1", title: "Recording" });
			useProjectStore.setState({
				document: {
					...document,
					assets: [
						{
							id: "a1",
							kind: "video",
							label: "Recording",
							originalPath: "/recordings/recording-1.webm",
							cameraTrack: null,
						},
					],
					project: { ...document.project, primaryAssetId: "a1" },
				},
			});
			return null;
		});

		await importPendingRecording();

		const savedDocument = saveDocument.mock.calls[0]?.[0] as AxcutDocument;
		expect(savedDocument.assets[0]?.durationSec).toBe(42);
		expect(savedDocument.timeline.clips).toHaveLength(1);
		expect(savedDocument.timeline.clips[0]?.timelineEndSec).toBe(42);
		expect(saveDocument).toHaveBeenCalledWith(savedDocument, { history: false });
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
		vi.mocked(probeVideoDimensions).mockResolvedValue({ width: 2940, height: 1912 });
		vi.mocked(probeVideoDuration).mockResolvedValue(42);
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

	it("starts a recording project in the source shape with the clean eight-percent padding", async () => {
		await importPendingRecording();

		const settings = getEditorSettings(useProjectStore.getState().document);
		expect(settings.aspectRatio).toBe("735:478");
		expect(settings.padding).toBe(8);
		expect(useProjectStore.getState().document?.timeline.clips).toHaveLength(1);
		expect(useProjectStore.getState().document?.assets[0]?.durationSec).toBe(42);
		expect(past).toHaveLength(0);
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
