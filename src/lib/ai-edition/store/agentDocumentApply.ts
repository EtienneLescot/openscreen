import type { AxcutDocument } from "../schema";
import { ensureDocument } from "../schema";
import { useProjectStore } from "./projectStore";

export type AgentDocumentApplyResult = "applied" | "conflict" | "save-failed" | "no-live-document";

/**
 * Apply a full document returned by the agent only if the live editor is still
 * on the revision used to start that agent turn.
 *
 * `expectedRevision` is omitted for explicit rewind operations, and for the user
 * answering the conflict toast with "apply anyway" -- in both cases replacing the
 * current document is the action they just asked for.
 */
export async function applyAgentDocumentIfCurrent(
	document: unknown,
	expectedRevision?: number,
): Promise<AgentDocumentApplyResult> {
	const store = useProjectStore.getState();
	if (expectedRevision !== undefined && store.revision !== expectedRevision) {
		return "conflict";
	}

	const parsed = ensureDocument(document);
	const previous = store.document;
	const previousDirty = store.dirty;
	// Both calls, not just the save. `setDocument` puts the agent's document on screen
	// NOW, without waiting on the disk round-trip `saveDocument` awaits.
	//
	// Only the SAVE records history, and `historyBase` is what makes that possible: by
	// the time it runs, the store already holds the agent's document, so its own idea
	// of "previous" is useless. Recording on the `setDocument` instead put the entry on
	// the stack before the write was known to have landed — and the rollback below, a
	// `setState` by design, could not take it back off. A rejected agent edit left a
	// phantom Ctrl+Z step and a cleared `future` for something that never happened.
	store.setDocument(parsed, { history: false });
	if (await store.saveDocument(parsed, { history: true, historyBase: previous })) {
		return "applied";
	}

	// The edits are on screen by now. Leaving them there while the caller says they
	// were not applied tells the user two opposite things at once, and worse: `dirty`
	// is set, so the next unrelated save would quietly persist the document we just
	// said was rejected.
	//
	// Restored through `setState` rather than `setDocument`, so the restore itself is
	// not recorded — and there is nothing on the stack to take back off either, because
	// the write above records only on success. `revision` keeps the bump: it did move, and
	// leaving it forward makes any in-flight guard read "conflict", which is the safe
	// direction to be wrong in.
	//
	// A returned `false` and not a `catch`: `saveDocument` reports its own failures and
	// never rejects. This was a `try`/`catch` when it was written, against a
	// `saveDocument` that threw -- the two landed within minutes of each other, and a
	// dead `catch` type-checks, so the rollback stopped firing and this returned
	// "applied" for a write that never happened.
	//
	// Guarded on the store still holding the agent's document, the same way the drag
	// commits in `useTimeline` guard theirs. `false` also means "an undo overtook this
	// write" now, and there the store holds the document the user asked to return to --
	// restoring `previous` over it would revert their Ctrl+Z on the agent's behalf.
	if (previous && useProjectStore.getState().document === parsed) {
		useProjectStore.setState({ document: previous, dirty: previousDirty });
	}
	return "save-failed";
}

export interface AgentTurn<T> {
	result: T;
	/**
	 * Apply this turn's document, if it produced one, against the revision the agent
	 * was actually given. `ignoreConflict` is the user answering the conflict toast.
	 */
	applyDocument: (options?: { ignoreConflict?: boolean }) => Promise<AgentDocumentApplyResult>;
}

/**
 * Run one agent turn against the live document and hand back a way to apply its result.
 *
 * This exists to make the ordering structural. The guard is only worth anything if the
 * revision is the one the agent was handed, read from the SAME store snapshot as the
 * document and BEFORE the turn is awaited -- and none of that is visible at the call
 * site, where the read and the `await` are twenty lines apart in a 2,000-line component.
 * Moving the read below the await leaves every assertion about the guard passing while
 * the bug is fully restored. In here it is three adjacent lines, and a test can hold a
 * turn open, edit the store underneath it, and watch the apply refuse.
 */
export async function runAgentTurn<T extends { document?: unknown }>(
	run: (documentSnapshot: AxcutDocument | undefined) => Promise<T>,
): Promise<AgentTurn<T>> {
	const { document, revision } = useProjectStore.getState();
	const snapshot = document ?? undefined;
	const result = await run(snapshot);
	return {
		result,
		applyDocument: async ({ ignoreConflict = false } = {}) => {
			// No document open means the agent ran text-only, against an empty stand-in that
			// still carries the real project id. If it edited that and the revision happened
			// to match, applying would write a near-empty document over a real project.
			if (!snapshot) return "no-live-document";
			return applyAgentDocumentIfCurrent(result.document, ignoreConflict ? undefined : revision);
		},
	};
}
