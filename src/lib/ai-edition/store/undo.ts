// Lightweight undo/redo for the project document. Every write that goes through
// `projectStore`'s `saveDocument` / `setDocument` records the outgoing document
// on the stack in `undoStack.ts` (callers opt out with `{ history: false }` for
// background writes). Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y walk that stack.
//
// The restore writes `useProjectStore.setState` DIRECTLY rather than calling
// back into `setDocument`, which is what makes redo work: routing it through a
// recording write meant an undo re-recorded the document it had just replaced
// and cleared `future` on the way past, so redo was gone before the user could
// reach for it and Ctrl+Z degraded into an A/B toggle. Writing the state is also
// all a repaint needs — the timeline, preview and shell all subscribe to
// `s.document`.

import { useCallback, useEffect, useRef } from "react";
import { isModalOpen } from "../modalGuard";
import type { AxcutDocument } from "../schema";
import { useProjectStore } from "./projectStore";
import {
	clearHistory,
	popFuture,
	popPast,
	pushFuture,
	pushPast,
	supersedeInFlightWrites,
} from "./undoStack";

export { clearHistory } from "./undoStack";

/** Put a snapshot back on screen without recording it as a new edit. `dirty` is
 *  set because the document on disk is no longer the one in memory — the caller
 *  of `useUndoRedoShortcuts` persists it. */
function restore(doc: unknown) {
	// Before the state write, so a save that resolves between here and the caller's
	// persist cannot slip its result in. See `undoStack.ts`: a save already in flight
	// when Ctrl+Z was pressed used to install its document over the restored one and
	// push a FORWARD state onto `past`, wiping the redo the undo had just created.
	supersedeInFlightWrites();
	useProjectStore.setState((state) => ({
		document: doc as AxcutDocument,
		revision: state.revision + 1,
		dirty: true,
	}));
}

export function undo(): boolean {
	const prev = popPast();
	if (!prev) return false;
	const state = useProjectStore.getState();
	if (!state.projectId || state.projectId !== prev.projectId) {
		clearHistory();
		return false;
	}
	const doc = state.document;
	if (doc) pushFuture({ projectId: prev.projectId, doc: structuredClone(doc) });
	restore(prev.doc);
	return true;
}

export function redo(): boolean {
	const next = popFuture();
	if (!next) return false;
	const state = useProjectStore.getState();
	if (!state.projectId || state.projectId !== next.projectId) {
		clearHistory();
		return false;
	}
	const doc = state.document;
	if (doc) pushPast({ projectId: doc.project.id, doc: structuredClone(doc) });
	restore(next.doc);
	return true;
}

/**
 * Whether the document undo must keep its hands off: inside a text field the
 * browser's own text undo is the one the user means. The keydown path checks the
 * event target, the menu path checks `activeElement` — same rule, two entry
 * points, so it lives in one function.
 */
function isTextEditingTarget(node: EventTarget | null): boolean {
	if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return true;
	return node instanceof HTMLElement && node.isContentEditable;
}

export interface UndoRedoHandlers {
	/**
	 * Undo, applying the same text-field rule the keyboard path applies.
	 *
	 * Wired to the native Edit menu, which on macOS is the ONLY route Cmd+Z has:
	 * AppKit matches the menu's key equivalent before the key event reaches the web
	 * contents, so the keydown listener below never runs there. See
	 * `electron/edit-menu.ts`.
	 */
	runUndo: () => void;
	runRedo: () => void;
}

export function useUndoRedoShortcuts(onAfter: () => void): UndoRedoHandlers {
	const onAfterRef = useRef(onAfter);
	onAfterRef.current = onAfter;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isTextEditingTarget(e.target)) return;
			// `NewEditorShell` hands Ctrl+Z / Ctrl+Y to this listener instead of handling them,
			// so its modal guard never runs for them: without this one, undo kept rewriting the
			// document under every open modal, including the ones the shell does suppress.
			if (isModalOpen()) return;
			const ctrl = e.ctrlKey || e.metaKey;
			if (ctrl && e.shiftKey && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (redo()) onAfterRef.current();
				return;
			}
			if (ctrl && e.key.toLowerCase() === "y") {
				e.preventDefault();
				if (redo()) onAfterRef.current();
				return;
			}
			// `toLowerCase()`, like the two branches above: with Caps Lock on the browser
			// reports "Z", and the bare `=== "z"` here fell through to nothing at all.
			if (ctrl && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (undo()) onAfterRef.current();
				return;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// `execCommand` is the only handle the renderer has on the browser's text undo,
	// and it is what the `undo` menu ROLE reached through `webContents.undo()`. It is
	// deprecated and absent under jsdom, hence the optional call: losing text undo in
	// a field is survivable, a TypeError from a menu click is not.
	const runUndo = useCallback(() => {
		if (isTextEditingTarget(window.document.activeElement)) {
			window.document.execCommand?.("undo");
			return;
		}
		// AFTER the text-field check, so a rename dialog's input still gets the browser's
		// own text undo. Before it, this route rewrote the DOCUMENT under an open modal:
		// a modal's controls are buttons, so `isTextEditingTarget` waves them through, and
		// on macOS the menu is the only path Cmd+Z has -- there is no keydown handler
		// upstream of this one to stop it. See `../modalGuard`, and #434, which fixes the
		// same hole on the keydown path.
		if (isModalOpen()) return;
		if (undo()) onAfterRef.current();
	}, []);

	const runRedo = useCallback(() => {
		if (isTextEditingTarget(window.document.activeElement)) {
			window.document.execCommand?.("redo");
			return;
		}
		if (isModalOpen()) return;
		if (redo()) onAfterRef.current();
	}, []);

	return { runUndo, runRedo };
}
