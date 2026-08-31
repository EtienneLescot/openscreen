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
//
// The arrays themselves are module-private for the same reason. They used to be
// exported as `Snapshot[]`, and `const` binds the reference, not the contents --
// so `past.push(...)` from any importer was a second way to record history that
// the audit could not see at all: it keys on the callee NAME, and the name there
// is `push`. The exported `past` / `future` are `readonly` views, and every
// mutation is a named function the audit can count call sites of.

export type Snapshot = { projectId: string; doc: unknown };

const MAX_HISTORY = 50;

const pastStack: Snapshot[] = [];
const futureStack: Snapshot[] = [];

/** The undo stack, read-only. Mutate it through the functions below, which is
 *  what makes `documentWriteAudit.test.ts` able to enumerate the writers. */
export const past: readonly Snapshot[] = pastStack;
/** The redo stack, on the same terms as `past`. */
export const future: readonly Snapshot[] = futureStack;

/** Record a document as the state to return to. Drops the redo stack: history
 *  branched the moment a new edit landed on top of an undone one. */
export function pushHistory(snapshot: Snapshot) {
	pastStack.push(snapshot);
	if (pastStack.length > MAX_HISTORY) pastStack.shift();
	futureStack.length = 0;
}

/**
 * Put the document a REDO is replacing back on `past`, so the redo is itself
 * undoable.
 *
 * Not `pushHistory`: that one clears `future`, which is right for a new edit
 * (history branched) and wrong here, where the remaining redo steps are still
 * ahead of the user and the entry being pushed is one they just walked past.
 */
export function pushPast(snapshot: Snapshot) {
	pastStack.push(snapshot);
}

/** Put the document an UNDO is leaving on `future`, so redo can get back to it. */
export function pushFuture(snapshot: Snapshot) {
	futureStack.push(snapshot);
}

export function popPast(): Snapshot | undefined {
	return pastStack.pop();
}

export function popFuture(): Snapshot | undefined {
	return futureStack.pop();
}

export function clearHistory() {
	pastStack.length = 0;
	futureStack.length = 0;
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
