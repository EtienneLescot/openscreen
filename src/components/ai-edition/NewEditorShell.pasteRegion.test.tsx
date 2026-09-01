// @vitest-environment jsdom
// pasteRegion is a closure in the shell, so the only honest way to test it is through the
// window keydown that reaches it — same harness as NewEditorShell.dialogShortcuts.test.tsx,
// plus a seeded document (paste sits behind the `hasProject` gate). The preview is stubbed
// because the compositor canvas is the one child jsdom cannot host; nothing under test
// lives in it.
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openConfig = vi.fn();

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig,
			closeConfig: () => {
				/* not exercised here */
			},
			setShortcuts: () => {
				/* not exercised here */
			},
			persistShortcuts: () => Promise.resolve(true),
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({
		locale: "en",
		setLocale: () => {
			/* fixed locale */
		},
	}),
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("./Preview", () => ({
	Preview: () => null,
}));

import { toast } from "sonner";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { clearRegionClipboard, copyRegion } from "@/lib/ai-edition/store/regionClipboard";
import { NewEditorShell } from "./NewEditorShell";

/** One footage asset, one 0–30s clip — enough timeline for a pasted region to anchor to. */
function seedDocument(): AxcutDocument {
	const base = createEmptyDocument({ title: "Test", projectId: "proj_paste" });
	return {
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "rec.mp4",
				originalPath: "C:/videos/rec.mp4",
				durationSec: 60,
				cameraTrack: null,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
				},
			],
		},
	};
}

function renderShell() {
	return render(
		<EditorDialogsProvider>
			<NewEditorShell />
		</EditorDialogsProvider>,
	);
}

/** Shortcuts are bound on `window` and read `e.target`; nothing is focused, so body. */
function pressPaste() {
	fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
}

beforeEach(() => {
	openConfig.mockClear();
	vi.mocked(toast.success).mockClear();
	// No preload in jsdom, and no scrolling either; the chat transcript pins itself to the
	// bottom on every render.
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => {
			/* unsubscribe */
		},
		setTitleBarOverlay: () => {
			/* no native titlebar */
		},
		setHasUnsavedChanges: () => {
			/* no window close guard */
		},
		onRequestCloseConfirm: () => () => {
			/* unsubscribe */
		},
		onRequestSaveBeforeClose: () => () => {
			/* unsubscribe */
		},
		sendCloseConfirmResponse: () => {
			/* nothing is closing this window */
		},
		findRecordingCamera: () => Promise.resolve(null),
		preparePreviewAudioTrack: () => Promise.resolve(null),
		// The timeline asks for waveform bytes as it mounts; there is no file behind the
		// seeded asset, and the failed decode is noise, not a failure of anything here.
		readBinaryFile: () => Promise.resolve(null),
	};
	Element.prototype.scrollTo = () => {
		/* no scrolling in jsdom */
	};
	// jsdom ships neither; the stage and the timeline both measure themselves.
	(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe() {
			/* never fires: nothing has a layout in jsdom */
		}
		unobserve() {
			/* see observe */
		}
		disconnect() {
			/* see observe */
		}
	};
	useProjectStore.getState().clear();
	useProjectStore.setState({ document: seedDocument(), currentTimeSec: 0 });
	// A zoom on the clipboard: the cheapest pasteable payload, and one whose landing is
	// directly observable in the document.
	copyRegion({ kind: "zoom", region: { startMs: 0, endMs: 1000, depth: 2 } });
});

afterEach(() => {
	cleanup();
	clearRegionClipboard();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("pasteRegion", () => {
	it("does not claim a paste the store refused to write", async () => {
		// saveDocument resolves false (rather than rejecting) when the write fails, and the
		// failure is already reported by the store — the toast must stay silent rather than
		// announce a paste that did not land.
		const saveDocument = vi.fn(async () => false);
		useProjectStore.setState({ saveDocument });
		renderShell();

		await act(async () => {
			pressPaste();
		});

		expect(saveDocument).toHaveBeenCalledTimes(1);
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("pastes onto the document current when the queued write runs, not a pre-await snapshot", async () => {
		// The paste awaits dynamic imports before saving; two quick Ctrl+V both used to read
		// the same snapshot and the second save clobbered the first — one pasted region for
		// two presses. The read lives inside the enqueue chain now, so the second write
		// builds on the first's result.
		const saveDocument = vi.fn(async (next: AxcutDocument) => {
			useProjectStore.setState({ document: next });
			return true;
		});
		useProjectStore.setState({ saveDocument });
		renderShell();

		await act(async () => {
			pressPaste();
			pressPaste();
		});

		const ranges = (useProjectStore.getState().document as AxcutDocument).zoomRanges;
		expect(saveDocument).toHaveBeenCalledTimes(2);
		expect(ranges).toHaveLength(2);
		expect(ranges[0].id).not.toBe(ranges[1].id);
		expect(toast.success).toHaveBeenCalledTimes(2);
	});
});
