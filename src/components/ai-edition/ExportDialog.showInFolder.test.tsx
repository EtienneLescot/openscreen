// @vitest-environment jsdom
// The export dialog's done panel keeps a "Show in folder" action around after a successful
// export. The success toast has always offered one, but a toast is gone in five seconds — the
// panel's button is the persistent affordance (issue #268).
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/native", () => ({
	exportMultiNative: vi.fn(async () => ({ videoDurationS: 12, wallS: 3 })),
	exportGifNative: vi.fn(async () => ({ videoDurationS: 12, wallS: 3 })),
	useIsCpuCompositor: () => false,
}));

vi.mock("@/native/sceneDescription", () => ({
	// `speedRegions` is what the export dialog reads to size the progress total
	// (`outputFrameCount`); an empty object here made it read `undefined`.
	buildSceneDescription: () => ({ speedRegions: [] }),
	resolveVisibleClips: (doc: AxcutDocument) => doc.timeline.clips,
}));

import { toast } from "sonner";
import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { ExportDialog } from "./ExportDialog";

type ElectronAPI = Window["electronAPI"];

const SAVED_PATH = "/tmp/openscreen/Test_project.mp4";

const noop = () => undefined;

const DOC: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_1",
		title: "Test project",
		createdAt: "2026-06-26T10:00:00Z",
		updatedAt: "2026-06-26T10:00:00Z",
		primaryAssetId: "a1",
	},
	assets: [
		{
			id: "a1",
			kind: "video",
			label: "asset",
			originalPath: "/tmp/a.mp4",
			cameraTrack: null,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "c1",
				assetId: "a1",
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

let revealInFolder: ReturnType<typeof vi.fn>;

/** Only what one successful MP4 export touches — anything else the dialog reaches for is
 *  absent, which is the point. */
function stubElectronAPI(reveal: () => Promise<unknown>) {
	revealInFolder = vi.fn(reveal);
	window.electronAPI = {
		pickExportSavePath: vi.fn(async () => ({ path: SAVED_PATH })),
		onNativeExportProgress: vi.fn(() => noop),
		revealInFolder,
	} as unknown as ElectronAPI;
}

/** Runs an export to completion and hands back the done panel's reveal button. */
async function exportAndFindRevealButton() {
	render(
		<I18nProvider>
			<ExportDialog open={true} onClose={noop} document={DOC} />
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: /export mp4/i }));
	return await screen.findByTestId("export-show-in-folder");
}

describe("ExportDialog done panel — show in folder", () => {
	beforeEach(() => {
		stubElectronAPI(async () => ({ success: true }));
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	it("reveals the exported file from the persistent done panel, not just the toast", async () => {
		const button = await exportAndFindRevealButton();

		// The reused `exportDialog.showInFolder` key, next to the path the export wrote.
		expect(button).toHaveTextContent(/show in folder/i);
		expect(screen.getByText(SAVED_PATH)).toBeInTheDocument();

		fireEvent.click(button);

		expect(revealInFolder).toHaveBeenCalledWith(SAVED_PATH);
	});

	it("logs a rejected reveal instead of raising a second error toast", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(noop);
		stubElectronAPI(async () => {
			throw new Error("no such file");
		});

		fireEvent.click(await exportAndFindRevealButton());

		await waitFor(() => expect(warn).toHaveBeenCalled());
		// The export itself succeeded; only opening the folder failed.
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("logs a `success: false` result — the main handler's fallback failed too", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(noop);
		stubElectronAPI(async () => ({ success: false, error: "ENOENT" }));

		fireEvent.click(await exportAndFindRevealButton());

		await waitFor(() =>
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("folder"), "ENOENT"),
		);
		expect(toast.error).not.toHaveBeenCalled();
	});
});
