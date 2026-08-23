// The application menu's Edit submenu, split out of `main.ts` so it can be tested
// (same shape as `about.ts`).
//
// Undo/Redo are deliberately NOT `role: "undo"` / `role: "redo"`.
//
// Those roles run `webContents.undo()`, the WEB EDITING undo, which does nothing
// at all outside a focused text field. On macOS their Cmd+Z key equivalent is
// matched by AppKit inside `-[NSApplication sendEvent:]`, BEFORE the key event
// reaches the web contents, so the editor's own document-level handler
// (`useUndoRedoShortcuts`) never sees the keydown and Ctrl+Z silently did
// nothing (#433).
//
// `registerAccelerator: false` does not fix that. Electron annotates the field
// `@platform linux,win32` (see `MenuItemConstructorOptions` in electron.d.ts),
// so on darwin it is ignored outright and the menu keeps the key equivalent.
// And on Windows and Linux the roles were never the problem: menu accelerators
// there are dispatched from the unhandled-keyboard-event path, i.e. AFTER the
// renderer, which the renderer's own `preventDefault()` already suppresses.
//
// So the items own the accelerator on every platform and forward to the editor
// renderer, which applies exactly the rule its keydown path applies: a focused
// text field gets the browser's text undo, anything else gets the document undo.
// `dispatch` is what falls back to `webContents.undo()` when the focused window
// is not the editor at all.

import type { MenuItemConstructorOptions } from "electron";

/** IPC channels the Edit menu forwards to the editor renderer. */
export type EditorUndoRedoChannel = "menu-undo" | "menu-redo";

export interface EditMenuOptions {
	/** Localised label for `key`, falling back to `fallback` when untranslated. */
	label: (key: string, fallback: string) => string;
	/** Route an undo/redo request to whichever window should service it. */
	dispatch: (channel: EditorUndoRedoChannel) => void;
}

/** The slice of `WebContents` the routing below touches. */
export interface UndoRedoWebContents {
	send: (channel: EditorUndoRedoChannel) => void;
	undo: () => void;
	redo: () => void;
}

/** The slice of `BrowserWindow` the routing below touches. */
export interface UndoRedoWindow {
	isDestroyed: () => boolean;
	webContents: UndoRedoWebContents;
}

/**
 * Deliver an undo/redo request to the window that should service it.
 *
 * Lives here rather than in `main.ts` for the reason `about.ts` does: `main.ts`
 * calls `app.requestSingleInstanceLock()` at import time and cannot be loaded by a
 * test, so anything left in it is untested by construction.
 *
 * Three cases, and the middle one is the whole reason the menu items dropped their
 * `role`. There is no window, or it is gone: nothing to do — unlike
 * `sendEditorMenuAction` this never CREATES an editor window, because Cmd+Z is not
 * a request to open the editor. The window is not the editor — the launch window,
 * the notes window — so the web-editing undo the `undo` role used to provide is the
 * right one after all, and it is reached directly. Otherwise it is the editor, and
 * the editor's renderer owns the document's undo stack.
 *
 * `isEditor` is a callback, not a flag, so nothing reads the window's URL before
 * the destroyed check has run.
 */
export function routeEditorUndoRedo(
	channel: EditorUndoRedoChannel,
	window: UndoRedoWindow | null | undefined,
	isEditor: () => boolean,
): void {
	if (!window || window.isDestroyed()) return;
	if (!isEditor()) {
		if (channel === "menu-undo") window.webContents.undo();
		else window.webContents.redo();
		return;
	}
	window.webContents.send(channel);
}

export function buildEditMenuSubmenu({
	label,
	dispatch,
}: EditMenuOptions): MenuItemConstructorOptions[] {
	return [
		{
			label: label("actions.undo", "Undo"),
			accelerator: "CmdOrCtrl+Z",
			click: () => dispatch("menu-undo"),
		},
		{
			label: label("actions.redo", "Redo"),
			accelerator: "Shift+CmdOrCtrl+Z",
			click: () => dispatch("menu-redo"),
		},
		{ type: "separator" },
		// The clipboard roles keep theirs: they act on the focused text selection,
		// which is precisely what `webContents.cut/copy/paste` do, and the editor has
		// no document-level meaning for them to shadow.
		{ role: "cut", label: label("actions.cut", "Cut") },
		{ role: "copy", label: label("actions.copy", "Copy") },
		{ role: "paste", label: label("actions.paste", "Paste") },
		{ role: "selectAll", label: label("actions.selectAll", "Select All") },
	];
}
