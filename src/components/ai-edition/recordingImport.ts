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
import { patchEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { probeVideoDimensions } from "@/lib/ai-edition/timeline/duration";
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
		const dimensions = await probeVideoDimensions(toFileUrl(screenPath));
		const nativeAspect = dimensions
			? toAspectRatioToken(dimensions.width, dimensions.height)
			: null;
		const framedDocument = patchEditorSettings(importedDocument, {
			aspectRatio: nativeAspect ?? "native",
		});
		const saved = await useProjectStore.getState().saveDocument(framedDocument, { history: false });
		if (!saved) throw new Error("Could not save the recording's native frame shape");
	}
	// Consumed: the recording now lives in a project. Cleared here rather than
	// after the timeline seed below so a failure down there can't hand the same
	// recording to the next editor window.
	await api.setCurrentRecordingSession(null);

	// ponytail: MediaRecorder WebMs ship with duration = NaN until
	// fix-webm-duration patches the EBML header; until that flows through the
	// asset, drop a default 60s clip into the timeline so the editor isn't stuck
	// on "No clips yet" the moment the user lands in the project. Real duration
	// overwrites this when handleLoadedMetadata fires with a finite value.
	const doc = useProjectStore.getState().document;
	if (doc && doc.timeline.clips.length === 0 && doc.assets.length > 0) {
		// `history: false`. Nothing here is an edit: the user finished a recording and the
		// editor built them a project around it, unattended, on mount. Recording it left a
		// brand-new project sitting at `past.length === 1` before the user had touched
		// anything, so their FIRST Ctrl+Z restored the state before the seed -- an empty
		// timeline -- and the persist that follows an undo wrote that empty timeline to disk.
		await useProjectStore
			.getState()
			.replaceTimeline([{ startSec: 0, endSec: 60 }], "Auto-imported recording", {
				history: false,
			});
	}
	return true;
}
