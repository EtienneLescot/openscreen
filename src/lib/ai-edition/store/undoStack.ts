// The undo/redo snapshot stacks, in their own module so `projectStore` can push
// to them with a STATIC import.
//
// `setDocument` used to `void import("./undo").then(({ pushHistory }) => ...)`,
// which put the push in a LATER microtask. `undo()` restored its snapshot inside
// a synchronous `enabled = false` / `enabled = true` bracket, so by the time the
// deferred push ran the guard was armed again: an undo's own write was recorded
// as a fresh edit, `pushHistory` wiped `future`, and redo could never fire. The
// import bought nothing either — `NewEditorShell` already pulls `undo.ts` into
// the same chunk statically.
//
// This module deliberately imports nothing from the store, so `projectStore ->
// undoStack` is a leaf edge and there is no cycle to reason about. `undo.ts`
// re-exports `clearHistory` from here for existing callers; `pushHistory` is NOT
// re-exported -- import it from this module directly. Keeping it off `undo.ts`
// keeps the audit in `documentWriteAudit.test.ts` honest: `recordHistory` in
// `projectStore` is its only production caller, and a second import path would
// be a second way to record history without saying so at the call site.

export type Snapshot = { projectId: string; doc: unknown };

const MAX_HISTORY = 50;

export const past: Snapshot[] = [];
export const future: Snapshot[] = [];

/** Record a document as the state to return to. Drops the redo stack: history
 *  branched the moment a new edit landed on top of an undone one. */
export function pushHistory(snapshot: Snapshot) {
	past.push(snapshot);
	if (past.length > MAX_HISTORY) past.shift();
	future.length = 0;
}

export function clearHistory() {
	past.length = 0;
	future.length = 0;
	supersedeInFlightWrites();
}

// The write epoch. `saveDocument` reads it before its `await` and again after,
// and throws its result away if it moved.
//
// Without it, a save that was ALREADY IN FLIGHT when the user pressed Ctrl+Z
// landed on top of the undo: `saveDocument` records below the await, so it put
// the pre-save document on `past` (which is FORWARD of where the user asked to
// go) and cleared `future` on the way past, then installed its own document in
// the store. The undo was visually reverted and redo was gone -- for a write the
// user had superseded a moment earlier.
//
// Everything that replaces the document out from under an in-flight write bumps
// it: `undo`, `redo` (both via `restore`), and `clearHistory`, which is a project
// switch -- a save of the OLD project resolving after `loadProject` would
// otherwise overwrite the new one.
let writeEpoch = 0;

/** The epoch a write should still belong to when it lands. */
export function currentWriteEpoch(): number {
	return writeEpoch;
}

/**
 * Declare that the document on screen is no longer the one any in-flight write
 * was building on, so those writes must not install their result.
 */
export function supersedeInFlightWrites() {
	writeEpoch += 1;
}
