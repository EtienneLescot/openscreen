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

import { useCallback, useEffect, useMemo, useRef } from "react";
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
	const projectId = useProjectStore((s) => s.projectId);
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

	// A drag does not always end in a commit -- the gradient editor's is a 400ms timer
	// its own unmount cleanup cancels -- and nothing else empties these, so left alone
	// they pin two whole documents for the lifetime of the hook instance, and
	// annotations can carry base64 image data URLs. What the pin is worth, since a
	// count is easy to get wrong here: ten components call `useEditorSettings()`, at
	// most FIVE are mounted together (`PreviewCanvas` with `VirtualPreview` and
	// `WebcamOverlay` inside it, `V4Timeline`, and one inspector body), and of those
	// only two can ever fill these refs, because only `PreviewCanvas` and the pane the
	// inspector is showing call `setLive` -- the five `RightPanes` exports are
	// `FacetBody`'s mutually exclusive branches, so one at a time. Two instances, two
	// documents each.
	//
	// Release them when the project changes, which is the guard `useTimeline` carries,
	// keyed on the same thing, for the same reason -- and its two drag commits carry
	// the identity test below too, so the pair is symmetric in shape. It is not
	// symmetric in what a stale snapshot COSTS: `commitZoomFocus` and
	// `commitAnnotationChange` also write theirs back into the store when the save
	// fails, so a stale one there is a DOCUMENT and silently drops every edit since.
	// This hook has no rollback path, so the same staleness costs a history step and
	// nothing else.
	//
	// What this effect is NOT is the reason a snapshot of the project the user left
	// cannot reach the undo stack: `commit` below decides that, and decides it for a
	// project that never changed too.
	// biome-ignore lint/correctness/useExhaustiveDependencies: projectId is the trigger, not a read — the body only clears refs.
	useEffect(() => {
		liveDocRef.current = null;
		liveBaseRef.current = null;
	}, [projectId]);

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
		// The base counts only while the document on screen is still the one this hook's
		// last `setLive` produced -- `setLive`'s own identity test, read the other way
		// round. `SliderCell` fires `commit` from a bare mouseup with no `onChange` in
		// front of it, so a click on a thumb arrives here carrying whatever base a drag
		// that never committed left behind, and every recording write since has already
		// put the states in between on the stack: handing that base on made one Ctrl+Z
		// step over the lot of them. Across a project switch it is worse than a wrong
		// step -- the snapshot names the OLD project, and `undo` answers a projectId
		// that is not the store's by throwing the whole stack away.
		const base = liveDocRef.current === doc ? liveBaseRef.current : null;
		liveBaseRef.current = null;
		liveDocRef.current = null;
		await saveDocument(doc, { history: true, historyBase: base });
	}, [saveDocument]);

	return { settings, hasDocument, set, setLive, commit };
}
