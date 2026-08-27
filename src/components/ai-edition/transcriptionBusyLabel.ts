import type { AssetTranscriptionView } from "@/lib/ai-edition/transcription/status";

/**
 * Copy for a boolean spinner (Captions / Transcript / Source transcript).
 * Returns null when nothing is in flight so the caller can keep its idle verb.
 */
export function transcriptionBusyLabel(
	view: AssetTranscriptionView | undefined,
	labelOf: (view: AssetTranscriptionView) => string,
): string | null {
	if (!view || (view.status !== "running" && view.status !== "queued")) return null;
	return labelOf(view);
}
