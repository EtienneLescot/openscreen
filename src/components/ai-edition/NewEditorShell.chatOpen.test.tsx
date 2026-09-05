// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { useChatPromptBus } from "@/lib/ai-edition/store/useChatPromptBus";

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig: vi.fn(),
			closeConfig: vi.fn(),
			setShortcuts: vi.fn(),
			persistShortcuts: () => Promise.resolve(true),
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({
		locale: "en",
		setLocale: () => {},
	}),
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));

vi.mock("./LeftPanel", () => ({
	ChatStripPanel: () => {
		const pending = useChatPromptBus((s) => s.pending);
		const consume = useChatPromptBus((s) => s.consume);
		return (
			<div data-testid="chat-strip-panel">
				{pending ? (
					<button type="button" data-testid="consume-prompt-btn" onClick={() => consume()}>
						send:{pending}
					</button>
				) : null}
			</div>
		);
	},
}));

import { NewEditorShell } from "./NewEditorShell";

function renderShell() {
	return render(
		<EditorDialogsProvider>
			<NewEditorShell />
		</EditorDialogsProvider>,
	);
}

describe("NewEditorShell chatOpen behavior with useChatPromptBus", () => {
	beforeEach(() => {
		useChatPromptBus.setState({ pending: null });
		(window as unknown as { electronAPI?: unknown }).electronAPI = {
			onAiEditionChatEvent: () => () => {},
			setTitleBarOverlay: () => {},
			setHasUnsavedChanges: () => {},
			onRequestCloseConfirm: () => () => {},
			onRequestSaveBeforeClose: () => () => {},
			sendCloseConfirmResponse: () => {},
			findRecordingCamera: () => Promise.resolve(null),
			preparePreviewAudioTrack: () => Promise.resolve(null),
		};
		Element.prototype.scrollTo = () => {};
		(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
			observe() {
				// noop
			}
			unobserve() {
				// noop
			}
			disconnect() {
				// noop
			}
		};
	});

	afterEach(() => {
		cleanup();
		useChatPromptBus.setState({ pending: null });
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
	});

	it("initially starts with chat closed, and opens when useChatPromptBus receives a prompt", () => {
		renderShell();

		// Initially closed
		expect(
			screen.queryByRole("complementary", { name: "editor.shell.aiEditor" }),
		).not.toBeInTheDocument();
		const toggleBtn = screen.getByRole("button", { name: "editor.topbar.toggleChatPanel" });
		expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

		// Submit a prompt via the bus
		act(() => {
			useChatPromptBus.getState().submit("smart cut prompt");
		});

		// Now open
		expect(
			screen.getByRole("complementary", { name: "editor.shell.aiEditor" }),
		).toBeInTheDocument();
		expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
	});

	it("supports the prompt flow: submit prompt -> opens -> consume -> close -> submit reopens", () => {
		renderShell();

		const toggleBtn = screen.getByRole("button", { name: "editor.topbar.toggleChatPanel" });

		// 1. Submit prompt opens the chat panel
		act(() => {
			useChatPromptBus.getState().submit("first prompt");
		});
		expect(
			screen.getByRole("complementary", { name: "editor.shell.aiEditor" }),
		).toBeInTheDocument();
		expect(useChatPromptBus.getState().pending).toBe("first prompt");

		// 2. Consume prompt via send
		const consumeBtn = screen.getByTestId("consume-prompt-btn");
		expect(consumeBtn).toHaveTextContent("send:first prompt");
		act(() => {
			fireEvent.click(consumeBtn);
		});
		expect(useChatPromptBus.getState().pending).toBeNull();

		// 3. User closes the chat panel manually
		act(() => {
			fireEvent.click(toggleBtn);
		});
		expect(
			screen.queryByRole("complementary", { name: "editor.shell.aiEditor" }),
		).not.toBeInTheDocument();
		expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

		// 4. A newly delivered prompt re-opens the chat panel
		act(() => {
			useChatPromptBus.getState().submit("second prompt");
		});
		expect(
			screen.getByRole("complementary", { name: "editor.shell.aiEditor" }),
		).toBeInTheDocument();
		expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
	});
});
