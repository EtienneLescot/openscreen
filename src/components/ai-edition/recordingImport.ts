// Hand-off from the recorder to the editor.
//
// The HUD parks the recording it just finished in ONE main-process slot
// (`set/getCurrentRecordingSession`) and opens the editor, which imports it into
// a fresh project on mount. The slot has to be emptied once that project owns
// the file, because opening the editor destroys and recreates its window
// (`createEditorWindowWrapper` in electron/main.ts) — so a session left in place
// is imported AGAIN on the next open: a second project on the same recording,
// back at the default padding / roundness / wallpaper, while everything the user
// set and saved stays behind in the first project, which is no longer the one on
// screen. That reads exactly like "the editor forgot my settings" (#364).
//
// `setCurrentRecordingSession(null)` is the existing clear (it also drops the
// derived `currentVideoPath`); the only renderer that still needs the session
// after this point is the CLI runner, which lives in its own process.

import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { replaceTimeline as replaceTimelineOp } from "@/lib/ai-edition/document/timeline";
import { patchEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { probeVideoDimensions, probeVideoDuration } from "@/lib/ai-edition/timeline/duration";
import { toAspectRatioToken } from "@/utils/aspectRatioUtils";

/**
 * Imports the recording the HUD handed over into a new project, and consumes the
 * hand-off so it is imported exactly once.
 *
 * Returns false when there is nothing pending — the caller then falls back to
 * reopening the most recent project. Throws if the import itself fails, leaving
 * the session in place so a later mount can retry it.
 */
export async function importPendingRecording(): Promise<boolean> {
	const api = window.electronAPI;
	if (!api) return false;

	const result = await api.getCurrentRecordingSession();
	const screenPath = result.success ? result.session?.screenVideoPath : undefined;
	if (!screenPath) return false;

	const label = screenPath.split(/[\\/]/).pop() || "Recording";
	await useProjectStore.getState().createProject(`Recording ${new Date().toLocaleString()}`);
	await useProjectStore.getState().addAsset(screenPath, label);

	// A Mac display is commonly not 16:9 (the current built-in panel records at
	// 2940×1912). Starting every recording project at 16:9 therefore adds wide
	// side bars before the user's intentional 8% padding is applied, making the
	// padding look different horizontally and vertically. New recording projects
	// should start in the recording's own shape; existing projects retain their
	// stored format. Probe before the editor paints when possible, and keep the
	// dynamic `native` token as the safe fallback until normal metadata probing
	// fills the asset dimensions.
	const importedDocument = useProjectStore.getState().document;
	if (importedDocument) {
		const sourceUrl = toFileUrl(screenPath);
		const [dimensions, durationSec] = await Promise.all([
			probeVideoDimensions(sourceUrl),
			probeVideoDuration(sourceUrl),
		]);
		const nativeAspect = dimensions
			? toAspectRatioToken(dimensions.width, dimensions.height)
			: null;
		let framedDocument = patchEditorSettings(importedDocument, {
			aspectRatio: nativeAspect ?? "native",
		});

		// The import already has the source mounted for metadata probing, so use
		// that result to seed the timeline in the same atomic save. Waiting for a
		// later preview `loadedmetadata` event can strand the editor at 0:00 with
		// "No Webcam" even though both recording files are healthy. A 60-second
		// placeholder preserves the existing WebM fallback and is corrected by the
		// normal metadata callback when the real duration becomes available.
		if (framedDocument.timeline.clips.length === 0 && framedDocument.assets.length > 0) {
			const knownDuration = durationSec ?? 60;
			const primaryAssetId = framedDocument.project.primaryAssetId ?? framedDocument.assets[0]?.id;
			const withDuration = primaryAssetId
				? {
						...framedDocument,
						assets: framedDocument.assets.map((asset) =>
							asset.id === primaryAssetId ? { ...asset, durationSec: knownDuration } : asset,
						),
					}
				: framedDocument;
			framedDocument = replaceTimelineOp(
				withDuration,
				[{ startSec: 0, endSec: knownDuration }],
				"Auto-imported recording",
			);
		}
		const saved = await useProjectStore.getState().saveDocument(framedDocument, { history: false });
		if (!saved) throw new Error("Could not save the recording's native frame shape");
	}
	// Consumed: the recording now lives in a project. Cleared here rather than
	// after the timeline seed below so a failure down there can't hand the same
	// recording to the next editor window.
	await api.setCurrentRecordingSession(null);
	return true;
}
