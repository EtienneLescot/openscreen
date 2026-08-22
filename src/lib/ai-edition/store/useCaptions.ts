// React binding over the caption modules.
//
// Same contract as `useEditorSettings`: `set` writes + persists, `setLive`
// writes only (for sliders), `commit` flushes. The document stays the single
// source of truth — nothing is cached here.

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	type CaptionCue,
	type CaptionSettings,
	type CaptionSettingsPatch,
	type CaptionTranslations,
	deriveCaptionCues,
	getCaptionSettings,
	getCaptionTranslations,
	patchCaptionSettings,
	putCaptionTranslation,
	removeCaptionTranslation,
} from "../captions";
import { resolveAspectRatioValue } from "../document/outputFormat";
import type { AxcutDocument } from "../schema";
import { useProjectStore } from "./projectStore";
import { useEditorSettings } from "./useEditorSettings";

export interface UseCaptionsResult {
	settings: CaptionSettings;
	translations: CaptionTranslations;
	/** Every cue for the current document, in timeline ms. `[]` when hidden. */
	cues: CaptionCue[];
	/** True when there's a project loaded — the writers are no-ops otherwise. */
	hasDocument: boolean;
	/** True when at least one clip's asset has a transcript to caption. */
	hasTranscript: boolean;
	set: (patch: CaptionSettingsPatch) => Promise<void>;
	setLive: (patch: CaptionSettingsPatch) => void;
	commit: () => Promise<void>;
	saveTranslation: (input: {
		language: string;
		label: string;
		assetId: string;
		segments: Record<string, string>;
		model?: string;
	}) => Promise<void>;
	deleteTranslation: (language: string) => Promise<void>;
}

export function useCaptions(): UseCaptionsResult {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const setDocument = useProjectStore((s) => s.setDocument);
	const saveDocument = useProjectStore((s) => s.saveDocument);

	// The output aspect decides the caption column and the DEFAULT insets, so it has
	// to reach both the read and every write: the first write to a document that has
	// never carried caption settings is what freezes those defaults in, and a 9:16
	// export wants a much larger inset than a 16:9 one. `resolveAspectRatioValue` is
	// the same resolver the preview and the scene description use — not
	// `getAspectRatioValue`, which answers 16/9 for the legacy "native" selection and
	// would disagree with what the compositor is handed.
	const { settings: editorSettings } = useEditorSettings();
	const aspectValue = useMemo(
		() => resolveAspectRatioValue(document, editorSettings.aspectRatio),
		[document, editorSettings.aspectRatio],
	);

	const settings = useMemo(
		() => getCaptionSettings(document, aspectValue),
		[document, aspectValue],
	);
	const translations = useMemo(() => getCaptionTranslations(document), [document]);
	const cues = useMemo(
		() => deriveCaptionCues(document, settings, translations),
		[document, settings, translations],
	);

	const hasTranscript = useMemo(() => {
		if (!document) return false;
		const withTranscript = new Set(document.transcripts.map((t) => t.assetId));
		return document.timeline.clips.some((clip) => withTranscript.has(clip.assetId));
	}, [document]);

	const set = useCallback(
		async (patch: CaptionSettingsPatch) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const next = patchCaptionSettings(doc, patch, aspectValue);
			// The optimistic write is not the edit — the save is. Only the one that can
			// fail records, and it names `doc` as what Ctrl+Z returns to because by then
			// the store already holds `next`.
			setDocument(next, { history: false });
			await saveDocument(next, { history: true, historyBase: doc });
		},
		[setDocument, saveDocument, aspectValue],
	);

	// See `useEditorSettings.setLive`: one undo step per slider drag, not one per
	// pointer move. `liveDocRef` holds what this hook last wrote, so only a write
	// landing on someone else's document opens a new history entry -- and that entry
	// is `liveBaseRef`, handed to the commit rather than recorded on the spot.
	const liveDocRef = useRef<AxcutDocument | null>(null);
	const liveBaseRef = useRef<AxcutDocument | null>(null);

	// The same release `useEditorSettings` does, for the same reason: a drag that never
	// commits leaves these holding two whole documents for the lifetime of the hook
	// instance. `commit` below is what keeps a stale one off the undo stack.
	// biome-ignore lint/correctness/useExhaustiveDependencies: projectId is the trigger, not a read — the body only clears refs.
	useEffect(() => {
		liveDocRef.current = null;
		liveBaseRef.current = null;
	}, [projectId]);

	const setLive = useCallback(
		(patch: CaptionSettingsPatch) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const next = patchCaptionSettings(doc, patch, aspectValue);
			if (liveDocRef.current !== doc) liveBaseRef.current = doc;
			setDocument(next, { history: false });
			liveDocRef.current = next;
		},
		[setDocument, aspectValue],
	);

	const commit = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		// See `useEditorSettings.commit`: a base is only worth recording while the
		// document on screen is still the one this hook's live writes produced.
		const base = liveDocRef.current === doc ? liveBaseRef.current : null;
		liveBaseRef.current = null;
		liveDocRef.current = null;
		await saveDocument(doc, { history: true, historyBase: base });
	}, [saveDocument]);

	const saveTranslation = useCallback<UseCaptionsResult["saveTranslation"]>(
		async (input) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const next = putCaptionTranslation(doc, input);
			setDocument(next, { history: false });
			await saveDocument(next, { history: true, historyBase: doc });
		},
		[setDocument, saveDocument],
	);

	const deleteTranslation = useCallback(
		async (language: string) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			// Falling back to the original is the only sane landing spot when the
			// language currently on screen is the one being deleted.
			const cleared = removeCaptionTranslation(doc, language);
			const next =
				getCaptionSettings(cleared, aspectValue).language === language
					? patchCaptionSettings(cleared, { language: null }, aspectValue)
					: cleared;
			setDocument(next, { history: false });
			await saveDocument(next, { history: true, historyBase: doc });
		},
		[setDocument, saveDocument, aspectValue],
	);

	return {
		settings,
		translations,
		cues,
		hasDocument: document !== null,
		hasTranscript,
		set,
		setLive,
		commit,
		saveTranslation,
		deleteTranslation,
	};
}
