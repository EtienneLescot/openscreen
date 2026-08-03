// CLI-only: the v4 editor renders captions natively, but `openscreen captions`
// still writes caption *annotations* into .openscreen projects. Only the
// annotation conversion lives here — the segment grouping/dedupe helpers come
// from the live captioning module so the CLI can't drift from the editor.

import type { AnnotationRegion, AnnotationTextStyle } from "@/components/video-editor/types";
import {
	type CaptionSegmentLayoutOptions,
	dedupeAdjacentCaptionRepeats,
	finalizeCaptionSegmentsForPlayback,
	groupPhraseCaptionSegmentsIntoLines,
	groupTimedCaptionWordsIntoLines,
} from "@/lib/captioning/annotationsFromCaptions";
import type { CaptionSegment } from "@/lib/captioning/transcribe";

/** Wide lower-third bar; `position.x` is top-left as % of container, so center with (100 - width) / 2. */
const CAPTION_WIDTH = 92;
const CAPTION_HEIGHT = 12;
const CAPTION_BOTTOM_MARGIN = 2;

const CAPTION_POSITION = {
	x: (100 - CAPTION_WIDTH) / 2,
	y: 100 - CAPTION_HEIGHT - CAPTION_BOTTOM_MARGIN,
};

const CAPTION_SIZE = { width: CAPTION_WIDTH, height: CAPTION_HEIGHT };

const CAPTION_STYLE: AnnotationTextStyle = {
	color: "#ffffff",
	backgroundColor: "rgba(255, 255, 255, 0)",
	fontSize: 24,
	fontFamily: "Inter",
	fontWeight: "normal",
	fontStyle: "normal",
	textDecoration: "none",
	textAlign: "center",
};

export function captionSegmentsToAnnotationRegions(
	segments: CaptionSegment[],
	startNumericId: number,
	startZIndex: number,
	layout?: CaptionSegmentLayoutOptions,
): AnnotationRegion[] {
	// Don't echo-collapse raw word tokens before grouping: repeated words ("I … I") share a
	// normalized key and would merge spans while keeping only the first token's text.
	const minW = layout?.minWordsPerCaption ?? 2;
	const maxW = layout?.maxWordsPerCaption ?? 7;
	const granularity = layout?.timestampGranularity ?? "word";

	const grouped =
		granularity === "phrase"
			? groupPhraseCaptionSegmentsIntoLines(segments, minW, maxW)
			: groupTimedCaptionWordsIntoLines(segments, minW, maxW);

	const finalized = finalizeCaptionSegmentsForPlayback(dedupeAdjacentCaptionRepeats(grouped));

	let nid = startNumericId;
	let z = startZIndex;
	return finalized.map((seg) => {
		const startMs = Math.round(seg.startSec * 1000);
		const endMs = Math.max(Math.round(seg.endSec * 1000), startMs + 1);
		return {
			id: `annotation-${nid++}`,
			startMs,
			endMs,
			type: "text",
			content: seg.text,
			annotationSource: "auto-caption",
			position: { ...CAPTION_POSITION },
			size: { ...CAPTION_SIZE },
			style: { ...CAPTION_STYLE },
			zIndex: z++,
		};
	});
}
