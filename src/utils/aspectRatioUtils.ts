/** The fixed shapes offered in the ratio picker, in menu order. */
export const ASPECT_RATIO_PRESETS = [
	"16:9",
	"9:16",
	"1:1",
	"4:3",
	"4:5",
	"16:10",
	"10:16",
] as const;

export type AspectRatioPreset = (typeof ASPECT_RATIO_PRESETS)[number];

/**
 * A concrete `"W:H"` shape. The presets are just the well-known members — the picker also
 * offers the clips' own native shapes ("Original"), which are stored the same way and can be
 * anything (`"64:27"` for an ultrawide, `"683:384"` for an odd capture size).
 */
export type AspectRatio = AspectRatioPreset | `${number}:${number}`;

const ASPECT_RATIO_FALLBACK = 16 / 9;

/** Split a `"W:H"` token. Returns null for anything malformed. */
export function parseAspectRatio(value: string): { width: number; height: number } | null {
	const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
	if (!match) return null;
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		return null;
	}
	return { width, height };
}

/** Validation gate for anything read back from disk (project files, user prefs). */
export function isAspectRatio(value: unknown): value is AspectRatio {
	if (typeof value !== "string") return false;
	return parseAspectRatio(value) !== null;
}

function greatestCommonDivisor(a: number, b: number): number {
	let x = a;
	let y = b;
	while (y !== 0) {
		const next = x % y;
		x = y;
		y = next;
	}
	return x;
}

/**
 * Pixel dimensions → the reduced `"W:H"` token that identifies their shape. This is what makes
 * "distinct native formats" a small set: 1920x1080 and 3840x2160 both reduce to `"16:9"`, so a
 * timeline mixing them offers ONE "Original" entry, not two.
 */
export function toAspectRatioToken(width: number, height: number): AspectRatio | null {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		return null;
	}
	const w = Math.round(width);
	const h = Math.round(height);
	if (w <= 0 || h <= 0) return null;
	const divisor = greatestCommonDivisor(w, h) || 1;
	return `${w / divisor}:${h / divisor}`;
}

/**
 * Numeric value of an aspect ratio. Returns the 16/9 fallback for any value that doesn't
 * parse as a `"W:H"` token.
 */
export function getAspectRatioValue(aspectRatio: AspectRatio): number {
	const parsed = parseAspectRatio(aspectRatio);
	return parsed ? parsed.width / parsed.height : ASPECT_RATIO_FALLBACK;
}

export function getNativeAspectRatioValue(
	videoWidth: number,
	videoHeight: number,
	cropRegion?: { x: number; y: number; width: number; height: number },
): number {
	const cropW = cropRegion?.width ?? 1;
	const cropH = cropRegion?.height ?? 1;
	if (
		!Number.isFinite(videoWidth) ||
		!Number.isFinite(videoHeight) ||
		!Number.isFinite(cropW) ||
		!Number.isFinite(cropH) ||
		videoWidth <= 0 ||
		videoHeight <= 0 ||
		cropW <= 0 ||
		cropH <= 0
	) {
		return ASPECT_RATIO_FALLBACK;
	}

	const ratio = (videoWidth * cropW) / (videoHeight * cropH);
	return Number.isFinite(ratio) && ratio > 0 ? ratio : ASPECT_RATIO_FALLBACK;
}

export function getAspectRatioDimensions(
	aspectRatio: AspectRatio,
	baseWidth: number,
): { width: number; height: number } {
	const ratio = getAspectRatioValue(aspectRatio);
	return {
		width: baseWidth,
		height: baseWidth / ratio,
	};
}

export function getAspectRatioLabel(aspectRatio: AspectRatio): string {
	return aspectRatio;
}

export function isPortraitAspectRatio(aspectRatio: AspectRatio): boolean {
	return getAspectRatioValue(aspectRatio) < 1;
}

export function formatAspectRatioForCSS(aspectRatio: AspectRatio): string {
	return aspectRatio.replace(":", "/");
}
