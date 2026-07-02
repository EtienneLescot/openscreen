// Defaults ported verbatim from `src/components/video-editor/types.ts` so
// newly-created annotations look identical between the legacy and new editor.

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";

type AnnotationStyle = AxcutAnnotationRegion["style"];
type BlurData = NonNullable<AxcutAnnotationRegion["blurData"]>;
type FigureData = NonNullable<AxcutAnnotationRegion["figureData"]>;

export const DEFAULT_ANNOTATION_POSITION = { x: 50, y: 50 };
export const DEFAULT_ANNOTATION_SIZE = { width: 30, height: 20 };

export const DEFAULT_ANNOTATION_STYLE: AnnotationStyle = {
	color: "#ffffff",
	backgroundColor: "transparent",
	fontSize: 32,
	fontFamily: "Inter",
	fontWeight: "bold",
	fontStyle: "normal",
	textDecoration: "none",
	textAlign: "center",
	textAnimation: "none",
};

export const DEFAULT_FIGURE_DATA: FigureData = {
	arrowDirection: "right",
	color: "#34B27B",
	strokeWidth: 4,
};

export const MIN_BLUR_INTENSITY = 2;
export const MAX_BLUR_INTENSITY = 40;
export const DEFAULT_BLUR_INTENSITY = 12;
export const MIN_BLUR_BLOCK_SIZE = 4;
export const MAX_BLUR_BLOCK_SIZE = 48;
export const DEFAULT_BLUR_BLOCK_SIZE = 12;

export const DEFAULT_BLUR_FREEHAND_POINTS: Array<{ x: number; y: number }> = [
	{ x: 10, y: 30 },
	{ x: 25, y: 10 },
	{ x: 55, y: 8 },
	{ x: 82, y: 20 },
	{ x: 90, y: 45 },
	{ x: 78, y: 72 },
	{ x: 52, y: 90 },
	{ x: 22, y: 84 },
	{ x: 8, y: 58 },
];

export const DEFAULT_BLUR_DATA: BlurData = {
	type: "mosaic",
	shape: "rectangle",
	color: "white",
	intensity: DEFAULT_BLUR_INTENSITY,
	blockSize: DEFAULT_BLUR_BLOCK_SIZE,
	freehandPoints: DEFAULT_BLUR_FREEHAND_POINTS,
};
