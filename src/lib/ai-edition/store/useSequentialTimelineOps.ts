// ponytail: serialise timeline-edit saves so two rapid calls don't race
// each other's save and overwrite one another in the store. The previous
// in-component implementation in NewEditorShell.tsx had a subtle race
// where the doc was read SYNCHRONOUSLY at call time but the save was
// serialised; two concurrent calls would both read the same pre-edit
// doc and the second save would clobber the first edit. The fix is to
// read the doc INSIDE the chain, after awaiting the previous save, so
// every call sees the doc state the previous call committed.
//
// A failed save resolves to null rather than rejecting -- `projectStore.saveDocument`
// reports it to the user and returns false. Operation and dynamic-import errors still
// reject the promise handed to the caller; both call sites `void` it, so those remain
// unhandled rejections. They are also the two failures that mean the code is broken
// rather than the disk, so they belong in the console.
//
// The chain is exposed as `enqueue` as well as `apply`, because the race
// belongs to the DOCUMENT, not to AxcutTimelineOperation: every timeline
// edit is a read-modify-write of the whole document, so a mutation that
// serialises on its own second queue still clobbers one running on this
// one. `insertClipAt` is the case in point — it can't be expressed as an
// operation, since it carries a background duration probe, but it has to
// share the queue with the ops. Anything that reads the doc and saves it
// back belongs here.
//
// Errors are swallowed when advancing the queue ref so a failed save
// doesn't poison the queue (the next call still has a resolved promise
// to chain off). The original promise returned to the caller is NOT
// swallowed — the caller can await it and observe the rejection.

import { useCallback, useRef } from "react";
import type { AxcutTimelineOperation } from "@/lib/ai-edition/document/operations";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { type DocumentWriteOptions, useProjectStore } from "./projectStore";

export interface SequentialTimelineOps {
	/**
	 * Queue a timeline op. The op is applied to the latest committed
	 * document (read from the project store inside the queue, after the
	 * previous op's save has resolved), and the resulting document is
	 * saved. Calls are serialised — op N+1 reads the doc op N wrote.
	 *
	 * Returns the saved document, or `null` for either of two different things:
	 * no project document is loaded (store empty AND no fallback supplied), which
	 * is a silent no-op, or the write did not take effect -- see `saveDocument` for
	 * the two ways that happens, neither of which needs anything said here. Both call
	 * sites `void` the result, so they are not distinguished; a caller that needs to
	 * tell them apart has to widen this return type first.
	 *
	 * `opts` is forwarded verbatim to `saveDocument`, and is required for the same
	 * reason `history` itself is: a wrapper that picks the value on its caller's
	 * behalf hides the decision from the compiler. Both of today's callers are user
	 * gestures and pass `{ history: true }`; the next one might not be.
	 */
	apply: (op: AxcutTimelineOperation, opts: DocumentWriteOptions) => Promise<AxcutDocument | null>;

	/**
	 * Queue a document mutation that isn't an `AxcutTimelineOperation` on
	 * the same chain `apply` uses, so the two can't overwrite each other.
	 *
	 * `task` runs only once the previous queued call has settled. Read the
	 * document — and anything derived from it, an append index included —
	 * inside `task` rather than closing over it: a value captured at call
	 * time is the pre-mutation one, which is the whole race.
	 */
	enqueue: <T>(task: () => Promise<T> | T) => Promise<T>;
}

export function useSequentialTimelineOps(options: {
	/** Used only when the project store has no document yet. */
	fallbackDocument: AxcutDocument | null;
	/** Persist a document, resolving false if the write failed (already reported).
	 *  The hook awaits this before unblocking the queue.
	 *
	 *  Typed with the store's own options parameter rather than a one-argument
	 *  narrowing of it: every queued op here is a user edit, and the hook has to be
	 *  able to say so. */
	saveDocument: (doc: AxcutDocument, opts: DocumentWriteOptions) => Promise<boolean>;
}): SequentialTimelineOps {
	const { fallbackDocument, saveDocument } = options;
	const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

	const enqueue = useCallback(<T>(task: () => Promise<T> | T): Promise<T> => {
		const queued = saveQueueRef.current.then(() => task());
		// Swallow rejection when advancing the queue so a failed save
		// doesn't poison the queue — the next call still has a
		// resolved promise to chain off. The original `queued` is
		// returned to the caller, who can await it and observe the
		// rejection.
		saveQueueRef.current = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}, []);

	const apply = useCallback(
		(op: AxcutTimelineOperation, opts: DocumentWriteOptions): Promise<AxcutDocument | null> =>
			enqueue(async () => {
				const { applyTimelineOperation } = await import("@/lib/ai-edition/document/operations");
				// Read the doc inside the chain. The store holds the
				// latest committed state because the previous call's
				// save has already resolved by the time this runs —
				// see the file header for the race this fixes.
				const doc = useProjectStore.getState().document ?? fallbackDocument;
				if (!doc) return null;
				const applied = applyTimelineOperation(doc, op);
				return (await saveDocument(applied.document, opts)) ? applied.document : null;
			}),
		[enqueue, fallbackDocument, saveDocument],
	);

	return { apply, enqueue };
}
