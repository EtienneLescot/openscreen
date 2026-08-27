/**
 * GENERATED FILE — do not edit. Run `node scripts/gen-recreation.mjs` instead.
 *
 * Every value below was read out of, or computed from, one of:
 *   · src/components/Recreation/fixture-slim.json (the project document, schemaVersion 7)
 *   · ../src/i18n/locales/en/{editor,settings,timeline}.json
 *   · ../src/lib/ai-edition/timeline/{format,zoom-scale,aggregated-transcript}.ts, imported and run
 *   · ../src/components/ai-edition/v4/V4Timeline.tsx, lifted as source text and evaluated
 *   · ../src/styles/design-tokens.css
 *   · static/img/walkthrough/04-agent-a.jpg and editor-1560.jpg (two strings; see PROVENANCE)
 *
 * PROVENANCE names the source of every string this file puts on screen. Nothing
 * that could not be sourced was invented to fill a gap: the chat's context pill
 * is absent for that reason, and so is the webcam bubble.
 */

export interface RecreationWord {
	i: number;
	id: string;
	kind: "word" | "silence";
	text: string;
	startSec: number;
	endSec: number;
	kept: boolean;
	trimId: string | null;
}

export interface RecreationPill {
	lane: string;
	id: string;
	label: string;
	startSec: number;
	endSec: number;
	leftPct: number;
	widthPct: number;
	/** zoom lanes only — the stored ordinal the label was derived from. */
	depth?: number;
	/** zoom lanes only. */
	focusMode?: string;
	/** trim lanes only — "agent" for the two the agent placed. */
	origin?: string;
}

export interface RecreationLane {
	id: string;
	hint: string | null;
	pills: RecreationPill[];
}

export interface ProvenanceEntry {
	shown: string;
	source: string;
}

/** Where this data came from, and what it is a recreation of. */
export const META = {
	schemaVersion: 7,
	projectId: "proj_97e2ec4f-78a1-4198-9743-05511c204daa",
	projectTitle: "Bellrock — docs walkthrough",
	assetLabel: "Bellrock — docs walkthrough",
	assetDurationSec: 40.033,
	assetVideo: {
		codec: "unknown",
		width: 1920,
		height: 1080,
		fps: 0,
	},
	cameraTrackVisible: false,
	generator: "website/scripts/gen-recreation.mjs",
} as const;

/** The transcript pane's header. */
export const INSPECTOR = {
	title: "Current transcription",
	indexBadge: "1",
	filename: "Bellrock — docs walkthrough",
	clipRange: "Clip 1 · 0:00.0—0:40.0",
	wordCount: 103,
	silenceCount: 3,
	silenceThresholdSec: 0.2,
} as const;

/**
 * The transcript flow, produced by the app's own `buildClipSection`: 103
 * words and 3 silence markers, each tagged kept or removed against the
 * document's two agent trims. 2 entries are removed, all of them silences.
 */
export const WORDS: RecreationWord[] = [
	{ i: 0, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:silence_1", kind: "silence", text: "[silence 2.2s]", startSec: 0, endSec: 2.19, kept: false, trimId: "trim_f52989cf-489c-47f5-a6c7-b95a7d71b399" },
	{ i: 1, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_1", kind: "word", text: "Hi,", startSec: 2.19, endSec: 2.63, kept: true, trimId: null },
	{ i: 2, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_2", kind: "word", text: "quick", startSec: 2.63, endSec: 3.02, kept: true, trimId: null },
	{ i: 3, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_3", kind: "word", text: "walk", startSec: 3.02, endSec: 3.08, kept: true, trimId: null },
	{ i: 4, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_4", kind: "word", text: "through", startSec: 3.08, endSec: 3.29, kept: true, trimId: null },
	{ i: 5, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_5", kind: "word", text: "the", startSec: 3.29, endSec: 3.95, kept: true, trimId: null },
	{ i: 6, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_6", kind: "word", text: "documentation", startSec: 3.95, endSec: 4.62, kept: true, trimId: null },
	{ i: 7, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_7", kind: "word", text: "site.", startSec: 4.62, endSec: 4.94, kept: true, trimId: null },
	{ i: 8, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_8", kind: "word", text: "The", startSec: 4.94, endSec: 5.2, kept: true, trimId: null },
	{ i: 9, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_9", kind: "word", text: "new", startSec: 5.2, endSec: 5.5200000000000005, kept: true, trimId: null },
	{ i: 10, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_10", kind: "word", text: "release", startSec: 5.5200000000000005, endSec: 5.62, kept: true, trimId: null },
	{ i: 11, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_11", kind: "word", text: "went", startSec: 5.62, endSec: 5.79, kept: true, trimId: null },
	{ i: 12, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_12", kind: "word", text: "out", startSec: 5.79, endSec: 6.01, kept: true, trimId: null },
	{ i: 13, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_13", kind: "word", text: "this", startSec: 6.01, endSec: 6.47, kept: true, trimId: null },
	{ i: 14, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_14", kind: "word", text: "morning.", startSec: 6.47, endSec: 6.82, kept: true, trimId: null },
	{ i: 15, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_15", kind: "word", text: "The", startSec: 6.83, endSec: 7.2, kept: true, trimId: null },
	{ i: 16, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_16", kind: "word", text: "hero", startSec: 7.2, endSec: 7.37, kept: true, trimId: null },
	{ i: 17, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_17", kind: "word", text: "does", startSec: 7.37, endSec: 7.57, kept: true, trimId: null },
	{ i: 18, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_18", kind: "word", text: "the", startSec: 7.57, endSec: 7.88, kept: true, trimId: null },
	{ i: 19, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_19", kind: "word", text: "work", startSec: 7.88, endSec: 8.16, kept: true, trimId: null },
	{ i: 20, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_20", kind: "word", text: "now.", startSec: 8.16, endSec: 8.58, kept: true, trimId: null },
	{ i: 21, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_21", kind: "word", text: "One", startSec: 8.58, endSec: 9.06, kept: true, trimId: null },
	{ i: 22, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_22", kind: "word", text: "line,", startSec: 9.06, endSec: 9.5, kept: true, trimId: null },
	{ i: 23, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_23", kind: "word", text: "one", startSec: 9.5, endSec: 10.040000000000001, kept: true, trimId: null },
	{ i: 24, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_24", kind: "word", text: "promise,", startSec: 10.040000000000001, endSec: 10.41, kept: true, trimId: null },
	{ i: 25, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_25", kind: "word", text: "and", startSec: 10.41, endSec: 10.6, kept: true, trimId: null },
	{ i: 26, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_26", kind: "word", text: "the", startSec: 10.6, endSec: 10.950000000000001, kept: true, trimId: null },
	{ i: 27, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_27", kind: "word", text: "install", startSec: 10.950000000000001, endSec: 11.21, kept: true, trimId: null },
	{ i: 28, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_28", kind: "word", text: "command", startSec: 11.21, endSec: 11.61, kept: true, trimId: null },
	{ i: 29, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_29", kind: "word", text: "right", startSec: 11.61, endSec: 11.97, kept: true, trimId: null },
	{ i: 30, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_30", kind: "word", text: "under", startSec: 11.97, endSec: 12.290000000000001, kept: true, trimId: null },
	{ i: 31, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_31", kind: "word", text: "it.", startSec: 12.290000000000001, endSec: 12.68, kept: true, trimId: null },
	{ i: 32, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_32", kind: "word", text: "Scrolling", startSec: 12.68, endSec: 13.25, kept: true, trimId: null },
	{ i: 33, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_33", kind: "word", text: "down,", startSec: 13.25, endSec: 13.63, kept: true, trimId: null },
	{ i: 34, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_34", kind: "word", text: "those", startSec: 13.63, endSec: 14.02, kept: true, trimId: null },
	{ i: 35, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_35", kind: "word", text: "six", startSec: 14.02, endSec: 14.4, kept: true, trimId: null },
	{ i: 36, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_36", kind: "word", text: "cards", startSec: 14.4, endSec: 14.450000000000001, kept: true, trimId: null },
	{ i: 37, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_37", kind: "word", text: "are", startSec: 14.450000000000001, endSec: 14.620000000000001, kept: true, trimId: null },
	{ i: 38, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_38", kind: "word", text: "the", startSec: 14.620000000000001, endSec: 14.77, kept: true, trimId: null },
	{ i: 39, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_39", kind: "word", text: "whole", startSec: 14.77, endSec: 15.21, kept: true, trimId: null },
	{ i: 40, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_40", kind: "word", text: "library", startSec: 15.21, endSec: 15.530000000000001, kept: true, trimId: null },
	{ i: 41, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_41", kind: "word", text: "on", startSec: 15.530000000000001, endSec: 15.75, kept: true, trimId: null },
	{ i: 42, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_42", kind: "word", text: "one", startSec: 15.75, endSec: 16.13, kept: true, trimId: null },
	{ i: 43, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_43", kind: "word", text: "screen.", startSec: 16.13, endSec: 16.62, kept: true, trimId: null },
	{ i: 44, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_44", kind: "word", text: "No", startSec: 16.82, endSec: 16.93, kept: true, trimId: null },
	{ i: 45, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_45", kind: "word", text: "page", startSec: 16.93, endSec: 17.37, kept: true, trimId: null },
	{ i: 46, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_46", kind: "word", text: "gets", startSec: 17.37, endSec: 17.62, kept: true, trimId: null },
	{ i: 47, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_47", kind: "word", text: "more", startSec: 17.62, endSec: 17.7, kept: true, trimId: null },
	{ i: 48, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_48", kind: "word", text: "than", startSec: 17.7, endSec: 17.96, kept: true, trimId: null },
	{ i: 49, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_49", kind: "word", text: "a", startSec: 17.96, endSec: 18.18, kept: true, trimId: null },
	{ i: 50, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_50", kind: "word", text: "sentence.", startSec: 18.18, endSec: 18.93, kept: true, trimId: null },
	{ i: 51, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_51", kind: "word", text: "Over", startSec: 18.93, endSec: 19.07, kept: true, trimId: null },
	{ i: 52, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_52", kind: "word", text: "on", startSec: 19.07, endSec: 19.56, kept: true, trimId: null },
	{ i: 53, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_53", kind: "word", text: "status,", startSec: 19.56, endSec: 20.17, kept: true, trimId: null },
	{ i: 54, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_54", kind: "word", text: "every", startSec: 20.17, endSec: 20.650000000000002, kept: true, trimId: null },
	{ i: 55, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_55", kind: "word", text: "component", startSec: 20.650000000000002, endSec: 21.06, kept: true, trimId: null },
	{ i: 56, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_56", kind: "word", text: "with", startSec: 21.06, endSec: 21.31, kept: true, trimId: null },
	{ i: 57, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_57", kind: "word", text: "30", startSec: 21.31, endSec: 21.490000000000002, kept: true, trimId: null },
	{ i: 58, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_58", kind: "word", text: "days", startSec: 21.490000000000002, endSec: 21.82, kept: true, trimId: null },
	{ i: 59, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_59", kind: "word", text: "of", startSec: 21.82, endSec: 21.91, kept: true, trimId: null },
	{ i: 60, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_60", kind: "word", text: "probes", startSec: 21.91, endSec: 22.36, kept: true, trimId: null },
	{ i: 61, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_61", kind: "word", text: "behind", startSec: 22.36, endSec: 22.740000000000002, kept: true, trimId: null },
	{ i: 62, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_62", kind: "word", text: "it.", startSec: 22.740000000000002, endSec: 23.05, kept: true, trimId: null },
	{ i: 63, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_63", kind: "word", text: "One", startSec: 23.19, endSec: 23.45, kept: true, trimId: null },
	{ i: 64, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_64", kind: "word", text: "amber", startSec: 23.45, endSec: 23.63, kept: true, trimId: null },
	{ i: 65, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_65", kind: "word", text: "day", startSec: 23.63, endSec: 23.830000000000002, kept: true, trimId: null },
	{ i: 66, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_66", kind: "word", text: "on", startSec: 23.830000000000002, endSec: 24.060000000000002, kept: true, trimId: null },
	{ i: 67, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_67", kind: "word", text: "the", startSec: 24.060000000000002, endSec: 24.27, kept: true, trimId: null },
	{ i: 68, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_68", kind: "word", text: "validator,", startSec: 24.27, endSec: 24.94, kept: true, trimId: null },
	{ i: 69, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_69", kind: "word", text: "and", startSec: 24.94, endSec: 25.19, kept: true, trimId: null },
	{ i: 70, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_70", kind: "word", text: "it", startSec: 25.19, endSec: 25.560000000000002, kept: true, trimId: null },
	{ i: 71, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_71", kind: "word", text: "recovered,", startSec: 25.560000000000002, endSec: 25.990000000000002, kept: true, trimId: null },
	{ i: 72, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_72", kind: "word", text: "and", startSec: 25.990000000000002, endSec: 26.54, kept: true, trimId: null },
	{ i: 73, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_73", kind: "word", text: "releases.", startSec: 26.54, endSec: 27.09, kept: true, trimId: null },
	{ i: 74, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:silence_2", kind: "silence", text: "[silence 0.2s]", startSec: 27.09, endSec: 27.32, kept: true, trimId: null },
	{ i: 75, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_74", kind: "word", text: "Three", startSec: 27.32, endSec: 27.400000000000002, kept: true, trimId: null },
	{ i: 76, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_75", kind: "word", text: "of", startSec: 27.400000000000002, endSec: 27.45, kept: true, trimId: null },
	{ i: 77, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_76", kind: "word", text: "them,", startSec: 27.45, endSec: 28.060000000000002, kept: true, trimId: null },
	{ i: 78, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_77", kind: "word", text: "newest", startSec: 28.060000000000002, endSec: 28.54, kept: true, trimId: null },
	{ i: 79, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_78", kind: "word", text: "first,", startSec: 28.54, endSec: 28.95, kept: true, trimId: null },
	{ i: 80, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_79", kind: "word", text: "and", startSec: 28.95, endSec: 29.240000000000002, kept: true, trimId: null },
	{ i: 81, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_80", kind: "word", text: "every", startSec: 29.240000000000002, endSec: 29.53, kept: true, trimId: null },
	{ i: 82, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_81", kind: "word", text: "line", startSec: 29.53, endSec: 29.88, kept: true, trimId: null },
	{ i: 83, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_82", kind: "word", text: "links", startSec: 29.88, endSec: 30.09, kept: true, trimId: null },
	{ i: 84, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_83", kind: "word", text: "into", startSec: 30.09, endSec: 30.32, kept: true, trimId: null },
	{ i: 85, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_84", kind: "word", text: "the", startSec: 30.32, endSec: 30.560000000000002, kept: true, trimId: null },
	{ i: 86, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_85", kind: "word", text: "commit", startSec: 30.560000000000002, endSec: 30.62, kept: true, trimId: null },
	{ i: 87, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_86", kind: "word", text: "that", startSec: 30.62, endSec: 30.810000000000002, kept: true, trimId: null },
	{ i: 88, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_87", kind: "word", text: "did", startSec: 30.810000000000002, endSec: 31.1, kept: true, trimId: null },
	{ i: 89, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_88", kind: "word", text: "it.", startSec: 31.1, endSec: 31.560000000000002, kept: true, trimId: null },
	{ i: 90, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_89", kind: "word", text: "Back", startSec: 31.39, endSec: 31.62, kept: true, trimId: null },
	{ i: 91, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_90", kind: "word", text: "to", startSec: 31.62, endSec: 31.76, kept: true, trimId: null },
	{ i: 92, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_91", kind: "word", text: "the", startSec: 31.76, endSec: 32.160000000000004, kept: true, trimId: null },
	{ i: 93, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_92", kind: "word", text: "top,", startSec: 32.160000000000004, endSec: 32.46, kept: true, trimId: null },
	{ i: 94, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_93", kind: "word", text: "and", startSec: 32.46, endSec: 32.730000000000004, kept: true, trimId: null },
	{ i: 95, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_94", kind: "word", text: "that", startSec: 32.730000000000004, endSec: 32.86, kept: true, trimId: null },
	{ i: 96, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_95", kind: "word", text: "is", startSec: 32.86, endSec: 32.9, kept: true, trimId: null },
	{ i: 97, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_96", kind: "word", text: "the", startSec: 32.9, endSec: 33.07, kept: true, trimId: null },
	{ i: 98, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_97", kind: "word", text: "whole", startSec: 33.07, endSec: 33.55, kept: true, trimId: null },
	{ i: 99, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_98", kind: "word", text: "flow.", startSec: 33.55, endSec: 34.03, kept: true, trimId: null },
	{ i: 100, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_99", kind: "word", text: "Tell", startSec: 33.99, endSec: 34.19, kept: true, trimId: null },
	{ i: 101, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_100", kind: "word", text: "me", startSec: 34.19, endSec: 34.5, kept: true, trimId: null },
	{ i: 102, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_101", kind: "word", text: "what", startSec: 34.5, endSec: 34.53, kept: true, trimId: null },
	{ i: 103, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_102", kind: "word", text: "you", startSec: 34.53, endSec: 35, kept: true, trimId: null },
	{ i: 104, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_103", kind: "word", text: "think.", startSec: 35, endSec: 35.12, kept: true, trimId: null },
	{ i: 105, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:silence_3", kind: "silence", text: "[silence 4.9s]", startSec: 35.12, endSec: 40.033, kept: false, trimId: "trim_3bad6006-721a-4dd4-a218-091fa734a63e" },
];

/** The five lanes in the app's order. A lane carries its shortcut hint if and
 *  only if the document holds no regions for it. */
export const LANES: RecreationLane[] = [
	{ id: "annotation", hint: "Press A to add annotation", pills: [] },
	{ id: "speed", hint: "Press S to add speed", pills: [] },
	{ id: "trim", hint: null, pills: [{ lane: "trim", id: "trim_f52989cf-489c-47f5-a6c7-b95a7d71b399", label: "0:02.2", startSec: 0, endSec: 2.19, leftPct: 0, widthPct: 5.4705, origin: "agent" }, { lane: "trim", id: "trim_3bad6006-721a-4dd4-a218-091fa734a63e", label: "0:04.9", startSec: 35.12, endSec: 40.033, leftPct: 87.7276, widthPct: 12.2724, origin: "agent" }] },
	{ id: "zoom", hint: null, pills: [{ lane: "zoom", id: "zoom_403360f0-0784-4034-994a-a79eb4e5aa55", label: "1.80×", startSec: 4.2, endSec: 12.6, leftPct: 10.4913, widthPct: 20.9827, depth: 3, focusMode: "auto" }, { lane: "zoom", id: "zoom_2d7bd6ce-02e1-4f7d-ad63-03ada76859e3", label: "2.20×", startSec: 17.5, endSec: 24.5, leftPct: 43.7139, widthPct: 17.4856, depth: 4, focusMode: "manual" }, { lane: "zoom", id: "zoom_11caaa47-6be5-4afa-bf1d-f2e6650f2066", label: "1.80×", startSec: 33.112, endSec: 35.156, leftPct: 82.7118, widthPct: 5.1058, depth: 3, focusMode: "manual" }] },
	{ id: "cameraFullscreen", hint: "Press C to add a Full Camera segment", pills: [] },
];

/** Every pill on the floor, flattened. */
export const PILLS: RecreationPill[] = [
	{ lane: "trim", id: "trim_f52989cf-489c-47f5-a6c7-b95a7d71b399", label: "0:02.2", startSec: 0, endSec: 2.19, leftPct: 0, widthPct: 5.4705, origin: "agent" },
	{ lane: "trim", id: "trim_3bad6006-721a-4dd4-a218-091fa734a63e", label: "0:04.9", startSec: 35.12, endSec: 40.033, leftPct: 87.7276, widthPct: 12.2724, origin: "agent" },
	{ lane: "zoom", id: "zoom_403360f0-0784-4034-994a-a79eb4e5aa55", label: "1.80×", startSec: 4.2, endSec: 12.6, leftPct: 10.4913, widthPct: 20.9827, depth: 3, focusMode: "auto" },
	{ lane: "zoom", id: "zoom_2d7bd6ce-02e1-4f7d-ad63-03ada76859e3", label: "2.20×", startSec: 17.5, endSec: 24.5, leftPct: 43.7139, widthPct: 17.4856, depth: 4, focusMode: "manual" },
	{ lane: "zoom", id: "zoom_11caaa47-6be5-4afa-bf1d-f2e6650f2066", label: "1.80×", startSec: 33.112, endSec: 35.156, leftPct: 82.7118, widthPct: 5.1058, depth: 3, focusMode: "manual" },
];

/** The ruler, re-derived per breakpoint the way the app re-derives it per zoom. */
export const RULER = {
	minLabelGapPx: 76,
	minorPerMajor: 5,
	tickStepsSec: [
		0.05,
		0.1,
		0.25,
		0.5,
		1,
		2,
		5,
		10,
		15,
		30,
		60,
		120,
		300,
		600,
		900,
		1800,
		3600,
	],
	wideBreakpointPx: 3043,
	variants: [
		{
			worldPx: 1920,
			pxPerSec: 47.9604,
			stepSec: 2,
			minorSec: 0.4,
			minorPct: 0.999176,
			labels: [
	{ sec: 0, leftPct: 0, text: "0:00" },
	{ sec: 2, leftPct: 4.9959, text: "0:02" },
	{ sec: 4, leftPct: 9.9918, text: "0:04" },
	{ sec: 6, leftPct: 14.9876, text: "0:06" },
	{ sec: 8, leftPct: 19.9835, text: "0:08" },
	{ sec: 10, leftPct: 24.9794, text: "0:10" },
	{ sec: 12, leftPct: 29.9753, text: "0:12" },
	{ sec: 14, leftPct: 34.9711, text: "0:14" },
	{ sec: 16, leftPct: 39.967, text: "0:16" },
	{ sec: 18, leftPct: 44.9629, text: "0:18" },
	{ sec: 20, leftPct: 49.9588, text: "0:20" },
	{ sec: 22, leftPct: 54.9547, text: "0:22" },
	{ sec: 24, leftPct: 59.9505, text: "0:24" },
	{ sec: 26, leftPct: 64.9464, text: "0:26" },
	{ sec: 28, leftPct: 69.9423, text: "0:28" },
	{ sec: 30, leftPct: 74.9382, text: "0:30" },
	{ sec: 32, leftPct: 79.9341, text: "0:32" },
	{ sec: 34, leftPct: 84.9299, text: "0:34" },
	{ sec: 36, leftPct: 89.9258, text: "0:36" },
	{ sec: 38, leftPct: 94.9217, text: "0:38" },
	{ sec: 40, leftPct: 99.9176, text: "0:40" },
],
		},
		{
			worldPx: 3440,
			pxPerSec: 85.9291,
			stepSec: 1,
			minorSec: 0.2,
			minorPct: 0.499588,
			labels: [
	{ sec: 0, leftPct: 0, text: "0:00" },
	{ sec: 1, leftPct: 2.4979, text: "0:01" },
	{ sec: 2, leftPct: 4.9959, text: "0:02" },
	{ sec: 3, leftPct: 7.4938, text: "0:03" },
	{ sec: 4, leftPct: 9.9918, text: "0:04" },
	{ sec: 5, leftPct: 12.4897, text: "0:05" },
	{ sec: 6, leftPct: 14.9876, text: "0:06" },
	{ sec: 7, leftPct: 17.4856, text: "0:07" },
	{ sec: 8, leftPct: 19.9835, text: "0:08" },
	{ sec: 9, leftPct: 22.4815, text: "0:09" },
	{ sec: 10, leftPct: 24.9794, text: "0:10" },
	{ sec: 11, leftPct: 27.4773, text: "0:11" },
	{ sec: 12, leftPct: 29.9753, text: "0:12" },
	{ sec: 13, leftPct: 32.4732, text: "0:13" },
	{ sec: 14, leftPct: 34.9711, text: "0:14" },
	{ sec: 15, leftPct: 37.4691, text: "0:15" },
	{ sec: 16, leftPct: 39.967, text: "0:16" },
	{ sec: 17, leftPct: 42.465, text: "0:17" },
	{ sec: 18, leftPct: 44.9629, text: "0:18" },
	{ sec: 19, leftPct: 47.4608, text: "0:19" },
	{ sec: 20, leftPct: 49.9588, text: "0:20" },
	{ sec: 21, leftPct: 52.4567, text: "0:21" },
	{ sec: 22, leftPct: 54.9547, text: "0:22" },
	{ sec: 23, leftPct: 57.4526, text: "0:23" },
	{ sec: 24, leftPct: 59.9505, text: "0:24" },
	{ sec: 25, leftPct: 62.4485, text: "0:25" },
	{ sec: 26, leftPct: 64.9464, text: "0:26" },
	{ sec: 27, leftPct: 67.4444, text: "0:27" },
	{ sec: 28, leftPct: 69.9423, text: "0:28" },
	{ sec: 29, leftPct: 72.4402, text: "0:29" },
	{ sec: 30, leftPct: 74.9382, text: "0:30" },
	{ sec: 31, leftPct: 77.4361, text: "0:31" },
	{ sec: 32, leftPct: 79.9341, text: "0:32" },
	{ sec: 33, leftPct: 82.432, text: "0:33" },
	{ sec: 34, leftPct: 84.9299, text: "0:34" },
	{ sec: 35, leftPct: 87.4279, text: "0:35" },
	{ sec: 36, leftPct: 89.9258, text: "0:36" },
	{ sec: 37, leftPct: 92.4238, text: "0:37" },
	{ sec: 38, leftPct: 94.9217, text: "0:38" },
	{ sec: 39, leftPct: 97.4196, text: "0:39" },
	{ sec: 40, leftPct: 99.9176, text: "0:40" },
],
		},
	],
} as const;

/** 320 bars in five opacity buckets, five paths. */
export const WAVEFORM = {
	viewBox: "0 0 320 100",
	barCount: 320,
	strokeWidthPx: 2,
	gapPx: 1,
	note: "preserveAspectRatio=none; stroke-width 2 with vector-effect:non-scaling-stroke reproduces .tlWave span {max-width:2px}",
	paths: [
		{
			opacity: 0.5,
			bars: 100,
			d: "M0.5 46V54M1.5 46V54M2.5 46V54M3.5 46V54M4.5 46V54M5.5 46V54M6.5 46V54M7.5 46V54M8.5 46V54M9.5 46V54M10.5 46V54M11.5 46V54M12.5 46V54M13.5 46V54M14.5 46V54M15.5 46V54M19.5 46V54M20.5 46V54M38.5 46V54M39.5 46V54M53.5 46V54M54.5 46V54M67.5 46V54M73.5 42.5V57.5M74.5 46V54M81.5 44V56M82.5 46V54M98.5 46V54M99.5 46V54M100.5 43V57M107.5 44.5V55.5M108.5 46V54M131.5 44V56M132.5 46V54M147.5 41.5V58.5M148.5 46V54M149.5 46V54M158.5 45V55M159.5 46V54M177.5 43.5V56.5M182.5 46V54M183.5 46V54M198.5 46V54M206.5 46V54M207.5 46V54M214.5 46V54M215.5 46V54M216.5 46V54M221.5 43.5V56.5M222.5 46V54M226.5 46V54M229.5 42.5V57.5M230.5 46V54M231.5 46V54M249.5 46V54M250.5 46V54M258.5 46V54M259.5 46V54M270.5 46V54M271.5 46V54M280.5 41.5V58.5M281.5 46V54M282.5 46V54M283.5 46V54M284.5 46V54M285.5 46V54M286.5 46V54M287.5 46V54M288.5 46V54M289.5 46V54M290.5 46V54M291.5 46V54M292.5 46V54M293.5 46V54M294.5 46V54M295.5 46V54M296.5 46V54M297.5 46V54M298.5 46V54M299.5 46V54M300.5 46V54M301.5 46V54M302.5 46V54M303.5 46V54M304.5 46V54M305.5 46V54M306.5 46V54M307.5 46V54M308.5 46V54M309.5 46V54M310.5 46V54M311.5 46V54M312.5 46V54M313.5 46V54M314.5 46V54M315.5 46V54M316.5 46V54M317.5 46V54M318.5 46V54M319.5 46V54",
		},
		{
			opacity: 0.6,
			bars: 153,
			d: "M16.5 33V67M18.5 31V69M21.5 34V66M22.5 34.5V65.5M24.5 33V67M25.5 31.5V68.5M29.5 33.5V66.5M30.5 32V68M31.5 32V68M33.5 34V66M34.5 34V66M35.5 34.5V65.5M37.5 37V63M40.5 30.5V69.5M41.5 35V65M42.5 32V68M43.5 33V67M44.5 37V63M45.5 33V67M48.5 31V69M49.5 35.5V64.5M51.5 30.5V69.5M52.5 35V65M55.5 33V67M56.5 33.5V66.5M57.5 31V69M58.5 32V68M60.5 35.5V64.5M61.5 33.5V66.5M62.5 31.5V68.5M63.5 34V66M66.5 40V60M70.5 30.5V69.5M72.5 31V69M75.5 36.5V63.5M77.5 36V64M80.5 31.5V68.5M83.5 34.5V65.5M84.5 32V68M85.5 33.5V66.5M86.5 33V67M87.5 34V66M89.5 31.5V68.5M90.5 33.5V66.5M91.5 33V67M92.5 35.5V64.5M94.5 32.5V67.5M101.5 35V65M103.5 34V66M104.5 32.5V67.5M106.5 34.5V65.5M109.5 32V68M110.5 34V66M111.5 34V66M112.5 40V60M113.5 35V65M115.5 33.5V66.5M117.5 31V69M121.5 31V69M125.5 32V68M127.5 35V65M128.5 33.5V66.5M130.5 34V66M133.5 33.5V66.5M134.5 33V67M135.5 32.5V67.5M136.5 33V67M137.5 40V60M138.5 31.5V68.5M139.5 36V64M141.5 32V68M142.5 31V69M143.5 32.5V67.5M144.5 31V69M145.5 34V66M146.5 33.5V66.5M154.5 37.5V62.5M155.5 32V68M156.5 32.5V67.5M157.5 35.5V64.5M160.5 30.5V69.5M161.5 33V67M162.5 34V66M163.5 34V66M164.5 39.5V60.5M165.5 31V69M166.5 32V68M167.5 32.5V67.5M168.5 32V68M171.5 34.5V65.5M173.5 34V66M174.5 31.5V68.5M178.5 32.5V67.5M180.5 32.5V67.5M181.5 31.5V68.5M185.5 31V69M186.5 32V68M187.5 32.5V67.5M188.5 32V68M194.5 31.5V68.5M197.5 34V66M199.5 34V66M200.5 32V68M201.5 33.5V66.5M202.5 31.5V68.5M205.5 31V69M208.5 33V67M209.5 32V68M210.5 33V67M211.5 33.5V66.5M212.5 34V66M213.5 35.5V64.5M217.5 32V68M218.5 31V69M219.5 35.5V64.5M220.5 32.5V67.5M223.5 34V66M224.5 32.5V67.5M225.5 33V67M227.5 31V69M228.5 32V68M232.5 31.5V68.5M233.5 31.5V68.5M234.5 33V67M237.5 35.5V64.5M238.5 33V67M239.5 40.5V59.5M240.5 31V69M241.5 34V66M242.5 31.5V68.5M243.5 34V66M244.5 32V68M245.5 31V69M246.5 33.5V66.5M247.5 32.5V67.5M248.5 31.5V68.5M251.5 32.5V67.5M252.5 32V68M253.5 33.5V66.5M254.5 32.5V67.5M255.5 39V61M260.5 32V68M261.5 31V69M262.5 33.5V66.5M263.5 32.5V67.5M264.5 31V69M266.5 35.5V64.5M269.5 34.5V65.5M274.5 33V67M276.5 34V66M277.5 32.5V67.5M278.5 31V69M279.5 31V69",
		},
		{
			opacity: 0.7,
			bars: 67,
			d: "M17.5 26V74M23.5 27V73M26.5 30.5V69.5M27.5 27V73M28.5 26.5V73.5M32.5 28.5V71.5M36.5 28V72M46.5 29.5V70.5M47.5 29.5V70.5M50.5 27.5V72.5M59.5 29V71M64.5 27.5V72.5M65.5 30V70M68.5 28V72M69.5 29.5V70.5M71.5 30V70M76.5 28V72M78.5 28V72M79.5 30V70M88.5 28V72M93.5 28V72M95.5 30V70M96.5 29.5V70.5M97.5 29.5V70.5M102.5 30V70M105.5 30.5V69.5M114.5 27.5V72.5M116.5 26V74M118.5 29V71M119.5 29V71M120.5 28V72M122.5 29V71M123.5 30V70M124.5 30V70M126.5 30V70M129.5 30V70M140.5 29.5V70.5M150.5 28V72M151.5 29V71M152.5 28.5V71.5M153.5 30.5V69.5M169.5 29.5V70.5M170.5 29V71M172.5 29.5V70.5M175.5 30V70M176.5 29V71M179.5 29V71M184.5 30V70M189.5 29.5V70.5M190.5 30V70M191.5 30V70M192.5 30V70M193.5 30V70M195.5 28.5V71.5M196.5 28.5V71.5M203.5 29.5V70.5M204.5 27.5V72.5M235.5 29V71M236.5 30.5V69.5M256.5 27.5V72.5M257.5 30.5V69.5M265.5 29V71M267.5 30V70M268.5 28.5V71.5M272.5 30.5V69.5M273.5 28.5V71.5M275.5 28V72",
		},
		{
			opacity: 0.8,
			bars: 0,
			d: "",
		},
		{
			opacity: 0.9,
			bars: 0,
			d: "",
		},
	],
} as const;

/** The conversation. */
export const CHAT = {
	conversationTitle: "Conversation 1",
	emptyState: "No messages yet. Ask the agent to cut silences, tighten pauses, or add captions.",
	authorUser: "You",
	authorAssistant: "OpenScreen",
	userPrompt: "Cut the dead time in this recording: long pauses, silences, and idle stretches where nothing is being said or done. Keep the pacing tight and natural, and do not cut anything a viewer needs. Apply the edits directly to the timeline.",
	agentReply: [
		{
			kind: "p",
			runs: [
				{
					text: "Here's what I found and cut:",
					strong: false,
				},
			],
		},
		{
			kind: "p",
			runs: [
				{
					text: "Finding:",
					strong: true,
				},
				{
					text: " The speech itself is nearly gapless — every pause between spoken words is well under a second, so there were no internal silences to remove. The only silences over 1s were at the two ends:",
					strong: false,
				},
			],
		},
		{
			kind: "p",
			runs: [
				{
					text: "Cuts applied (both on your single placed clip, which is untouched otherwise):",
					strong: true,
				},
			],
		},
		{
			kind: "li",
			runs: [
				{
					text: "0–2.19s",
					strong: true,
				},
				{
					text: " — the 2.2s dead lead-in before \"Hi,\" (cut)",
					strong: false,
				},
			],
		},
		{
			kind: "li",
			runs: [
				{
					text: "35.12–40.03s",
					strong: true,
				},
				{
					text: " — the ~4.9s dead tail after \"think.\" (cut)",
					strong: false,
				},
			],
		},
		{
			kind: "p",
			runs: [
				{
					text: "The video now runs from \"Hi,\" straight through to \"think.\" — about ",
					strong: false,
				},
				{
					text: "7 seconds shorter",
					strong: true,
				},
				{
					text: " (40.0s → 33.0s of playable footage).",
					strong: false,
				},
			],
		},
		{
			kind: "p",
			runs: [
				{
					text: "Your zooms (incl. the manual 1.8×/2.2× punches) stay anchored to the same moments in the narration.",
					strong: false,
				},
			],
		},
		{
			kind: "p",
			runs: [
				{
					text: "One note: the cut starts the video right at the first word with no lead-in. If you'd rather keep a half-second of breathing room before \"Hi,\" say the word and I'll restore a short lead.",
					strong: false,
				},
			],
		},
	],
	agentReplyText: "Here's what I found and cut:\n\n**Finding:** The speech itself is nearly gapless — every pause between spoken words is well under a second, so there were no internal silences to remove. The only silences over 1s were at the two ends:\n\n**Cuts applied (both on your single placed clip, which is untouched otherwise):**\n\n- **0–2.19s** — the 2.2s dead lead-in before \"Hi,\" (cut)\n- **35.12–40.03s** — the ~4.9s dead tail after \"think.\" (cut)\n\nThe video now runs from \"Hi,\" straight through to \"think.\" — about **7 seconds shorter** (40.0s → 33.0s of playable footage).\n\nYour zooms (incl. the manual 1.8×/2.2× punches) stay anchored to the same moments in the narration.\n\nOne note: the cut starts the video right at the first word with no lead-in. If you'd rather keep a half-second of breathing room before \"Hi,\" say the word and I'll restore a short lead.",
	applied: "applied: added 2 trims",
	composerPlaceholder: "Describe the edit you want.",
	modelChip: "deepseek-v4-flash",
} as const;

/** The preview frame's geometry, and the loop that plays inside it. */
export const STAGE = {
	aspectRatio: "16:9",
	wallpaper: "/wallpapers/wallpaper5.jpg",
	padding: 55,
	paddingFit: 0.78,
	borderRadius: 40,
	frame: {
		width: 1071,
		height: 603,
	},
	contentBox: {
		width: 835,
		height: 470,
	},
	screen: {
		width: 835,
		height: 470,
	},
	webcam: null,
	webcamReason: "assets[0].cameraTrack.visible is false and legacyEditor.webcamLayoutPreset is \"no-webcam\" — there is no bubble to draw",
} as const;
export const LOOP = {
	startSec: 17.5,
	contentEndSec: 24.3,
	contentDurationSec: 6.8,
	durationSec: 7,
	dissolveSec: 0.6,
	holdSec: 0.2,
	zoomScale: 2.2,
	crop: {
		w: 872,
		h: 490,
		x: 524,
		y: 295,
	},
	src: "/video/canvas-loop.mp4",
	srcSmall: "/video/canvas-loop-sm.mp4",
	poster: "/img/walkthrough/canvas-poster.jpg",
	width: 836,
	height: 470,
	widthSmall: 640,
	heightSmall: 360,
	timeMapping: "startSec + min(currentTime, contentDurationSec)",
} as const;

/** The three facet panels the scroll opens before the transcript, with every
 *  control's label as the app's locale files spell it. */
export const PANELS = {
	background: {
		title: "Background",
		tabs: [
			"Image",
			"Color",
			"Gradient",
		],
		uploadCustom: "Upload Custom",
		wallpaperCount: 18,
		swatchLabels: [
			"Background 1",
			"Background 2",
			"Background 3",
			"Background 4",
			"Background 5",
			"Background 6",
			"Background 7",
			"Background 8",
			"Background 9",
			"Background 10",
			"Background 11",
			"Background 12",
			"Background 13",
			"Background 14",
			"Background 15",
			"Background 16",
			"Background 17",
			"Background 18",
		],
	},
	effects: {
		title: "Video Effects",
		padding: "Padding",
		blurBg: "Blur BG",
		motionBlur: "Motion Blur",
		shadow: "Shadow",
		roundness: "Roundness",
	},
	cursor: {
		title: "Cursor",
		show: "Show Cursor",
		clipToBounds: "Clip to Canvas",
		theme: "Cursor Style",
		size: "Size",
		smoothing: "Smoothing",
	},
} as const;

/** The padding formula's coefficients, so the slider moves the composite by the
 *  app's own arithmetic rather than by a number that looks about right. */
export const EFFECTS = {
	paddingDefault: 55,
	borderRadiusDefault: 40,
	paddingFitFactor: 0.4,
	paddingFitMin: 0.4,
} as const;

/** Every slider and toggle on those panels, at this document's settings, scaled
 *  and suffixed the way RightPanes.tsx scales and suffixes it. */
export const CONTROLS = {
	padding: {
		label: "Padding",
		value: 55,
		min: 0,
		max: 100,
		suffix: "%",
		display: "55%",
	},
	blurBg: {
		label: "Blur BG",
		on: true,
	},
	motionBlur: {
		label: "Motion Blur",
		value: 30,
		min: 0,
		max: 100,
		suffix: "%",
		display: "30%",
	},
	shadow: {
		label: "Shadow",
		value: 35,
		min: 0,
		max: 100,
		suffix: "%",
		display: "35%",
	},
	roundness: {
		label: "Roundness",
		value: 40,
		min: 0,
		max: 64,
		suffix: "px",
		display: "40px",
	},
	cursorShow: {
		label: "Show Cursor",
		on: true,
	},
	clipToBounds: {
		label: "Clip to Canvas",
		on: false,
	},
	cursorTheme: {
		label: "Cursor Style",
		value: "default",
	},
	cursorSize: {
		label: "Size",
		value: 45,
		min: 5,
		max: 100,
		suffix: "",
		display: "45.0",
	},
	smoothing: {
		label: "Smoothing",
		value: 35,
		min: 0,
		max: 100,
		suffix: "%",
		display: "35%",
	},
} as const;

/** The cursor packs the picker shows, each with the application's own hotspot,
 *  normalised to a fraction of the sprite. */
export const CURSORS = {
	themeCount: 18,
	themes: [
		{
			id: "default",
			name: "Default",
			hotspotX: 0.119,
			hotspotY: 0.0874,
			src: "/img/cursors/00-arrow.png",
		},
		{
			id: "pink-glossy-arrow-and-hand-3d",
			name: "Pink Glossy Arrow & Hand 3D",
			hotspotX: 0.0469,
			hotspotY: 0.0469,
			src: "/img/cursors/01-arrow.png",
		},
		{
			id: "spring-gradient",
			name: "Spring Gradient",
			hotspotX: 0.0469,
			hotspotY: 0.0156,
			src: "/img/cursors/02-arrow.png",
		},
		{
			id: "black-and-rainbow-stroke-gradient-animated",
			name: "Black & Rainbow Stroke Gradient Animated",
			hotspotX: 0.05,
			hotspotY: 0.03,
			src: "/img/cursors/03-arrow.png",
		},
		{
			id: "among-us-sus-knife-and-red-animated",
			name: "Among Us Sus Knife & Red Animated",
			hotspotX: 0.1531,
			hotspotY: 0.1016,
			src: "/img/cursors/04-arrow.png",
		},
		{
			id: "hollow-knight-and-game-arrow",
			name: "Hollow Knight & Game Arrow",
			hotspotX: 0.0156,
			hotspotY: 0.0156,
			src: "/img/cursors/05-arrow.png",
		},
		{
			id: "mickey-mouse-black-hand-inflated-glove",
			name: "Mickey Mouse Black Hand Inflated Glove",
			hotspotX: 0.0781,
			hotspotY: 0.0156,
			src: "/img/cursors/06-arrow.png",
		},
		{
			id: "sanrio-kuromi-skull-arrow",
			name: "Sanrio Kuromi Skull Arrow",
			hotspotX: 0.0469,
			hotspotY: 0.0156,
			src: "/img/cursors/07-arrow.png",
		},
		{
			id: "old-roblox",
			name: "Old Roblox",
			hotspotX: 0.0781,
			hotspotY: 0.0469,
			src: "/img/cursors/08-arrow.png",
		},
		{
			id: "pokemon-neon-gengar",
			name: "Pokemon Neon Gengar",
			hotspotX: 0.0313,
			hotspotY: 0.0156,
			src: "/img/cursors/09-arrow.png",
		},
	],
	pointer: {
		name: "Default",
		hotspotX: 0.3893,
		hotspotY: 0.0032,
		src: "/img/cursors/mac-pointer.png",
	},
	text: {
		name: "Default",
		hotspotX: 0.4375,
		hotspotY: 0.5333,
		src: "/img/cursors/mac-text.png",
	},
} as const;

export const TRANSPORT = {
	restCurrent: "0:17.5",
	endCurrent: "0:24.3",
	total: "0:40.0",
	restLeftPct: 43.7139,
	endLeftPct: 60.6999,
} as const;
export const TOOLBAR = {
	aspectRatio: "16:9",
	panKbd: "Shift+Scroll",
	panLabel: "Pan",
	zoomKbd: "Ctrl+Scroll",
	zoomLabel: "Zoom",
	clipLabel: "Bellrock — docs walkthrough",
} as const;

/** The app's dark tokens, read out of design-tokens.css. */
export const TOKENS = {
	surface: "#14181f",
	surface1: "#14181f",
	surface2: "#1c2029",
	surface3: "#252a35",
	border: "#252a35",
	borderHi: "#3a4150",
	fg: "#e6e9ef",
	fg2: "#f3f5f8",
	muted: "#8b95a3",
	meta: "#8b95a3",
	metaInApp: "#5b6470",
	accent: "#10b981",
	danger: "#f87171",
	playhead: "#6c55ff",
} as const;

/** One entry per string on screen. */
export const PROVENANCE: ProvenanceEntry[] = [
	{ shown: "Current transcription", source: "src/i18n/locales/en/settings.json → transcript.title" },
	{ shown: "Clip 1 · 0:00.0—0:40.0", source: "computed: settings.json transcript.clipLabel with index 1, joined to formatMs(0) and formatMs(40033) from src/lib/ai-edition/timeline/format.ts" },
	{ shown: "Bellrock — docs walkthrough", source: "fixture assets[0].label" },
	{ shown: "[silence 2.2s]", source: "computed: settings.json transcript.silence over the 2.190s gap 0–2.19 that buildClipSection inserted at SILENCE_THRESHOLD_SEC 0.2; inside trimRange trim_f52989cf-489c-47f5-a6c7-b95a7d71b399" },
	{ shown: "[silence 0.2s]", source: "computed: settings.json transcript.silence over the 0.230s gap 27.09–27.32 that buildClipSection inserted at SILENCE_THRESHOLD_SEC 0.2; outside any trim" },
	{ shown: "[silence 4.9s]", source: "computed: settings.json transcript.silence over the 4.913s gap 35.12–40.033 that buildClipSection inserted at SILENCE_THRESHOLD_SEC 0.2; inside trimRange trim_3bad6006-721a-4dd4-a218-091fa734a63e" },
	{ shown: "Hi, quick walk through the documentation site. The new release went out this morning. The hero does the work now. One line, one promise, and the install command right under it. Scrolling down, those six cards are the whole library on one screen. No page gets more than a sentence. Over on status, every component with 30 days of probes behind it. One amber day on the validator, and it recovered, and releases. Three of them, newest first, and every line links into the commit that did it. Back to the top, and that is the whole flow. Tell me what you think.", source: "fixture transcript.words, rejoined in start order; every entry is rendered as its own span" },
	{ shown: "Conversation 1", source: "computed: editor.json chat.untitledConversation + the session index, as LeftPanel.tsx:1184 renders it" },
	{ shown: "No messages yet. Ask the agent to cut silences, tighten pauses, or add captions.", source: "editor.json chat.emptyState" },
	{ shown: "You", source: "editor.json chat.authorUser" },
	{ shown: "OpenScreen", source: "editor.json chat.authorAssistant" },
	{ shown: "Cut the dead time in this recording: long pauses, silences, and idle stretches where nothing is being said or done. Keep the pacing tight and natural, and do not cut anything a viewer needs. Apply the edits directly to the timeline.", source: "src/components/ai-edition/v4/V4Timeline.tsx AI_ENHANCE_PROMPT, lifted verbatim as source text" },
	{ shown: "Here's what I found and cut:\n\n**Finding:** The speech itself is nearly gapless — every pause between spoken words is well under a second, so there were no internal silences to remove. The only silences over 1s were at the two ends:\n\n**Cuts applied (both on your single placed clip, which is untouched otherwise):**\n\n- **0–2.19s** — the 2.2s dead lead-in before \"Hi,\" (cut)\n- **35.12–40.03s** — the ~4.9s dead tail after \"think.\" (cut)\n\nThe video now runs from \"Hi,\" straight through to \"think.\" — about **7 seconds shorter** (40.0s → 33.0s of playable footage).\n\nYour zooms (incl. the manual 1.8×/2.2× punches) stay anchored to the same moments in the narration.\n\nOne note: the cut starts the video right at the first word with no lead-in. If you'd rather keep a half-second of breathing room before \"Hi,\" say the word and I'll restore a short lead.", source: "photograph: static/img/walkthrough/04-agent-a.jpg — hand-transcribed; the conversation is in no store on disk and this photograph is its only existence. THE WEAKEST PROVENANCE ON THE PAGE. Every timecode, duration, quoted word and cut total in it is regenerated from timeline.trimRanges and transcript.words, not transcribed. Two figures are transcribed as the model wrote them and disagree with this file's arithmetic on purpose: \"33.0s\" (recomputed: 32.93s) and \"1.8×/2.2×\" (the pills read 1.80×/2.20×). The page is quoting a message, not drawing a readout." },
	{ shown: "applied: added 2 trims", source: "computed: editor.json chat.appliedPrefix + the bulk-add tool's own wording (electron/ai-edition/agent-tools.ts: added ${n} ${noun}s) with n = 2, the trimRanges whose origin is \"agent\"" },
	{ shown: "Describe the edit you want.", source: "editor.json chat.composerPlaceholder" },
	{ shown: "deepseek-v4-flash", source: "photograph: static/img/walkthrough/editor-1560.jpg — what was on screen when the plate was shot. NOT in provider-registry.ts; it was typed into an OpenAI-compatible provider config. The one visible string whose referent cannot be verified in the source, kept because the photographs beside it already ship it." },
	{ shown: "1.80×", source: "computed: effectiveZoomScale(zoomRanges depth 3).toFixed(2) + \"×\" from src/lib/ai-edition/timeline/zoom-scale.ts" },
	{ shown: "2.20×", source: "computed: effectiveZoomScale(zoomRanges depth 4).toFixed(2) + \"×\" from src/lib/ai-edition/timeline/zoom-scale.ts" },
	{ shown: "1.80×", source: "computed: effectiveZoomScale(zoomRanges depth 3).toFixed(2) + \"×\" from src/lib/ai-edition/timeline/zoom-scale.ts" },
	{ shown: "0:02.2", source: "computed: formatSec(2.19 − 0) over trimRange trim_f52989cf-489c-47f5-a6c7-b95a7d71b399" },
	{ shown: "0:04.9", source: "computed: formatSec(40.033 − 35.12) over trimRange trim_3bad6006-721a-4dd4-a218-091fa734a63e" },
	{ shown: "Press A to add annotation", source: "timeline.json hints.pressAnnotation — rendered because the document holds no annotation regions" },
	{ shown: "Press S to add speed", source: "timeline.json hints.pressSpeed — rendered because the document holds no speed regions" },
	{ shown: "Press C to add a Full Camera segment", source: "timeline.json hints.pressCameraFullscreen — rendered because the document holds no cameraFullscreen regions" },
	{ shown: "0:00 0:02 0:04 0:06 0:08 0:10 0:12 0:14 0:16 0:18 0:20 0:22 0:24 0:26 0:28 0:30 0:32 0:34 0:36 0:38 0:40", source: "computed: fmtTick lifted from V4Timeline.tsx over a 2s step, itself derived as the first TICK_STEPS_SEC entry clearing MIN_LABEL_GAP_PX 76 at 47.9604 px/s" },
	{ shown: "0:40.0", source: "computed: formatSec(assets[0].durationSec = 40.033)" },
	{ shown: "0:17.5", source: "computed: formatSec(zoomRanges[1].sourceStartSec = 17.5) — where the loop starts" },
	{ shown: "16:9", source: "fixture legacyEditor.aspectRatio" },
	{ shown: "Shift+Scroll Pan", source: "computed: timeline.json labels.pan, with the key hint V4Timeline.tsx:1474 writes beside it" },
	{ shown: "Ctrl+Scroll Zoom", source: "computed: timeline.json labels.zoom, with the key hint V4Timeline.tsx:1477 writes beside it" },
	{ shown: "Bellrock — docs walkthrough", source: "fixture assets[0].label, as the clip card's own label" },
	{ shown: "Background", source: "src/i18n/locales/en/settings.json → background.title" },
	{ shown: "Image", source: "src/i18n/locales/en/settings.json → background.image" },
	{ shown: "Color", source: "src/i18n/locales/en/settings.json → background.color" },
	{ shown: "Gradient", source: "src/i18n/locales/en/settings.json → background.gradient" },
	{ shown: "Upload Custom", source: "src/i18n/locales/en/settings.json → background.uploadCustom" },
	{ shown: "Background 1", source: "computed: settings.json background.imageLabel over the 18 wallpapers WALLPAPER_COUNT declares in src/lib/wallpaper.ts" },
	{ shown: "Video Effects", source: "src/i18n/locales/en/settings.json → effects.title" },
	{ shown: "Padding", source: "src/i18n/locales/en/settings.json → effects.padding" },
	{ shown: "Blur BG", source: "src/i18n/locales/en/settings.json → effects.blurBg" },
	{ shown: "Motion Blur", source: "src/i18n/locales/en/settings.json → effects.motionBlur" },
	{ shown: "Shadow", source: "src/i18n/locales/en/settings.json → effects.shadow" },
	{ shown: "Roundness", source: "src/i18n/locales/en/settings.json → effects.roundness" },
	{ shown: "Cursor", source: "src/i18n/locales/en/settings.json → cursor.title" },
	{ shown: "Show Cursor", source: "src/i18n/locales/en/settings.json → cursor.show" },
	{ shown: "Clip to Canvas", source: "src/i18n/locales/en/settings.json → cursor.clipToBounds" },
	{ shown: "Cursor Style", source: "src/i18n/locales/en/settings.json → cursor.theme" },
	{ shown: "Size", source: "src/i18n/locales/en/settings.json → cursor.size" },
	{ shown: "Smoothing", source: "src/i18n/locales/en/settings.json → cursor.smoothing" },
];

/** What check-recreation.mjs asserts against. */
export const MARKUP = {
	pills: PILLS,
	hints: LANES.filter((lane) => lane.hint !== null).map((lane) => lane.id),
	words: WORDS,
	contrastPairs: [
	[
		"#e6e9ef",
		"#14181f",
		"transcript word on the inspector",
	],
	[
		"#8b95a3",
		"#14181f",
		"clip range on the inspector",
	],
	[
		"#8b95a3",
		"#14181f",
		"lane hint on the floor",
	],
	[
		"#8b95a3",
		"#14181f",
		"ruler label on the floor",
	],
	[
		"#10b981",
		"#14181f",
		"zoom pill label",
	],
	[
		"#f87171",
		"#14181f",
		"trim pill label and struck silence",
	],
	[
		"#e6e9ef",
		"#1c2029",
		"chat message body",
	],
	[
		"#8b95a3",
		"#14181f",
		"chat author label",
	],
	[
		"#10b981",
		"#14181f",
		"applied line",
	],
	[
		"#8b95a3",
		"#14181f",
		"composer placeholder",
	],
] as [string, string, string][],
} as const;
