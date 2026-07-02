// Port of `src/lib/annotationTextAnimation.ts` — pure, no Pixi/React deps,
// copied verbatim (only the annotation param type changed to structurally
// match `AxcutAnnotationRegion` instead of the legacy `AnnotationRegion`).

export type AnnotationTextAnimation =
	| "none"
	| "fade"
	| "rise"
	| "pop"
	| "slide-left"
	| "typewriter"
	| "pulse";

export const TEXT_ANIMATION_DURATION_MS = 700;

export interface TextAnimationState {
	opacity: number;
	scale: number;
	translateX: number;
	translateY: number;
	revealProgress: number;
}

const TEXT_ANIMATION_VALUES: AnnotationTextAnimation[] = [
	"none",
	"fade",
	"rise",
	"pop",
	"slide-left",
	"typewriter",
	"pulse",
];

function clamp(value: number, min = 0, max = 1) {
	return Math.min(max, Math.max(min, value));
}

function easeOutCubic(value: number) {
	const t = clamp(value);
	return 1 - (1 - t) ** 3;
}

function easeOutBack(value: number) {
	const t = clamp(value);
	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

export function normalizeTextAnimation(value: unknown): AnnotationTextAnimation {
	return TEXT_ANIMATION_VALUES.includes(value as AnnotationTextAnimation)
		? (value as AnnotationTextAnimation)
		: "none";
}

export function getTextAnimationState(
	annotation: { startMs: number; style: { textAnimation?: string } },
	currentTimeMs: number,
): TextAnimationState {
	const animation = normalizeTextAnimation(annotation.style.textAnimation);
	if (animation === "none") {
		return { opacity: 1, scale: 1, translateX: 0, translateY: 0, revealProgress: 1 };
	}

	const elapsedMs = Math.max(0, currentTimeMs - annotation.startMs);
	const progress = clamp(elapsedMs / TEXT_ANIMATION_DURATION_MS);
	const eased = easeOutCubic(progress);

	switch (animation) {
		case "fade":
			return { opacity: eased, scale: 1, translateX: 0, translateY: 0, revealProgress: 1 };
		case "rise":
			return {
				opacity: eased,
				scale: 1,
				translateX: 0,
				translateY: (1 - eased) * 18,
				revealProgress: 1,
			};
		case "pop":
			return {
				opacity: eased,
				scale: Math.max(0.72, easeOutBack(progress)),
				translateX: 0,
				translateY: 0,
				revealProgress: 1,
			};
		case "slide-left":
			return {
				opacity: eased,
				scale: 1,
				translateX: (1 - eased) * -28,
				translateY: 0,
				revealProgress: 1,
			};
		case "typewriter":
			return { opacity: 1, scale: 1, translateX: 0, translateY: 0, revealProgress: progress };
		case "pulse":
			return {
				opacity: 1,
				scale: 1 + Math.sin(progress * Math.PI) * 0.06,
				translateX: 0,
				translateY: 0,
				revealProgress: 1,
			};
		default:
			return { opacity: 1, scale: 1, translateX: 0, translateY: 0, revealProgress: 1 };
	}
}
