// Port of the annotation-rendering block inline in `VideoPlayback.tsx`
// (lines ~1988-2115 on main) as a standalone component. Main splits
// "annotation" and "blur" into two separate arrays/selection ids; the new
// editor's schema keeps all annotation types (including blur) in one
// `document.annotations[]` array, so this uses a single filtered+sorted
// list and a single selection id instead.

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { AnnotationOverlay } from "./AnnotationOverlay";

type BlurData = NonNullable<AxcutAnnotationRegion["blurData"]>;

interface AnnotationLayerProps {
	annotations: AxcutAnnotationRegion[];
	selectedAnnotationId: string | null;
	currentTimeSec: number;
	containerWidth: number;
	containerHeight: number;
	videoElement?: HTMLVideoElement | null;
	onSelectAnnotation: (id: string) => void;
	onPositionChange: (id: string, position: { x: number; y: number }) => void;
	onSizeChange: (id: string, size: { width: number; height: number }) => void;
	onBlurDataChange: (id: string, blurData: BlurData) => void;
	onCommit: () => void;
}

export function AnnotationLayer({
	annotations,
	selectedAnnotationId,
	currentTimeSec,
	containerWidth,
	containerHeight,
	videoElement,
	onSelectAnnotation,
	onPositionChange,
	onSizeChange,
	onBlurDataChange,
	onCommit,
}: AnnotationLayerProps) {
	const currentTimeMs = Math.round(currentTimeSec * 1000);

	const visible = annotations
		.filter((annotation) => {
			if (typeof annotation.startMs !== "number" || typeof annotation.endMs !== "number") {
				return false;
			}
			if (annotation.id === selectedAnnotationId) return true;
			return currentTimeMs >= annotation.startMs && currentTimeMs < annotation.endMs;
		})
		.sort((a, b) => a.zIndex - b.zIndex);

	const handleClick = (clickedId: string) => {
		if (clickedId === selectedAnnotationId && visible.length > 1) {
			const currentIndex = visible.findIndex((a) => a.id === clickedId);
			const nextIndex = (currentIndex + 1) % visible.length;
			onSelectAnnotation(visible[nextIndex].id);
		} else {
			onSelectAnnotation(clickedId);
		}
	};

	if (containerWidth <= 0 || containerHeight <= 0) return null;

	return (
		<div className="absolute inset-0" style={{ pointerEvents: "none" }}>
			{visible.map((annotation) => (
				<AnnotationOverlay
					key={
						annotation.type === "blur"
							? `${annotation.id}-${containerWidth}-${containerHeight}-${annotation.blurData?.shape ?? "rectangle"}-${annotation.blurData?.color ?? "white"}-${Math.round(annotation.blurData?.blockSize ?? 0)}-${(annotation.blurData?.freehandPoints ?? []).map((p) => `${Math.round(p.x)}_${Math.round(p.y)}`).join("-")}`
							: `${annotation.id}-${containerWidth}-${containerHeight}`
					}
					annotation={annotation}
					isSelected={annotation.id === selectedAnnotationId}
					containerWidth={containerWidth}
					containerHeight={containerHeight}
					onPositionChange={onPositionChange}
					onSizeChange={onSizeChange}
					onBlurDataChange={annotation.type === "blur" ? onBlurDataChange : undefined}
					onBlurDataCommit={annotation.type === "blur" ? onCommit : undefined}
					onClick={handleClick}
					zIndex={annotation.zIndex}
					isSelectedBoost={annotation.id === selectedAnnotationId}
					videoElement={videoElement}
					currentTimeMs={currentTimeMs}
				/>
			))}
		</div>
	);
}
