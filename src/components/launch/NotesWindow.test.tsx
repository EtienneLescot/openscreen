import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotesWindow } from "./NotesWindow";
import { NOTES_TELEPROMPTER_STORAGE_KEY } from "./notesTeleprompter";

const tiptapState = vi.hoisted(() => ({
	options: null as null | {
		content: string;
		onUpdate: (payload: { editor: { getHTML: () => string } }) => void;
	},
	editor: null as Editor | null,
}));

vi.mock("@tiptap/react", () => ({
	useEditor: (options: typeof tiptapState.options) => {
		tiptapState.options = options;
		return tiptapState.editor;
	},
	EditorContent: ({
		editor: _editor,
		...props
	}: React.HTMLAttributes<HTMLDivElement> & { editor: Editor | null }) => <div {...props} />,
}));

vi.mock("@tiptap/starter-kit", () => ({ default: {} }));

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en" }),
	useScopedT: () => (key: string, vars?: Record<string, string | number>) => {
		const labels: Record<string, string> = {
			"tooltips.notesToolbar.play": "Play",
			"tooltips.notesToolbar.pause": "Pause",
			"tooltips.notesToolbar.speed": "Scroll speed",
			"tooltips.notesToolbar.decreaseSpeed": "Decrease scroll speed",
			"tooltips.notesToolbar.increaseSpeed": "Increase scroll speed",
			"tooltips.notesToolbar.fontSize": "Font size",
			"tooltips.notesToolbar.decreaseFontSize": "Decrease font size",
			"tooltips.notesToolbar.increaseFontSize": "Increase font size",
			"tooltips.notesToolbar.mirror": "Mirror",
			"units.pixelsPerSecond": "{{value}} px/s",
			"units.pixels": "{{value}} px",
		};
		return (labels[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
			String(vars?.[name] ?? `{{${name}}}`),
		);
	},
}));

function createStorage(): Storage {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, String(value)),
		removeItem: (key) => values.delete(key),
		clear: () => values.clear(),
		key: (index) => Array.from(values.keys())[index] ?? null,
		get length() {
			return values.size;
		},
	};
}

function createEditor(scrollElement: HTMLElement): Editor {
	const chain: Record<string, ReturnType<typeof vi.fn>> = {};
	for (const command of [
		"focus",
		"toggleBold",
		"toggleItalic",
		"toggleStrike",
		"toggleBulletList",
		"toggleOrderedList",
		"toggleBlockquote",
		"toggleCodeBlock",
	]) {
		chain[command] = vi.fn(() => chain);
	}
	chain.run = vi.fn(() => true);

	return {
		can: () => ({ chain: () => chain }),
		chain: () => chain,
		isActive: () => false,
		on: vi.fn(),
		off: vi.fn(),
		view: { dom: scrollElement },
	} as unknown as Editor;
}

describe("NotesWindow teleprompter mode", () => {
	let scrollElement: HTMLElement;
	let frameCallbacks: Map<number, FrameRequestCallback>;
	let nextFrameId: number;

	function flushNextFrame(timestamp: number): void {
		const entry = frameCallbacks.entries().next().value as
			| [number, FrameRequestCallback]
			| undefined;
		if (!entry) {
			throw new Error("No animation frame was scheduled");
		}
		frameCallbacks.delete(entry[0]);
		act(() => entry[1](timestamp));
	}

	beforeEach(() => {
		Object.defineProperty(globalThis, "localStorage", {
			value: createStorage(),
			configurable: true,
		});

		scrollElement = document.createElement("div");
		Object.defineProperties(scrollElement, {
			scrollHeight: { value: 200, configurable: true },
			clientHeight: { value: 100, configurable: true },
		});
		scrollElement.scrollTop = 0;
		tiptapState.editor = createEditor(scrollElement);
		tiptapState.options = null;

		frameCallbacks = new Map();
		nextFrameId = 1;
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				const id = nextFrameId++;
				frameCallbacks.set(id, callback);
				return id;
			}),
		);
		vi.stubGlobal(
			"cancelAnimationFrame",
			vi.fn((id: number) => {
				frameCallbacks.delete(id);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("starts paused, scrolls by elapsed time, resets timing on speed changes, and pauses", async () => {
		const user = userEvent.setup();
		render(<NotesWindow />);

		await user.click(screen.getByRole("button", { name: "Play" }));
		expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

		flushNextFrame(0);
		expect(scrollElement.scrollTop).toBe(0);
		flushNextFrame(100);
		expect(scrollElement.scrollTop).toBe(4);

		await user.click(screen.getByRole("button", { name: "Increase scroll speed" }));
		flushNextFrame(1_000);
		expect(scrollElement.scrollTop).toBe(4);
		flushNextFrame(1_100);
		expect(scrollElement.scrollTop).toBe(9);

		await user.click(screen.getByRole("button", { name: "Pause" }));
		expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
		expect(frameCallbacks.size).toBe(0);
	});

	it("stops automatically at the bottom", async () => {
		const user = userEvent.setup();
		scrollElement.scrollTop = 99;
		render(<NotesWindow />);

		await user.click(screen.getByRole("button", { name: "Play" }));
		flushNextFrame(0);
		flushNextFrame(100);

		expect(scrollElement.scrollTop).toBe(100);
		expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
		expect(frameCallbacks.size).toBe(0);
	});

	it("applies and persists font and mirror settings without persisting playback", async () => {
		const user = userEvent.setup();
		render(<NotesWindow />);
		const content = screen.getByTestId("notes-teleprompter-content");

		expect(content).toHaveStyle({ fontSize: "16px" });
		expect(content).toHaveAttribute("data-mirrored", "false");

		await user.click(screen.getByRole("button", { name: "Increase font size" }));
		await user.click(screen.getByRole("button", { name: "Mirror" }));
		await user.click(screen.getByRole("button", { name: "Play" }));

		expect(content).toHaveStyle({ fontSize: "18px" });
		expect(content).toHaveAttribute("data-mirrored", "true");
		await waitFor(() => {
			expect(JSON.parse(localStorage.getItem(NOTES_TELEPROMPTER_STORAGE_KEY) ?? "")).toEqual({
				speed: 40,
				fontSize: 18,
				mirrored: true,
			});
		});
	});

	it("loads legacy note content and saves editor updates", () => {
		localStorage.setItem("notes", "First\nSecond");
		render(<NotesWindow />);

		expect(tiptapState.options?.content).toBe("<p>First</p><p>Second</p>");
		act(() => {
			tiptapState.options?.onUpdate({
				editor: { getHTML: () => "<p>Updated</p>" },
			});
		});
		expect(localStorage.getItem("notes")).toBe("<p>Updated</p>");
	});
});
