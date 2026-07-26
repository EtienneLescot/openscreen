// The caption overlay in the preview.
//
// Deliberately NOT an `AnnotationOverlay`: a caption has no per-item identity to
// select, nothing to drag and nothing to resize — its placement comes from the
// caption settings, which the inspector owns. So this is a plain, pointer-events
// -none band, which also means it can never steal a click from an annotation
// sitting underneath it.
//
// It mirrors `annotationRenderer.renderText`'s box model (centred band, text
// vertically centred, per-line background plate, 1.4 line-height) so what the
// preview shows is what the export writes.

import { useMemo } from "react";
import { annotationFontSizePx } from "@/lib/ai-edition/annotationScale";
import {
	type CaptionCue,
	type CaptionSettings,
	captionBackgroundCss,
	captionBandRect,
	captionCueAt,
} from "@/lib/ai-edition/captions";

interface CaptionLayerProps {
	cues: CaptionCue[];
	settings: CaptionSettings;
	/** Playhead in virtual (timeline) seconds — the same clock the cues use. */
	currentTimeSec: number;
	containerWidth: number;
	containerHeight: number;
}

export function CaptionLayer({
	cues,
	settings,
	currentTimeSec,
	containerWidth,
	containerHeight,
}: CaptionLayerProps) {
	const currentTimeMs = Math.round(currentTimeSec * 1000);
	const cue = useMemo(() => captionCueAt(cues, currentTimeMs), [cues, currentTimeMs]);

	if (!settings.enabled || !cue || containerWidth <= 0 || containerHeight <= 0) return null;

	const rect = captionBandRect(settings);
	const background = captionBackgroundCss(settings);

	return (
		<div
			aria-hidden
			style={{
				position: "absolute",
				left: `${rect.x}%`,
				top: `${rect.y}%`,
				width: `${rect.width}%`,
				height: `${rect.height}%`,
				display: "flex",
				alignItems: "center",
				justifyContent:
					settings.textAlign === "left"
						? "flex-start"
						: settings.textAlign === "right"
							? "flex-end"
							: "center",
				overflow: "hidden",
				pointerEvents: "none",
				// Above every annotation, matching the export's z ordering.
				zIndex: 60,
			}}
		>
			<span
				style={{
					color: settings.color,
					backgroundColor: background,
					// Same rule as annotations (annotationScale.ts): the authored number is
					// pixels at a 1080-high frame, scaled by the box actually being drawn
					// into — so the preview is a scale model of the render instead of
					// showing one size on screen and another in the file.
					fontSize: `${annotationFontSizePx(settings.fontSize, containerHeight)}px`,
					fontFamily: settings.fontFamily,
					fontWeight: settings.fontWeight,
					textAlign: settings.textAlign,
					lineHeight: 1.4,
					// `clone` gives each wrapped line its own plate instead of one
					// ragged box around the whole paragraph — same as the exporter,
					// which draws the background per line.
					boxDecorationBreak: "clone",
					WebkitBoxDecorationBreak: "clone",
					padding: "0.1em 0.2em",
					borderRadius: 4,
					wordBreak: "break-word",
					whiteSpace: "pre-wrap",
				}}
			>
				{cue.text}
			</span>
		</div>
	);
}
