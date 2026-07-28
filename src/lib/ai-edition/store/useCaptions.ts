// React binding over the caption modules.
//
// Same contract as `useEditorSettings`: `set` writes + persists, `setLive`
// writes only (for sliders), `commit` flushes. The document stays the single
// source of truth — nothing is cached here.

import { useCallback, useMemo } from "react";
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
import { useProjectStore } from "./projectStore";

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
	const setDocument = useProjectStore((s) => s.setDocument);
	const saveDocument = useProjectStore((s) => s.saveDocument);

	const settings = useMemo(() => getCaptionSettings(document), [document]);
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
			const next = patchCaptionSettings(doc, patch);
			setDocument(next);
			await saveDocument(next);
		},
		[setDocument, saveDocument],
	);

	const setLive = useCallback(
		(patch: CaptionSettingsPatch) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			setDocument(patchCaptionSettings(doc, patch));
		},
		[setDocument],
	);

	const commit = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		await saveDocument(doc);
	}, [saveDocument]);

	const saveTranslation = useCallback<UseCaptionsResult["saveTranslation"]>(
		async (input) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const next = putCaptionTranslation(doc, input);
			setDocument(next);
			await saveDocument(next);
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
				getCaptionSettings(cleared).language === language
					? patchCaptionSettings(cleared, { language: null })
					: cleared;
			setDocument(next);
			await saveDocument(next);
		},
		[setDocument, saveDocument],
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
