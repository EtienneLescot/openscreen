// The caption guide: the anchor line the user is actually setting, plus the edges of
// the column captions wrap in. Shown only while the Captions pane is open.
//
// Why it exists: the pane's controls are all edge-referenced now, but two of those
// edges (the column's) are derived from the output aspect rather than chosen, so
// "why does Left stop there?" has no answer on screen without this. The anchor line
// is the stronger reason — it IS the invariant the distance slider sets, and watching
// it hold still while a caption grows is the fastest way to understand the model.
//
// This is NOT a second caption painter. `CaptionLayer.tsx` was deleted because it
// drew the same TEXT through a second wrapping engine and the two disagreed on line
// breaks; a rule and two hairlines have no glyphs to disagree about. The precedent is
// `AnnotationOverlay` — the DOM painter went, the selection chrome stayed. A <div>
// also has no route into `buildSceneDescription`, so it cannot reach an export.

import { useMemo } from "react";
import { captionBoxRect, getCaptionSettings } from "@/lib/ai-edition/captions";
import { resolveAspectRatioValue } from "@/lib/ai-edition/document/outputFormat";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useCaptionGuideBus } from "@/lib/ai-edition/store/useCaptionGuideBus";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";

/**
 * Mounted as a direct child of `.previewFrame`, NOT of `.screenStage`.
 *
 * That is load-bearing: `.screenStage` is the screen rect, which shrinks as the
 * padding slider grows, while captions are measured against the output frame
 * (`space: "frame"`, issue #396). Drawing the guide on the screen rect would
 * reproduce that exact bug inside the guide meant to explain it. Inside
 * `.previewFrame`, frame-percent → CSS-percent is the identity, so there is no
 * letterbox arithmetic here and no second geometry to keep in sync.
 */
export function CaptionGuideOverlay() {
	const open = useCaptionGuideBus((s) => s.open);
	const document = useProjectStore((s) => s.document);
	const { settings: editorSettings } = useEditorSettings();

	const guide = useMemo(() => {
		if (!document) return null;
		const aspect = resolveAspectRatioValue(document, editorSettings.aspectRatio);
		const captions = getCaptionSettings(document, aspect);
		if (!captions.enabled) return null;
		const box = captionBoxRect(captions, aspect);
		return {
			// The edge the caption is pinned to — the one number the distance slider sets,
			// and the one that must not move when the text wraps.
			anchorPct: captions.anchorV === "bottom" ? 100 - captions.insetY : captions.insetY,
			leftPct: box.x,
			rightPct: box.x + box.width,
		};
	}, [document, editorSettings.aspectRatio]);

	if (!open || !guide) return null;

	return (
		<div
			aria-hidden="true"
			style={{
				position: "absolute",
				inset: 0,
				pointerEvents: "none",
				zIndex: 3,
			}}
		>
			{/* The column's edges, faint: they answer "why does Left stop there?" and
			    nothing else, so they must not compete with the anchor line. */}
			{[guide.leftPct, guide.rightPct].map((pct) => (
				<div
					key={pct}
					style={{
						position: "absolute",
						top: 0,
						bottom: 0,
						left: `${pct}%`,
						width: 1,
						background: "color-mix(in srgb, var(--accent) 35%, transparent)",
					}}
				/>
			))}
			{/* The anchor line. Deliberately the loudest thing here. */}
			<div
				style={{
					position: "absolute",
					left: `${guide.leftPct}%`,
					width: `${guide.rightPct - guide.leftPct}%`,
					top: `${guide.anchorPct}%`,
					height: 2,
					marginTop: -1,
					background: "var(--accent)",
					borderRadius: 1,
				}}
			/>
		</div>
	);
}
