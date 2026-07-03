// ponytail: optimistic timeline-ops state machine. Mirrors axcut's
// `queueTimelineOperation` flow but on a smaller surface: we read the
// project store, apply the op locally for instant UI feedback, fire
// the IPC, then either commit the server's authoritative document or
// roll back on failure. Session messages aren't touched locally — the
// server appends the summary message before returning.

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { nativeBridgeClient } from "@/native/client";
import type { AxcutTimelineOperation } from "@/native/contracts";
import { applyTimelineOperation } from "../document/operations";
import type { AxcutDocument } from "../schema";
import { useProjectStore } from "./projectStore";

export interface OptimisticTimelineOps {
	queue: (operation: AxcutTimelineOperation, conversationMessage: string) => Promise<void>;
	busy: boolean;
}

export function useOptimisticTimelineOps(
	projectId: string | null,
	sessionId: string | null,
): OptimisticTimelineOps {
	const [busy, setBusy] = useState(false);

	const queue = useCallback(
		async (operation: AxcutTimelineOperation, conversationMessage: string) => {
			if (!projectId || !sessionId) {
				toast.error("Open a project to run a timeline operation.");
				return;
			}
			const store = useProjectStore.getState();
			const previous = store.document;
			if (!previous) {
				toast.error("No project document loaded yet.");
				return;
			}
			const optimistic = applyTimelineOperation(previous, operation).document;
			store.setDocument(optimistic);
			setBusy(true);
			try {
				const result = await nativeBridgeClient.aiEdition.runTimelineOperation(
					projectId,
					sessionId,
					operation,
					conversationMessage,
				);
				if (!result.success) {
					store.setDocument(previous);
					toast.error("Timeline edit failed", { description: result.error });
					return;
				}
				// ponytail: keep the optimistic doc on failure-free success. The
				// server-applied doc is byte-identical in the happy path; only
				// when normalisation diverges do we need to swap.
				const serverDoc = result.result.document as AxcutDocument;
				store.setDocument(serverDoc);
				toast.success(result.result.summary);
			} catch (err) {
				store.setDocument(previous);
				toast.error("Timeline edit failed", {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setBusy(false);
			}
		},
		[projectId, sessionId],
	);

	return { queue, busy };
}
