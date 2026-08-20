// @vitest-environment jsdom
// The editor's shortcuts are bound on `window` and only skip inputs, textareas and
// contentEditable targets. A modal's own controls are buttons, and the app menu closes without
// restoring focus, so with a dialog open `e.target` is document.body and every shortcut used to
// run underneath the backdrop — Delete destroying the selected region, Ctrl+O stacking a second
// aria-modal dialog, `?` stacking the shortcuts dialog on top of the one already there.
//
// The guard reads `isDialogOpen()` (EditorDialogsContext, answered from a ref) and
// `isConfigOpen`. Both are asserted through the shell's real keydown handler here.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openConfig = vi.fn();

// The shortcuts dialog is one of the two things the guard has to suppress, and its opener is
// the cheapest observable in the whole handler: `?` is the only shortcut that survives the
// `hasProject` gate, so it works without loading a project.
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

import { EditorDialogsProvider, useEditorDialogActions } from "@/contexts/EditorDialogsContext";
import { NewEditorShell } from "./NewEditorShell";

let dialogActions: ReturnType<typeof useEditorDialogActions> | null = null;

function CaptureDialogActions() {
	dialogActions = useEditorDialogActions();
	return null;
}

function renderShell() {
	return render(
		<EditorDialogsProvider>
			<CaptureDialogActions />
			<NewEditorShell />
		</EditorDialogsProvider>,
	);
}

/** Shortcuts are bound on `window` and read `e.target`; with a modal open that is the body. */
function pressOnBody(init: KeyboardEventInit) {
	fireEvent.keyDown(document.body, init);
}

beforeEach(() => {
	openConfig.mockClear();
	dialogActions = null;
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
		// The only two other members the editor tree reaches without optional chaining. Both
		// are user-driven, not mount-driven; they are here so a stray call is a no-op rather
		// than a crash that reads as a failure of the thing under test.
		findRecordingCamera: () => Promise.resolve(null),
		preparePreviewAudioTrack: () => Promise.resolve(null),
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
});

afterEach(() => {
	cleanup();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("NewEditorShell shortcuts, with a dialog over the editor", () => {
	it("routes ? to the shortcuts dialog while nothing is open", () => {
		renderShell();

		pressOnBody({ key: "?" });

		expect(openConfig).toHaveBeenCalledTimes(1);
	});

	it("suppresses ? once a dialog owns the screen, and resumes when it closes", () => {
		renderShell();

		act(() => {
			dialogActions?.openDialog("providers");
		});
		pressOnBody({ key: "?" });
		expect(openConfig).not.toHaveBeenCalled();

		act(() => {
			dialogActions?.closeDialog();
		});
		pressOnBody({ key: "?" });
		expect(openConfig).toHaveBeenCalledTimes(1);
	});

	// Ctrl+O is handled before the `hasProject` gate, so it fired whatever the editor's state —
	// this is the one that put a SECOND aria-modal dialog on screen, both of them emitting the
	// hardcoded `id="modal-title"`. Its handler is async (it awaits the unsaved-changes prompt
	// before opening the picker), hence the async act: a synchronous assertion here would pass
	// whether the guard is there or not.
	it("opens the project picker on Ctrl+O while nothing is open", async () => {
		renderShell();

		await act(async () => {
			pressOnBody({ key: "o", ctrlKey: true });
		});

		// The provider dialog is mounted in App.tsx, not here, so the shell renders no dialog of
		// its own unless Ctrl+O got through.
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("suppresses Ctrl+O once a dialog owns the screen", async () => {
		renderShell();

		act(() => {
			dialogActions?.openDialog("providers");
		});
		await act(async () => {
			pressOnBody({ key: "o", ctrlKey: true });
		});

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
