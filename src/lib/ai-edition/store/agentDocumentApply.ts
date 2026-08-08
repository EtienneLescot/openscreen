import { ensureDocument } from "../schema";
import { useProjectStore } from "./projectStore";

export type AgentDocumentApplyResult = "applied" | "conflict";

/**
 * Apply a full document returned by the agent only if the live editor is still
 * on the revision used to start that agent turn.
 *
 * `expectedRevision` is omitted for explicit rewind operations, where replacing
 * the current document is the action the user just confirmed.
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
	store.setDocument(parsed);
	await store.saveDocument(parsed);
	return "applied";
}
