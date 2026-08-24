// @vitest-environment jsdom
// Issue #420: the AI provider dialog used to be a `useState` inside LeftPanel's chat strip, so
// it existed only in Edit mode with the chat panel expanded and nothing else could open it. It
// is mounted once now, above the mode switch, and driven by EditorDialogsContext.
//
// These tests are about *reach*, not about the dialog's own screens: that the app menu's row
// really opens it, that it opens in Media and Rec too, and that the row and the heading are one
// string rather than two that can drift apart.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorDialogsProvider, useEditorDialogActions } from "@/contexts/EditorDialogsContext";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { type EditorMode, EditorTopBar } from "./v4/EditorTopBar";

// The dialog reads a provider snapshot over the native bridge the moment it opens. Answer with
// an empty one: which providers exist is the registry's business, and this file's is the door.
vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			llmGetSnapshot: () =>
				Promise.resolve({
					config: null,
					connectedProviders: [],
					availableProviders: [],
					credentialSummary: [],
				}),
			llmListProviderModels: () => Promise.resolve({ models: [] }),
		},
	},
}));

import { ProviderSettingsDialog } from "./ProviderSettings";

const noop = () => {};

/** The top bar as NewEditorShell builds it: the menu row's action is the context's opener, and
 *  nothing else in `actions` matters here. */
function TopBar({ mode }: { mode: EditorMode }) {
	const { openDialog } = useEditorDialogActions();
	return (
		<EditorTopBar
			mode={mode}
			onModeChange={noop}
			projectTitle="Demo Project"
			dirty={false}
			canExport={false}
			chatOpen={false}
			actions={{
				openProject: noop,
				newProject: noop,
				save: noop,
				export: noop,
				openSettings: noop,
				renameProject: noop,
				toggleChat: noop,
				openProviderSettings: () => openDialog("providers"),
				showAbout: noop,
				checkForUpdates: noop,
			}}
		/>
	);
}

/** The App.tsx shape, minus the editor body: one provider, one dialog mount, and the top bar
 *  that has to reach it. Rendered with the real translations — the drift assertion below is
 *  only worth anything against real strings. */
function renderEditorChrome(locale: string, mode: EditorMode = "edit") {
	localStorage.setItem(LOCALE_STORAGE_KEY, locale);
	return render(
		<I18nProvider>
			<EditorDialogsProvider>
				<TopBar mode={mode} />
				<ProviderSettingsDialog />
			</EditorDialogsProvider>
		</I18nProvider>,
	);
}

/** Open the app menu (the wordmark) and click its AI settings row. */
function openAiSettingsFromAppMenu() {
	fireEvent.click(screen.getByRole("button", { name: /OpenScreen/ }));
	fireEvent.click(screen.getByRole("menuitem", { name: /ai settings/i }));
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("ProviderSettings, reached from the app menu", () => {
	it("is absent until the menu row is clicked, then mounted as a dialog", () => {
		renderEditorChrome("en");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		openAiSettingsFromAppMenu();

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: /ai settings/i })).toBeInTheDocument();
	});

	it.each<EditorMode>([
		"media",
		"rec",
	])("opens in %s mode, where the chat panel that used to own it does not exist", (mode) => {
		// The reason the state was lifted. LeftPanel renders only under `mode === "edit" &&
		// chatOpen`, so before this change the row would have been dead in both of these.
		renderEditorChrome("en", mode);

		openAiSettingsFromAppMenu();

		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("labels the menu row with the dialog's own heading, so the two cannot drift", () => {
		// Both read `editor.providerSettings.title`. A menu-only key would be free to say
		// something else after a copy edit, and the menu would start lying about where it goes.
		// Compared as text rather than asserted against a literal, so a copy edit moves both.
		renderEditorChrome("en");
		fireEvent.click(screen.getByRole("button", { name: /OpenScreen/ }));
		const rowLabel = screen.getByRole("menuitem", { name: /ai settings/i }).textContent;

		fireEvent.click(screen.getByRole("menuitem", { name: /ai settings/i }));

		expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(rowLabel ?? "");
	});

	it("closes again from the dialog's own close button", () => {
		renderEditorChrome("en");
		openAiSettingsFromAppMenu();

		fireEvent.click(screen.getByRole("button", { name: /close/i }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("translates the row with the dialog, not separately", () => {
		renderEditorChrome("fr");
		fireEvent.click(screen.getByRole("button", { name: /OpenScreen/ }));
		const row = screen.getByRole("menuitem", { name: /paramètres ia/i });

		fireEvent.click(row);

		expect(screen.getByRole("heading", { name: /paramètres ia/i })).toBeInTheDocument();
	});
});
