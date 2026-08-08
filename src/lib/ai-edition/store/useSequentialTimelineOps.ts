// ponytail: serialise timeline-edit saves so two rapid calls don't race
// each other's save and overwrite one another in the store. The previous
// in-component implementation in NewEditorShell.tsx had a subtle race
// where the doc was read SYNCHRONOUSLY at call time but the save was
// serialised; two concurrent calls would both read the same pre-edit
// doc and the second save would clobber the first edit. The fix is to
// read the doc INSIDE the chain, after awaiting the previous save, so
// every call sees the doc state the previous call committed.
//
// Save failures are surfaced once by the shared mutation boundary and resolve
// to null. This keeps detached UI calls from emitting unhandled rejections and
// also leaves the queue healthy for the next edit.

import { useCallback, useRef } from "react";
import type { AxcutTimelineOperation } from "@/lib/ai-edition/document/operations";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "./projectStore";
import { saveTimelineMutation } from "./timelineSave";

export interface SequentialTimelineOps {
	/**
	 * Queue a timeline op. The op is applied to the latest committed
	 * document (read from the project store inside the queue, after the
	 * previous op's save has resolved), and the resulting document is
	 * saved. Calls are serialised — op N+1 reads the doc op N wrote.
	 *
	 * Returns the saved document, or `null` if no project document is
	 * loaded (store empty AND no fallback supplied) or the save fails.
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
				.then(async ({ applyTimelineOperation }) => {
					// Read the doc inside the chain. The store holds the
					// latest committed state because the previous call's
					// save has already resolved by the time this .then
					// runs — see the file header for the race this fixes.
					const doc = useProjectStore.getState().document ?? fallbackDocument;
					if (!doc) return null;
					const applied = applyTimelineOperation(doc, op);
					const saved = await saveTimelineMutation(saveDocument, applied.document);
					return saved ? applied.document : null;
				});
			// Keep operation/import errors from poisoning the queue. Save
			// failures already resolve to null after showing user feedback.
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
