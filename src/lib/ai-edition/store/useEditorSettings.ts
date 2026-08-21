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

import { useCallback, useMemo, useRef } from "react";
import type { AxcutDocument } from "../schema";
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
			// The optimistic write is not the edit — the save is. Only the one that can
			// fail records, and it names `doc` as what Ctrl+Z returns to because by then
			// the store already holds `next`.
			setDocument(next, { history: false });
			await saveDocument(next, { history: true, historyBase: doc });
		},
		[setDocument, saveDocument],
	);

	// The document this hook's own last `setLive` produced. A slider drag fires one
	// `setLive` per pointer move, and recording each of them buried the real history
	// under sixty one-pixel steps; only the first write of a drag — the one editing a
	// document this callback did not produce — is a state worth returning to. It is
	// held in `liveBaseRef` and recorded by `commit`, not here: a snapshot pushed
	// mid-drag is on the stack whether or not the commit that follows ever lands.
	const liveDocRef = useRef<AxcutDocument | null>(null);
	const liveBaseRef = useRef<AxcutDocument | null>(null);

	const setLive = useCallback(
		(patch: EditorSettingsPatch) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const next = patchEditorSettings(doc, patch);
			if (liveDocRef.current !== doc) liveBaseRef.current = doc;
			setDocument(next, { history: false });
			liveDocRef.current = next;
		},
		[setDocument],
	);

	const commit = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		const base = liveBaseRef.current;
		liveBaseRef.current = null;
		liveDocRef.current = null;
		await saveDocument(doc, { history: true, historyBase: base });
	}, [saveDocument]);

	return { settings, hasDocument, set, setLive, commit };
}
