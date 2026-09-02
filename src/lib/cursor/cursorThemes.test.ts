import { describe, expect, it } from "vitest";
import {
	CURSOR_THEMES,
	type CursorTheme,
	DEFAULT_CURSOR_SPRITES,
	themePickerPreviewAssets,
} from "./cursorThemes";

describe("themePickerPreviewAssets", () => {
	it("hello-kitty-watermelon exposes distinct arrow and pointer", () => {
		const theme = CURSOR_THEMES.find((t) => t.id === "hello-kitty-watermelon");
		expect(theme).toBeTruthy();
		const preview = themePickerPreviewAssets(theme ?? null);
		expect(preview.arrow.length).toBeGreaterThan(0);
		expect(preview.pointer).toBeTruthy();
		expect(preview.pointer).not.toBe(preview.arrow);
	});

	it("arrow-only theme has no pointer preview", () => {
		const theme: CursorTheme = {
			id: "arrow-only",
			name: "Arrow only",
			assets: {
				arrow: {
					assetPath: "cursors/fake/arrow.png",
					width: 32,
					height: 32,
					hotspotX: 0,
					hotspotY: 0,
				},
			},
		};
		const preview = themePickerPreviewAssets(theme);
		expect(preview.arrow).toBe("cursors/fake/arrow.png");
		expect(preview.pointer).toBeNull();
	});

	it("default theme uses built-in arrow and pointer when they differ", () => {
		const preview = themePickerPreviewAssets(null);
		expect(preview.arrow).toBe(DEFAULT_CURSOR_SPRITES.arrow.assetPath);
		if (DEFAULT_CURSOR_SPRITES.pointer.assetPath !== DEFAULT_CURSOR_SPRITES.arrow.assetPath) {
			expect(preview.pointer).toBe(DEFAULT_CURSOR_SPRITES.pointer.assetPath);
		} else {
			expect(preview.pointer).toBeNull();
		}
	});
});
