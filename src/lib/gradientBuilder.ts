import type { GradientEditorState } from "@/components/ui/gradient-editor";
import { clamp } from "@/utils/math";

/* ---------- editor state -> CSS background ----------
   The editor produces a clean 3-stop LINEAR gradient - the same shape
   as a "real" 3-color gradient picker, not clustered blobs. Brightness
   is a per-channel multiplier (0 = black, 100 = full color). */
export function buildGradientFromEditor(state: GradientEditorState): string {
	const { points, brightness, angle = 135 } = state;
	const colors = points.slice(0, 3).map((p) => applyBrightness(p.color, brightness));

	if (colors.length === 0) {
		return baseForBrightness(brightness);
	}
	if (colors.length === 1) {
		return `linear-gradient(${angle}deg, ${colors[0]} 0%, ${colors[0]} 100%)`;
	}
	if (colors.length === 2) {
		return `linear-gradient(${angle}deg, ${colors[0]} 0%, ${colors[1]} 50%, ${colors[1]} 100%)`;
	}

	return `linear-gradient(${angle}deg, ${colors[0]} 0%, ${colors[1]} 50%, ${colors[2]} 100%)`;
}

function applyBrightness(color: string, brightness: number): string {
	const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
	if (!match) return color;
	const k = brightness / 100;
	const r = Math.round(Number(match[1]) * k);
	const g = Math.round(Number(match[2]) * k);
	const b = Math.round(Number(match[3]) * k);
	return `rgb(${r}, ${g}, ${b})`;
}

function baseForBrightness(brightness: number): string {
	const l = Math.round((brightness / 100) * 18);
	return `hsl(0, 0%, ${clamp(l, 0, 22)}%)`;
}
