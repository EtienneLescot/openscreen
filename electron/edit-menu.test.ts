// Regression cover for the macOS half of #433.
//
// The Edit menu used to carry `role: "undo"` / `role: "redo"` with
// `registerAccelerator: false`. That field is documented `@platform linux,win32`,
// so on darwin it does nothing at all: AppKit still matches the menu's Cmd+Z key
// equivalent inside `-[NSApplication sendEvent:]`, before the key event reaches
// the web contents, and the editor's own keydown handler never runs.
//
// These tests pin the shape that actually reaches the renderer on every platform:
// an explicit accelerator and a click that dispatches to the editor.

import { describe, expect, it, vi } from "vitest";
import { buildEditMenuSubmenu, type EditorUndoRedoChannel } from "./edit-menu";

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
