import { describe, expect, it } from "vitest";
import { DEFAULT_ANNOTATION_STYLE } from "@/components/video-editor/types";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import {
	DEFAULT_TEXT_BACKGROUND,
	hasTextBackground,
	setTextBackgroundColor,
	textBackgroundColor,
	toggleTextBackground,
} from "./background";

type AnnotationStyle = AxcutAnnotationRegion["style"];

const styleWith = (patch: Partial<AnnotationStyle>): AnnotationStyle => ({
	...DEFAULT_ANNOTATION_STYLE,
	...patch,
});

describe("text background", () => {
	it("reads transparent as no background", () => {
		expect(hasTextBackground(styleWith({ backgroundColor: "transparent" }))).toBe(false);
		expect(hasTextBackground(styleWith({ backgroundColor: "#3b82f6" }))).toBe(true);
	});

	it("remembers the colour across an off/on cycle", () => {
		// Le bug rapporté : éteindre puis rallumer le fond rendait du noir, parce que « pas de fond »
		// s'écrit dans le champ même qui porte la couleur.
		const chosen = styleWith({ backgroundColor: "#3b82f6" });
		const off = toggleTextBackground(chosen, false);
		expect(off.backgroundColor).toBe("transparent");
		const on = toggleTextBackground(off, true);
		expect(on.backgroundColor).toBe("#3b82f6");
	});

	it("survives several off/on cycles rather than only the first", () => {
		let style = setTextBackgroundColor(styleWith({}), "#f59e0b");
		for (let i = 0; i < 3; i++) {
			style = toggleTextBackground(style, false);
			style = toggleTextBackground(style, true);
		}
		expect(style.backgroundColor).toBe("#f59e0b");
	});

	it("falls back to black only on a first switch-on", () => {
		const never = styleWith({ backgroundColor: "transparent" });
		expect(toggleTextBackground(never, true).backgroundColor).toBe(DEFAULT_TEXT_BACKGROUND);
	});

	it("shows the remembered colour while the background is off", () => {
		// La pastille du sélecteur doit annoncer ce que le rallumage rendra, pas un noir arbitraire.
		const off = toggleTextBackground(styleWith({ backgroundColor: "#ec4899" }), false);
		expect(textBackgroundColor(off)).toBe("#ec4899");
	});

	it("ignores a remembered transparent, which is not a colour", () => {
		const style = styleWith({ backgroundColor: "transparent", lastBackgroundColor: "transparent" });
		expect(textBackgroundColor(style)).toBe(DEFAULT_TEXT_BACKGROUND);
	});

	it("picking a colour turns the background on and updates the memory", () => {
		const off = styleWith({ backgroundColor: "transparent" });
		const picked = setTextBackgroundColor(off, "#22c55e");
		expect(picked.backgroundColor).toBe("#22c55e");
		expect(hasTextBackground(picked)).toBe(true);
		// et l'extinction suivante rend bien cette couleur, pas la précédente
		expect(textBackgroundColor(toggleTextBackground(picked, false))).toBe("#22c55e");
	});

	it("leaves the rest of the style untouched", () => {
		const style = styleWith({ color: "#ffffff", fontSize: 48 });
		const toggled = toggleTextBackground(style, true);
		expect(toggled.color).toBe("#ffffff");
		expect(toggled.fontSize).toBe(48);
	});
});
