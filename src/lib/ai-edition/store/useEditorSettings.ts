// React binding over the editor-settings pure module.
//
// Usage:
//   const { settings, set, setLive } = useEditorSettings();
//   - `settings` is a typed snapshot of the document's legacy settings.
//   - `set(patch)` writes + commits to disk (use for toggles, selects, on
//     slider release).
//   - `setLive(patch)` writes only (use while dragging a slider for the
//     preview to update without round-tripping every pixel).
//
// The hook is intentionally thin: it reads from the project store, applies
// the patch through `patchEditorSettings`, and persists via the store. No
// extra state, no caches — the document is the single source of truth.

import { useCallback, useMemo } from "react";
import {
	type EditorSettingsPatch,
	type EditorSettingsSnapshot,
	getEditorSettings,
	patchEditorSettings,
} from "./editorSettings";
import { useProjectStore } from "./projectStore";

export interface UseEditorSettingsResult {
	settings: EditorSettingsSnapshot;
	/** True when there's a project loaded — `set`/`setLive` are no-ops otherwise. */
	hasDocument: boolean;
	/** Apply a patch, persist to disk. */
	set: (patch: EditorSettingsPatch) => Promise<void>;
	/** Apply a patch, no persist. Pair with `commit` on slider release. */
	setLive: (patch: EditorSettingsPatch) => void;
	/** Force-flush the current document to disk. */
	commit: () => Promise<void>;
}

export function useEditorSettings(): UseEditorSettingsResult {
	const document = useProjectStore((s) => s.document);
	const setDocument = useProjectStore((s) => s.setDocument);
	const saveDocument = useProjectStore((s) => s.saveDocument);

	const hasDocument = document !== null;

	const settings = useMemo(() => getEditorSettings(document), [document]);

	const set = useCallback(
		async (patch: EditorSettingsPatch) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const next = patchEditorSettings(doc, patch);
			setDocument(next);
			await saveDocument(next);
		},
		[setDocument, saveDocument],
	);

	const setLive = useCallback(
		(patch: EditorSettingsPatch) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			setDocument(patchEditorSettings(doc, patch));
		},
		[setDocument],
	);

	const commit = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		await saveDocument(doc);
	}, [saveDocument]);

	return { settings, hasDocument, set, setLive, commit };
}
