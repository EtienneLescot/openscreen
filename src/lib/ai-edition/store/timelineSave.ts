import { toast } from "sonner";
import type { AxcutDocument } from "../schema";

type SaveDocument = (document: AxcutDocument) => Promise<unknown>;

/**
 * Persist a user-initiated timeline mutation without letting a detached caller
 * turn a write failure into an unhandled rejection.
 */
export async function saveTimelineMutation(
	saveDocument: SaveDocument,
	document: AxcutDocument,
): Promise<boolean> {
	try {
		await saveDocument(document);
		return true;
	} catch (error) {
		console.error("[timeline] failed to save mutation:", error);
		toast.error("Save failed", {
			description: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
