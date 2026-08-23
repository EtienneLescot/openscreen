// Regression cover for the macOS half of #433.
//
// The Edit menu used to carry `role: "undo"` / `role: "redo"` with
// `registerAccelerator: false`. That field is documented `@platform linux,win32`,
// so on darwin it does nothing at all: AppKit still matches the menu's Cmd+Z key
// equivalent inside `-[NSApplication sendEvent:]`, before the key event reaches
// the web contents, and the editor's own keydown handler never runs.
//
// These tests pin the shape that actually reaches the renderer on every platform:
// an explicit accelerator and a click that dispatches to the editor -- and, in the
// second describe, where that dispatch actually lands. Dropping the roles took
// `webContents.undo()` away from every window, so the non-editor fallback is not a
// detail: it is the half of the design that keeps the launch and notes windows
// working.

import { describe, expect, it, vi } from "vitest";
import {
	buildEditMenuSubmenu,
	type EditorUndoRedoChannel,
	routeEditorUndoRedo,
	type UndoRedoWindow,
} from "./edit-menu";

function build() {
	const dispatch = vi.fn<(channel: EditorUndoRedoChannel) => void>();
	const items = buildEditMenuSubmenu({
		label: (_key, fallback) => fallback,
		dispatch,
	});
	return { items, dispatch };
}

describe("buildEditMenuSubmenu", () => {
	it("owns Cmd+Z itself instead of leaning on registerAccelerator", () => {
		const { items } = build();
		const undoItem = items.find((i) => i.label === "Undo");

		expect(undoItem?.accelerator).toBe("CmdOrCtrl+Z");
		// The two things that made the previous version a no-op on macOS.
		expect(undoItem?.role).toBeUndefined();
		expect(undoItem?.registerAccelerator).toBeUndefined();
	});

	it("owns Shift+Cmd+Z for redo on the same terms", () => {
		const { items } = build();
		const redoItem = items.find((i) => i.label === "Redo");

		expect(redoItem?.accelerator).toBe("Shift+CmdOrCtrl+Z");
		expect(redoItem?.role).toBeUndefined();
		expect(redoItem?.registerAccelerator).toBeUndefined();
	});

	it("routes both to the editor renderer, which owns the document's undo stack", () => {
		// `webContents.undo()` -- what the roles ran -- is the WEB EDITING undo. It does
		// nothing outside a focused text field, so on macOS Cmd+Z was swallowed by a menu
		// item that could not have serviced it anyway.
		const { items, dispatch } = build();

		items
			.find((i) => i.label === "Undo")
			?.click?.(
				// The click signature carries a menu item, a window and the event; none of
				// them are read here.
				undefined as never,
				undefined as never,
				undefined as never,
			);
		expect(dispatch).toHaveBeenCalledWith("menu-undo");

		items
			.find((i) => i.label === "Redo")
			?.click?.(undefined as never, undefined as never, undefined as never);
		expect(dispatch).toHaveBeenCalledWith("menu-redo");
	});

	it("leaves the clipboard items as roles", () => {
		// They act on the focused text selection, which is exactly what the roles do --
		// and nothing in the editor shadows them.
		const { items } = build();
		expect(items.map((i) => i.role).filter(Boolean)).toEqual(["cut", "copy", "paste", "selectAll"]);
	});
});

function editorWindow() {
	const webContents = {
		send: vi.fn<(channel: EditorUndoRedoChannel) => void>(),
		undo: vi.fn(),
		redo: vi.fn(),
	};
	const isDestroyed = vi.fn(() => false);
	return {
		window: { isDestroyed, webContents } satisfies UndoRedoWindow,
		webContents,
		isDestroyed,
	};
}

describe("routeEditorUndoRedo", () => {
	it("hands the editor window the request over IPC", () => {
		// The editor renderer owns the document's undo stack, and applies the text-field
		// rule its own keydown path applies. `webContents.undo()` could not do either.
		const target = editorWindow();

		routeEditorUndoRedo("menu-undo", target.window, () => true);
		routeEditorUndoRedo("menu-redo", target.window, () => true);

		expect(target.webContents.send.mock.calls).toEqual([["menu-undo"], ["menu-redo"]]);
		expect(target.webContents.undo).not.toHaveBeenCalled();
		expect(target.webContents.redo).not.toHaveBeenCalled();
	});

	it("falls back to the web-editing undo when the focused window is not the editor", () => {
		// The case the whole design rests on. Dropping `role: "undo"` took the menu's
		// built-in `webContents.undo()` away from EVERY window, so the launch window and
		// the notes window -- where the role was the right answer -- get it back here.
		const target = editorWindow();

		routeEditorUndoRedo("menu-undo", target.window, () => false);
		expect(target.webContents.undo).toHaveBeenCalledOnce();
		expect(target.webContents.redo).not.toHaveBeenCalled();

		routeEditorUndoRedo("menu-redo", target.window, () => false);
		expect(target.webContents.redo).toHaveBeenCalledOnce();

		expect(target.webContents.send).not.toHaveBeenCalled();
	});

	it("does nothing when there is no window, or it has been destroyed", () => {
		// Unlike `sendEditorMenuAction` this never creates one: Cmd+Z is not a request to
		// open the editor. And the destroyed check runs before anything reads the window,
		// which is why `isEditor` is a callback -- `webContents.getURL()` on a destroyed
		// window throws.
		const isEditor = vi.fn(() => true);
		expect(() => routeEditorUndoRedo("menu-undo", null, isEditor)).not.toThrow();

		const target = editorWindow();
		target.isDestroyed.mockReturnValue(true);
		routeEditorUndoRedo("menu-undo", target.window, isEditor);

		expect(target.webContents.send).not.toHaveBeenCalled();
		expect(target.webContents.undo).not.toHaveBeenCalled();
		expect(isEditor).not.toHaveBeenCalled();
	});
});
