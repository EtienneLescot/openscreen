// Chroma key (green screen) settings for the editor's webcam layer.
//
// NON-DESTRUCTIVE BY CONSTRUCTION. The camera is recorded to its own sidecar
// file on every platform and only ever composited at display time, so the key
// is a per-frame effect on an existing draw call — never a change to the
// recorded pixels. Toggling `enabled` off restores the original camera, and
// the colour/threshold can be re-picked at any point in the project's life.
//
// WHAT THIS MODULE DOES NOT DO: convert the colour. The hex travels to the
// native compositor as a hex, and Rust turns it into chroma coordinates
// (`chroma_key_uniform` in `frame_geometry.rs`). That conversion has to exist
// on the Rust side regardless — the live-preview path pushes the colour as a
// STRING param (`webcamChromaColor`), which is the only shape a string param
// can carry — so doing it here as well would be two copies of the same BT.709
// matrix, free to drift apart in silence. One implementation, on the side that
// cannot avoid having it.

import { clamp01 } from "@/utils/math";

export interface WebcamChromaKeySettings {
	enabled: boolean;
	/** Key colour as `#rrggbb`. */
	color: string;
	/** 0..1 — how far from the key colour still counts as background. */
	similarity: number;
	/** 0..1 — width of the soft edge past `similarity`. */
	smoothness: number;
	/** 0..1 — how hard to desaturate the key's colour cast off the subject's edges. */
	spill: number;
}

/**
 * `#00b140` is the SMPTE/"studio green" backdrop colour, and the far more
 * common physical green screen than pure `#00ff00` — which no fabric or paint
 * actually is, so seeding the picker with it would make the first preview look
 * broken before the user touched a slider.
 */
export const DEFAULT_WEBCAM_CHROMA_KEY_COLOR = "#00b140";
export const DEFAULT_WEBCAM_CHROMA_KEY_ENABLED = false;
export const DEFAULT_WEBCAM_CHROMA_KEY_SIMILARITY = 0.32;
export const DEFAULT_WEBCAM_CHROMA_KEY_SMOOTHNESS = 0.1;
export const DEFAULT_WEBCAM_CHROMA_KEY_SPILL = 0.3;

export const DEFAULT_WEBCAM_CHROMA_KEY: WebcamChromaKeySettings = {
	enabled: DEFAULT_WEBCAM_CHROMA_KEY_ENABLED,
	color: DEFAULT_WEBCAM_CHROMA_KEY_COLOR,
	similarity: DEFAULT_WEBCAM_CHROMA_KEY_SIMILARITY,
	smoothness: DEFAULT_WEBCAM_CHROMA_KEY_SMOOTHNESS,
	spill: DEFAULT_WEBCAM_CHROMA_KEY_SPILL,
};

/** Studio greens and blues first, then the neutrals a picker still wants. */
export const CHROMA_KEY_PRESETS: readonly string[] = [
	"#00b140",
	"#00ff00",
	"#3cb44b",
	"#0047bb",
	"#0000ff",
	"#00a3e0",
	"#ffffff",
	"#000000",
];

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * `"0f0"` / `"#0F0"` / `" #00b140 "` → `"#00ff00"` / `"#00ff00"` / `"#00b140"`.
 * `null` for anything that is not a hex colour — the caller decides whether that
 * means "keep the default" (persisted settings) or "ignore this keystroke" (a
 * half-typed field).
 */
export function normaliseChromaHex(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
	if (!HEX.test(withHash)) return null;
	const lower = withHash.toLowerCase();
	if (lower.length === 7) return lower;
	// Expand #rgb — the compositor's `parse_hex_color` accepts both, but the
	// document should hold one canonical form so a round-trip can be compared.
	const [, r, g, b] = lower;
	return `#${r}${r}${g}${g}${b}${b}`;
}

/** Clamp a persisted/patched settings blob into range. Non-finite → default. */
export function normaliseChromaKeySettings(
	partial: Partial<WebcamChromaKeySettings> | null | undefined,
): WebcamChromaKeySettings {
	const color = typeof partial?.color === "string" ? normaliseChromaHex(partial.color) : null;
	return {
		enabled:
			typeof partial?.enabled === "boolean" ? partial.enabled : DEFAULT_WEBCAM_CHROMA_KEY.enabled,
		color: color ?? DEFAULT_WEBCAM_CHROMA_KEY.color,
		similarity: clampOr(partial?.similarity, DEFAULT_WEBCAM_CHROMA_KEY.similarity),
		smoothness: clampOr(partial?.smoothness, DEFAULT_WEBCAM_CHROMA_KEY.smoothness),
		spill: clampOr(partial?.spill, DEFAULT_WEBCAM_CHROMA_KEY.spill),
	};
}

function clampOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : fallback;
}
