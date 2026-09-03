import { withTranscript } from "@/lib/ai-edition/document/transcribe";
import { replaceTranscriptText } from "@/lib/ai-edition/document/transcript";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { type DocumentWriteOptions, useProjectStore } from "./projectStore";

interface EnqueueTranscriptTextEditOptions {
	sourceProjectId: string;
	assetId: string;
	wordIds: readonly string[];
	text: string;
	enqueue: (task: () => Promise<boolean> | boolean) => Promise<boolean>;
	saveDocument: (document: AxcutDocument, opts: DocumentWriteOptions) => Promise<boolean>;
}

/**
 * Queues one transcript text edit against the project that originated it.
 * A delayed debounce or unmount flush must not read from a project loaded later.
 */
export function enqueueTranscriptTextEdit({
	sourceProjectId,
	assetId,
	wordIds,
	text,
	enqueue,
	saveDocument,
}: EnqueueTranscriptTextEditOptions): Promise<boolean> {
	return enqueue(async () => {
		const state = useProjectStore.getState();
		const document = state.document;
		if (
			state.projectId !== sourceProjectId ||
			!document ||
			document.project.id !== sourceProjectId
		) {
			return false;
		}
		const transcript =
			document.transcripts.find((entry) => entry.assetId === assetId) ??
			(document.transcript?.assetId === assetId ? document.transcript : null);
		if (!transcript) return false;
		const nextTranscript = replaceTranscriptText(transcript, wordIds, text);
		if (nextTranscript === transcript) return true;
		return saveDocument(withTranscript(document, nextTranscript), { history: true });
	});
}
