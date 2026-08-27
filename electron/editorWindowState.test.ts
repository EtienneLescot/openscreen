import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clampRectToWorkArea,
	loadEditorWindowState,
	resolveEditorCreation,
	saveEditorWindowState,
	shouldTrackEditorWindow,
} from "./editorWindowState";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
});

function tmp(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "os-editor-win-"));
	temps.push(dir);
	return dir;
}

describe("editor window state", () => {
	it("returns null when the file is missing", () => {
		expect(loadEditorWindowState(tmp())).toBeNull();
	});

	it("clamps an off-screen rect onto the display workArea", () => {
		const clamped = clampRectToWorkArea(
			{ x: -4000, y: 50, width: 1200, height: 800 },
			{ x: 0, y: 0, width: 1920, height: 1080 },
		);
		expect(clamped.x).toBe(0);
		expect(clamped.y).toBe(50);
		expect(clamped.width).toBe(1200);
		expect(clamped.height).toBe(800);
	});

	it("still maximizes when nothing is saved, and never loads or saves the bench", () => {
		const missing = resolveEditorCreation({ isBench: false, saved: null });
		expect(missing.maximize).toBe(true);
		expect(missing.persist).toBe(true);
		expect(missing.bounds).toEqual({ width: 1200, height: 800 });

		expect(shouldTrackEditorWindow({ windowType: "bench" })).toBe(false);
		const bench = resolveEditorCreation({ isBench: true, saved: null });
		expect(bench.persist).toBe(false);
		expect(bench.maximize).toBe(true);

		const dir = tmp();
		saveEditorWindowState(dir, { x: 10, y: 20, width: 1280, height: 720, maximized: false });
		expect(shouldTrackEditorWindow({ windowType: "bench" })).toBe(false);
		expect(shouldTrackEditorWindow({})).toBe(true);
	});

	it("round-trips a save through load", () => {
		const dir = tmp();
		const state = { x: 10, y: 20, width: 1280, height: 720, maximized: true };
		saveEditorWindowState(dir, state);
		expect(loadEditorWindowState(dir)).toEqual(state);
	});

	it("returns null on a corrupted file instead of throwing", () => {
		const dir = tmp();
		writeFileSync(path.join(dir, "editor-window.json"), "{ not json");
		expect(loadEditorWindowState(dir)).toBeNull();
	});

	it("rejects garbage fields rather than restoring a broken rect", () => {
		const dir = tmp();
		writeFileSync(
			path.join(dir, "editor-window.json"),
			JSON.stringify({ x: Number.NaN, y: 20, width: "1280", height: 720, maximized: false }),
		);
		expect(loadEditorWindowState(dir)).toBeNull();
	});
});
