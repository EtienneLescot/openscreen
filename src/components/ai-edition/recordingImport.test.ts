// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { importPendingRecording } from "./recordingImport";

// The store's own bridge calls are never reached — every action the import uses
// is stubbed below — but importing the store pulls the client in, so stub it.
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));

const createProject = vi.fn(async () => undefined);
const addAsset = vi.fn(async () => null);
const replaceTimeline = vi.fn(async () => undefined);

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
		);
	});
});
