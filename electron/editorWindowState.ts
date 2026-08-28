// Persist/restore the editor window's normal bounds and maximized flag.
// The export bench must never load or save this file — it measures a 1200×800
// maximized window on purpose.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_EDITOR_SIZE = { width: 1200, height: 800 };
export const EDITOR_WINDOW_MIN = { width: 800, height: 600 };

export interface EditorWindowRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface EditorWindowState extends EditorWindowRect {
	maximized: boolean;
}

export interface DisplayWorkArea {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function editorWindowStatePath(userData: string): string {
	return path.join(userData, "editor-window.json");
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function parseEditorWindowState(raw: unknown): EditorWindowState | null {
	if (!raw || typeof raw !== "object") return null;
	const rec = raw as Record<string, unknown>;
	// Zero/negative dimensions and a non-boolean `maximized` are garbage the
	// app never writes; restoring them would clamp into a small non-maximized
	// window instead of the documented default. Reject the record whole.
	if (
		!isFiniteNumber(rec.x) ||
		!isFiniteNumber(rec.y) ||
		!isFiniteNumber(rec.width) ||
		!isFiniteNumber(rec.height) ||
		rec.width <= 0 ||
		rec.height <= 0 ||
		typeof rec.maximized !== "boolean"
	) {
		return null;
	}
	return {
		x: rec.x,
		y: rec.y,
		width: rec.width,
		height: rec.height,
		maximized: rec.maximized,
	};
}

export function loadEditorWindowState(userData: string): EditorWindowState | null {
	const file = editorWindowStatePath(userData);
	if (!existsSync(file)) return null;
	try {
		return parseEditorWindowState(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

export function saveEditorWindowState(userData: string, state: EditorWindowState): void {
	try {
		writeFileSync(editorWindowStatePath(userData), `${JSON.stringify(state)}\n`, "utf8");
	} catch {
		// Best-effort; a failed write must not block close.
	}
}

export function clampRectToWorkArea(
	rect: EditorWindowRect,
	workArea: DisplayWorkArea,
	min = EDITOR_WINDOW_MIN,
): EditorWindowRect {
	const width = Math.min(Math.max(rect.width, min.width), Math.max(min.width, workArea.width));
	const height = Math.min(Math.max(rect.height, min.height), Math.max(min.height, workArea.height));
	const maxX = workArea.x + Math.max(0, workArea.width - width);
	const maxY = workArea.y + Math.max(0, workArea.height - height);
	return {
		x: Math.min(Math.max(rect.x, workArea.x), maxX),
		y: Math.min(Math.max(rect.y, workArea.y), maxY),
		width,
		height,
	};
}

export function shouldTrackEditorWindow(query: Record<string, string>): boolean {
	return query.windowType !== "bench";
}

export function resolveEditorCreation(input: {
	isBench: boolean;
	saved: EditorWindowState | null;
}): {
	bounds: { x?: number; y?: number; width: number; height: number };
	maximize: boolean;
	persist: boolean;
} {
	if (input.isBench) {
		return { bounds: { ...DEFAULT_EDITOR_SIZE }, maximize: true, persist: false };
	}
	if (!input.saved) {
		return { bounds: { ...DEFAULT_EDITOR_SIZE }, maximize: true, persist: true };
	}
	return {
		bounds: {
			x: input.saved.x,
			y: input.saved.y,
			width: input.saved.width,
			height: input.saved.height,
		},
		maximize: input.saved.maximized,
		persist: true,
	};
}
