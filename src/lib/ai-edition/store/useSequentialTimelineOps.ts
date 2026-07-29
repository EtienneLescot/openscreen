// ponytail: serialise timeline-edit saves so two rapid calls don't race
// each other's save and overwrite one another in the store. The previous
// in-component implementation in NewEditorShell.tsx had a subtle race
// where the doc was read SYNCHRONOUSLY at call time but the save was
// serialised; two concurrent calls would both read the same pre-edit
// doc and the second save would clobber the first edit. The fix is to
// read the doc INSIDE the chain, after awaiting the previous save, so
// every call sees the doc state the previous call committed.
//
// Errors are swallowed when advancing the queue ref so a failed save
// doesn't poison the queue (the next call still has a resolved promise
// to chain off). The original promise returned to the caller is NOT
// swallowed — the caller can await it and observe the rejection.

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
	 * Returns the saved document, or `null` if no project document is
	 * loaded (store empty AND no fallback supplied).
	 */
	apply: (op: AxcutTimelineOperation) => Promise<AxcutDocument | null>;
}

export function useSequentialTimelineOps(options: {
	/** Used only when the project store has no document yet. */
	fallbackDocument: AxcutDocument | null;
	/** Persist a document. The hook awaits this before unblocking the queue. */
	saveDocument: (doc: AxcutDocument) => Promise<unknown>;
}): SequentialTimelineOps {
	const { fallbackDocument, saveDocument } = options;
	const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

	const apply = useCallback(
		(op: AxcutTimelineOperation): Promise<AxcutDocument | null> => {
			const queued = saveQueueRef.current
				.then(() => import("@/lib/ai-edition/document/operations"))
				.then(({ applyTimelineOperation }) => {
					// Read the doc inside the chain. The store holds the
					// latest committed state because the previous call's
					// save has already resolved by the time this .then
					// runs — see the file header for the race this fixes.
					const doc = useProjectStore.getState().document ?? fallbackDocument;
					if (!doc) return null;
					const applied = applyTimelineOperation(doc, op);
					return saveDocument(applied.document).then(() => applied.document);
				});
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
		},
		[fallbackDocument, saveDocument],
	);

	return { apply };
}
