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
// re-exports `pushHistory` / `clearHistory` from here for existing callers.

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
}
