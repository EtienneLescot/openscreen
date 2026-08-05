// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getPlatform, isMac } from "./platformUtils";

// The renderer has no Node `process` global (contextIsolation: true), and
// browser mode has no `electronAPI` at all. jsdom provides `process`, so a
// regression here is invisible to every other gate — this file is the guard.

const original = window.electronAPI;

afterEach(() => {
	window.electronAPI = original;
});

describe("getPlatform", () => {
	it("reads the value the preload exposes", () => {
		window.electronAPI = { getPlatform: () => "darwin" } as typeof window.electronAPI;
		expect(getPlatform()).toBe("darwin");
		expect(isMac()).toBe(true);
	});

	it("falls back to navigator when electronAPI is absent (browser mode)", () => {
		// @ts-expect-error — browser mode genuinely has no electronAPI.
		window.electronAPI = undefined;
		expect(() => getPlatform()).not.toThrow();
		expect(typeof getPlatform()).toBe("string");
	});
});
