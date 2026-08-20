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

import { useCallback, useRef } from "react";
import type { AxcutTimelineOperation } from "@/lib/ai-edition/document/operations";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "./projectStore";

export interface SequentialTimelineOps {
	/**
	 * Queue a timeline op. The op is applied to the latest committed
	 * document (read from the project store inside the queue, after the
	 * previous op's save has resolved), and the resulting document is
	 * saved. Calls are serialised — op N+1 reads the doc op N wrote.
	 *
	 * Returns the saved document, or `null` for either of two different things:
	 * no project document is loaded (store empty AND no fallback supplied), which
	 * is a silent no-op, or the save failed, which the user has already been told
	 * about. Both call sites `void` the result, so they are not distinguished; a
	 * caller that needs to tell them apart has to widen this return type first.
	 */
	apply: (op: AxcutTimelineOperation) => Promise<AxcutDocument | null>;
}

export function useSequentialTimelineOps(options: {
	/** Used only when the project store has no document yet. */
	fallbackDocument: AxcutDocument | null;
	/** Persist a document, resolving false if the write failed (already reported).
	 *  The hook awaits this before unblocking the queue. */
	saveDocument: (doc: AxcutDocument) => Promise<boolean>;
}): SequentialTimelineOps {
	const { fallbackDocument, saveDocument } = options;
	const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

	const apply = useCallback(
		(op: AxcutTimelineOperation): Promise<AxcutDocument | null> => {
			const queued = saveQueueRef.current
				.then(() => import("@/lib/ai-edition/document/operations"))
				.then(async ({ applyTimelineOperation }) => {
					// Read the doc inside the chain. The store holds the
					// latest committed state because the previous call's
					// save has already resolved by the time this .then
					// runs — see the file header for the race this fixes.
					const doc = useProjectStore.getState().document ?? fallbackDocument;
					if (!doc) return null;
					const applied = applyTimelineOperation(doc, op);
					return (await saveDocument(applied.document)) ? applied.document : null;
				});
			// Keep operation/import errors from poisoning the queue -- the next call still
			// needs a resolved promise to chain off. Save failures already resolve to null.
			saveQueueRef.current = queued.then(
				() => undefined,
				() => undefined,
			);
			return queued;
		},
		[fallbackDocument, saveDocument],
	);

	return { apply };
}
