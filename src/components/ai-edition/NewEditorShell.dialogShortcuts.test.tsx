// @vitest-environment jsdom
// The editor's shortcuts are bound on `window` and only skip inputs, textareas and
// contentEditable targets. A modal's own controls are buttons, and the app menu closes without
// restoring focus, so with a dialog open `e.target` is document.body and every shortcut used to
// run underneath the backdrop — Delete destroying the selected region, Ctrl+O stacking a second
// aria-modal dialog, `?` stacking the shortcuts dialog on top of the one already there.
//
// The guard asks `isModalOpen()` (lib/ai-edition/modalGuard) — one question about the screen,
// not one flag per dialog. The flag version named the two dialogs whose open state lived in a
// context and missed every modal the shell owns as plain `useState`, so Z/T/C kept adding
// regions under the Export modal (issue #434). The modal opened below is one of those: its
// state is a `useState` in the shell, exactly like Export's.

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

import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { NewEditorShell } from "./NewEditorShell";

function renderShell() {
	return render(
		<EditorDialogsProvider>
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

/**
 * Ctrl+O is handled before the `hasProject` gate, so it opens the project picker whatever the
 * editor's state — the cheapest way to put a real, shell-owned modal on screen. Its handler is
 * async (it awaits the unsaved-changes prompt before opening the picker), hence the async act:
 * a synchronous assertion would pass whether the guard is there or not.
 */
async function openShellModal() {
	await act(async () => {
		pressOnBody({ key: "o", ctrlKey: true });
	});
}

describe("NewEditorShell shortcuts, with a dialog over the editor", () => {
	it("routes ? to the shortcuts dialog while nothing is open", () => {
		renderShell();

		pressOnBody({ key: "?" });

		expect(openConfig).toHaveBeenCalledTimes(1);
	});

	it("opens the project picker on Ctrl+O while nothing is open", async () => {
		renderShell();

		await openShellModal();

		// The provider dialog is mounted in App.tsx, not here, so the shell renders no dialog of
		// its own unless Ctrl+O got through.
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	// The #434 shape: a modal the shell owns as local state, which no context knows about. `?`
	// is the observable because it is the one shortcut that survives the `hasProject` gate —
	// the keys the issue reports (Z, T, C) sit further down the same handler, behind the same
	// single `return`.
	it("suppresses ? while a modal the shell itself owns is open, and resumes when it closes", async () => {
		renderShell();

		await openShellModal();
		pressOnBody({ key: "?" });
		expect(openConfig).not.toHaveBeenCalled();

		// ModalShell listens for Escape on `document`, so this closes the picker for real
		// rather than reaching into the shell's state.
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		pressOnBody({ key: "?" });
		expect(openConfig).toHaveBeenCalledTimes(1);
	});

	// The other half of the same bug: a shortcut that opens a dialog stacked a SECOND one on
	// screen under the first, both of them emitting the hardcoded `id="modal-title"`.
	it("does not stack a second dialog when Ctrl+N fires under an open modal", async () => {
		renderShell();

		await openShellModal();
		await act(async () => {
			pressOnBody({ key: "n", ctrlKey: true });
		});

		expect(screen.getAllByRole("dialog")).toHaveLength(1);
	});
});
