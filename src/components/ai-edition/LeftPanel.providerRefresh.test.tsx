// @vitest-environment jsdom
// Issue #420: the provider dialog's open state moved out of `ChatStripPanel` and into
// EditorDialogsContext, and the `onClose` that used to re-read the LLM snapshot went with it.
// Connecting a provider in that dialog is what enables the composer here and what fills the
// model pill, so the panel now refreshes whenever the dialog is NOT open — on mount, and again
// on every close.
//
// That re-read is the one behaviour the lift had to re-establish by hand rather than move, and
// it cannot be seen from the dialog's own tests (they never mount this panel), so it is pinned
// here: refreshed once on mount, not again when the dialog opens, once more when it closes.

import "@testing-library/jest-dom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const llmGetSnapshot = vi.fn(() =>
	Promise.resolve({
		config: null,
		connectedProviders: [],
		availableProviders: [],
		credentialSummary: [],
	}),
);

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			llmGetSnapshot: () => llmGetSnapshot(),
			chatListSessions: () => Promise.resolve([]),
			chatBudget: () => Promise.resolve(null),
			llmListProviderModels: () => Promise.resolve({ models: [] }),
		},
	},
}));

// The panel's copy is not what is under test, and an echoing translator keeps this file off
// the critical path of a copy edit.
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
import { ChatStripPanel } from "./LeftPanel";

let dialogActions: ReturnType<typeof useEditorDialogActions> | null = null;

/** Hands the test the context's openers, which the app menu and the panel's own gear share. */
function CaptureDialogActions() {
	dialogActions = useEditorDialogActions();
	return null;
}

beforeEach(() => {
	llmGetSnapshot.mockClear();
	dialogActions = null;
	// The panel subscribes to streamed chat events on mount; there is no preload in jsdom.
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => {
			/* unsubscribe */
		},
	};
	// jsdom implements no scrolling at all, and the transcript pins itself to the bottom on
	// every render.
	Element.prototype.scrollTo = () => {
		/* no scrolling in jsdom */
	};
});

afterEach(() => {
	cleanup();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ChatStripPanel, against the lifted provider dialog", () => {
	it("re-reads the LLM snapshot when the dialog closes, and not when it opens", async () => {
		render(
			<EditorDialogsProvider>
				<CaptureDialogActions />
				<ChatStripPanel />
			</EditorDialogsProvider>,
		);
		// Mount: the dialog is closed, so the same effect that watches for a close seeds the
		// composer's view of the provider config.
		await act(async () => {
			await Promise.resolve();
		});
		expect(llmGetSnapshot).toHaveBeenCalledTimes(1);

		// Opening it must not refresh — nothing has been connected yet, and the old code's
		// `onClose` did not fire here either.
		await act(async () => {
			dialogActions?.openDialog("providers");
		});
		expect(llmGetSnapshot).toHaveBeenCalledTimes(1);

		// Closing is the event that used to be `onClose` -> `refreshLlm()`.
		await act(async () => {
			dialogActions?.closeDialog();
		});
		expect(llmGetSnapshot).toHaveBeenCalledTimes(2);
	});
});
