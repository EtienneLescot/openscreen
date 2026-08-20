// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotesWindow } from "./NotesWindow";
import { NOTES_TELEPROMPTER_STORAGE_KEY } from "./notesTeleprompter";

const tiptapState = vi.hoisted(() => ({
	options: null as null | {
		content: string;
		editable: boolean;
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
			"tooltips.notesToolbar.bold": "Bold",
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

const setEditable = vi.fn();

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
		setEditable,
		view: { dom: scrollElement },
	} as unknown as Editor;
}

/** Mimics an engine that stores scroll offsets as whole pixels. */
function makeScrollTopRounding(element: HTMLElement): void {
	let value = 0;
	Object.defineProperty(element, "scrollTop", {
		configurable: true,
		get: () => value,
		set: (next: number) => {
			value = Math.floor(next);
		},
	});
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
		setEditable.mockClear();

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
		scrollElement.scrollTop = 96;
		render(<NotesWindow />);

		await user.click(screen.getByRole("button", { name: "Play" }));
		flushNextFrame(0);
		flushNextFrame(100);

		expect(scrollElement.scrollTop).toBe(100);
		expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
		expect(frameCallbacks.size).toBe(0);
	});

	it("replays from the top when playback starts at the bottom", async () => {
		const user = userEvent.setup();
		scrollElement.scrollTop = 100;
		render(<NotesWindow />);

		await user.click(screen.getByRole("button", { name: "Play" }));
		expect(scrollElement.scrollTop).toBe(0);

		flushNextFrame(0);
		flushNextFrame(100);

		expect(scrollElement.scrollTop).toBe(4);
		expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
	});

	it("stays armed when the note is shorter than the window", async () => {
		const user = userEvent.setup();
		Object.defineProperties(scrollElement, {
			scrollHeight: { value: 100, configurable: true },
			clientHeight: { value: 100, configurable: true },
		});
		render(<NotesWindow />);

		await user.click(screen.getByRole("button", { name: "Play" }));
		flushNextFrame(0);
		flushNextFrame(100);

		// Nothing to scroll, but the control must not snap back and look broken.
		expect(scrollElement.scrollTop).toBe(0);
		expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
		expect(frameCallbacks.size).toBe(1);
	});

	it("keeps advancing when the engine rounds scrollTop to whole pixels", async () => {
		const user = userEvent.setup();
		makeScrollTopRounding(scrollElement);
		render(<NotesWindow />);

		await user.click(screen.getByRole("button", { name: "Play" }));

		// 40 px/s over 16 ms frames is 0.64 px each — every one of them rounds away on its
		// own, so reading the position back from the DOM would stall the teleprompter.
		let timestamp = 0;
		for (let frame = 0; frame <= 5; frame++) {
			flushNextFrame(timestamp);
			timestamp += 16;
		}

		expect(scrollElement.scrollTop).toBe(3);
	});

	it("makes the note read-only while playing", async () => {
		const user = userEvent.setup();
		render(<NotesWindow />);
		expect(setEditable).toHaveBeenLastCalledWith(true, false);

		await user.click(screen.getByRole("button", { name: "Play" }));
		expect(setEditable).toHaveBeenLastCalledWith(false, false);
		expect(screen.getByRole("button", { name: "Bold" })).toBeDisabled();

		await user.click(screen.getByRole("button", { name: "Pause" }));
		expect(setEditable).toHaveBeenLastCalledWith(true, false);
		expect(screen.getByRole("button", { name: "Bold" })).toBeEnabled();
	});

	it("locks the note in every mirrored or playing state and unlocks only when both end", async () => {
		const user = userEvent.setup();
		render(<NotesWindow />);
		const bold = () => screen.getByRole("button", { name: "Bold" });

		// Not playing, not mirrored: editable.
		expect(setEditable).toHaveBeenLastCalledWith(true, false);
		expect(bold()).toBeEnabled();

		// Not playing, mirrored: locked.
		await user.click(screen.getByRole("button", { name: "Mirror" }));
		expect(setEditable).toHaveBeenLastCalledWith(false, false);
		expect(bold()).toBeDisabled();

		// Playing, mirrored: locked.
		await user.click(screen.getByRole("button", { name: "Play" }));
		expect(setEditable).toHaveBeenLastCalledWith(false, false);
		expect(bold()).toBeDisabled();

		// Paused again but still mirrored: stays locked.
		await user.click(screen.getByRole("button", { name: "Pause" }));
		expect(setEditable).toHaveBeenLastCalledWith(false, false);
		expect(bold()).toBeDisabled();

		// The teleprompter controls stay usable while the note is locked.
		const content = screen.getByTestId("notes-teleprompter-content");
		await user.click(screen.getByRole("button", { name: "Increase font size" }));
		expect(content).toHaveStyle({ fontSize: "18px" });

		// Unmirrored while paused: editable again.
		await user.click(screen.getByRole("button", { name: "Mirror" }));
		expect(setEditable).toHaveBeenLastCalledWith(true, false);
		expect(bold()).toBeEnabled();

		// None of the state flips wrote note content.
		expect(localStorage.getItem("notes")).toBeNull();
	});

	it("locks the note from the first render when a mirrored setting is restored", () => {
		localStorage.setItem(
			NOTES_TELEPROMPTER_STORAGE_KEY,
			JSON.stringify({ speed: 40, fontSize: 16, mirrored: true }),
		);
		render(<NotesWindow />);

		// `useEditor` is stubbed here, so this pins the option we hand Tiptap rather than what
		// Tiptap does with it: the editor must be CREATED read-only, because an effect-only lock
		// would leave the first painted frame editable. That the real editor honours it — and
		// keeps honouring the effect afterwards — is covered in NotesWindow.editable.test.tsx.
		expect(tiptapState.options?.editable).toBe(false);
		expect(setEditable).toHaveBeenLastCalledWith(false, false);
		expect(setEditable).not.toHaveBeenCalledWith(true, false);
		expect(screen.getByRole("button", { name: "Bold" })).toBeDisabled();
		// A restored mirror must not auto-start playback.
		expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
	});

	it("creates the editor editable when nothing locks it at mount", () => {
		render(<NotesWindow />);
		expect(tiptapState.options?.editable).toBe(true);
	});

	it("keeps mirroring and playback independent", async () => {
		const user = userEvent.setup();
		render(<NotesWindow />);
		const content = screen.getByTestId("notes-teleprompter-content");

		// Mirroring must not start playback.
		await user.click(screen.getByRole("button", { name: "Mirror" }));
		expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
		expect(content).toHaveAttribute("data-mirrored", "true");

		// Pausing must not unmirror.
		await user.click(screen.getByRole("button", { name: "Play" }));
		await user.click(screen.getByRole("button", { name: "Pause" }));
		expect(content).toHaveAttribute("data-mirrored", "true");
	});

	it("applies and persists font and mirror settings without persisting playback", async () => {
		const user = userEvent.setup();
		render(<NotesWindow />);
		const content = screen.getByTestId("notes-teleprompter-content");

		expect(content).toHaveStyle({ fontSize: "16px" });
		expect(content).toHaveAttribute("data-mirrored", "false");
		// Loading defaults is not a preference — nothing is stored until a control is used.
		expect(localStorage.getItem(NOTES_TELEPROMPTER_STORAGE_KEY)).toBeNull();

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

	it("still writes nothing on mount when StrictMode double-invokes effects", () => {
		// The renderer really does mount under StrictMode (see src/main.tsx), so a
		// "skip the first run" guard would persist defaults on the second invocation.
		render(
			<StrictMode>
				<NotesWindow />
			</StrictMode>,
		);

		expect(localStorage.getItem(NOTES_TELEPROMPTER_STORAGE_KEY)).toBeNull();
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

describe("NotesWindow stylesheet", () => {
	// The note body only scrolls because `.tiptap` carries `height: 100%` + `overflow-y: auto`.
	// Those rules reach the app through a side-effect import, and a side-effect import of a
	// *CSS module* is tree-shaken out of the production bundle — dev looked fine while the
	// packaged app let a long note grow past its slot, scroll the whole shell out of view and
	// take the toolbar with it. A plain `.css` import is always emitted.
	const read = (file: string) =>
		readFileSync(resolve(process.cwd(), "src/components/launch", file), "utf8");

	it("is imported as plain CSS, never as a CSS module", () => {
		const source = read("NotesWindow.tsx");

		expect(source).toContain('import "./NotesWindow.css"');
		expect(source).not.toContain(".module.css");
	});

	it("keeps the note body a scroll container", () => {
		const css = read("NotesWindow.css");
		const body = css.match(/\.tiptap\s*\{[^}]*\}/)?.[0] ?? "";

		expect(body).toMatch(/height:\s*100%/);
		expect(body).toMatch(/overflow-y:\s*auto/);
	});
});
