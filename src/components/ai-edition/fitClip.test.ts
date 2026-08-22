// "Turn the background off" (#84) is four settings, not one, and the aspect ratio is the one
// that is easy to forget: padding 0 only fills the WIDTH, so a 16:10 capture in a 16:9 project
// keeps its wallpaper bars however zeroed the frame is. That is exactly why the issue reads as
// unfixable to someone who already found the padding slider — so it gets pinned here.

import { describe, expect, it } from "vitest";
import { fitClipPatch } from "./RightPanes";

describe("fitClipPatch", () => {
	it("zeroes the three frame values and adopts the footage's shape", () => {
		expect(fitClipPatch("16:10")).toEqual({
			padding: 0,
			borderRadius: 0,
			shadowIntensity: 0,
			aspectRatio: "16:10",
		});
	});

	it("adopts the shape it is given, not a preset", () => {
		// An odd capture size is exactly the case a preset list cannot serve.
		expect(fitClipPatch("683:384").aspectRatio).toBe("683:384");
	});

	it("has no inverse, deliberately", () => {
		// It was a toggle, and its OFF branch restored the shipped defaults — a guess dressed
		// as a memory, since nothing stored what the user actually had. Undo does that job,
		// and the three sliders it writes sit right below the button.
		expect(Object.keys(fitClipPatch("16:10")).sort()).toEqual([
			"aspectRatio",
			"borderRadius",
			"padding",
			"shadowIntensity",
		]);
	});
});
