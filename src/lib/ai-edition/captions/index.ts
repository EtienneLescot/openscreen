export type { CaptionCue, CaptionTextRegion } from "./cues";
export {
	CAPTION_Z_INDEX_BASE,
	captionCueAt,
	captionCuesToTextRegions,
	captionLinesForAsset,
	deriveCaptionCues,
	sourceSpanToTimelineSpans,
} from "./cues";
export type {
	CaptionBandRect,
	CaptionHorizontalPosition,
	CaptionOffsetRange,
	CaptionSettings,
	CaptionSettingsPatch,
	CaptionTextAlign,
	CaptionVerticalPosition,
} from "./settings";
export {
	activeHorizontalPositionPreset,
	activeVerticalPositionPreset,
	CAPTION_BAND_HEIGHT_PCT,
	CAPTION_EDGE_MARGIN_PCT,
	CAPTION_POSITION_PRESET_EPSILON,
	captionBackgroundCss,
	captionBandRect,
	captionHorizontalPositionOffset,
	captionInkHeightPct,
	captionOffsetRange,
	DEFAULT_CAPTION_SETTINGS,
	getCaptionSettings,
	patchCaptionSettings,
} from "./settings";
export type {
	CaptionTranslation,
	CaptionTranslations,
	CaptionTranslationUnit,
} from "./translations";
export {
	captionTranslationUnits,
	getCaptionTranslations,
	putCaptionTranslation,
	removeCaptionTranslation,
	translationCoverage,
	untranslatedUnits,
} from "./translations";
