// "Turn the background off" (#84) is not a setting — it is a shape four settings can be in.
// These pin that reading, because the failure mode is silent: a predicate that is too lax
// shows the toggle ON while wallpaper is still visible in the letterbox bars, which is the
// exact confusion the issue reports.

import { describe, expect, it } from "vitest";
import type { AspectRatio } from "@/utils/aspectRatioUtils";
import { fillFramePatch, fillsFrame } from "./RightPanes";

const FILLED = {
	padding: 0,
	borderRadius: 0,
	shadowIntensity: 0,
	aspectRatio: "16:10" as AspectRatio,
};
const NATIVE = new Set<AspectRatio>(["16:10"]);

describe("fillsFrame reads the four settings, not a stored flag", () => {
	it("is true when nothing can show through", () => {
		expect(fillsFrame(FILLED, NATIVE)).toBe(true);
	});

	it.each([
		["padding", { padding: 1 }],
		["roundness", { borderRadius: 0.5 }],
		["shadow", { shadowIntensity: 0.01 }],
	])("is false as soon as the %s lets the background back in", (_label, override) => {
		expect(fillsFrame({ ...FILLED, ...override }, NATIVE)).toBe(false);
	});

	it("is false when the output shape is not the footage's, however zeroed the frame is", () => {
		// The whole reason #84 reads as unfixable to someone who already found the padding
		// slider: a 16:10 capture in a 16:9 project keeps its wallpaper bars at padding 0,
		// because zero padding only fills the WIDTH.
		expect(fillsFrame({ ...FILLED, aspectRatio: "16:9" as AspectRatio }, NATIVE)).toBe(false);
	});

	it("accepts any of the timeline's shapes, not just the first", () => {
		const mixed = new Set<AspectRatio>(["16:9", "9:16"]);
		expect(fillsFrame({ ...FILLED, aspectRatio: "9:16" as AspectRatio }, mixed)).toBe(true);
	});

	it("is a claim about the SETTINGS, not about every clip on a mixed timeline", () => {
		// Deliberate, and the pane says so out loud: one output frame cannot be filled by
		// clips of different shapes, because the screen path contain-fits. With 16:9 and 9:16
		// on the timeline, whichever shape is chosen leaves the other letterboxed — so this
		// reads true while background is still visible on some clips, and `clipsStillFramed`
		// in VideoEffectsPane is what stops that from being a silent lie.
		const mixed = new Set<AspectRatio>(["16:9", "9:16"]);
		expect(fillsFrame({ ...FILLED, aspectRatio: "16:9" as AspectRatio }, mixed)).toBe(true);
		expect(fillsFrame({ ...FILLED, aspectRatio: "9:16" as AspectRatio }, mixed)).toBe(true);
	});

	it("is false for a timeline whose shapes are unknown", () => {
		// No clips probed yet — there is nothing to fill, so the toggle must not read ON.
		expect(fillsFrame(FILLED, new Set())).toBe(false);
	});
});

describe("fillFramePatch", () => {
	it("zeroes the three frame values and adopts the footage's shape", () => {
		expect(fillFramePatch(true, "16:10")).toEqual({
			padding: 0,
			borderRadius: 0,
			shadowIntensity: 0,
			aspectRatio: "16:10",
		});
	});

	it("round-trips: what it turns on, fillsFrame reads as on", () => {
		const patched = { ...FILLED, ...fillFramePatch(true, "16:10") };
		expect(fillsFrame(patched, NATIVE)).toBe(true);
	});

	it("restores the shipped defaults when switched off", () => {
		const off = fillFramePatch(false, "16:10");
		expect(off.padding).toBeGreaterThan(0);
		expect(off.borderRadius).toBeGreaterThan(0);
		expect(off.shadowIntensity).toBeGreaterThan(0);
	});

	it("leaves the aspect ratio alone when switched off", () => {
		// Wanting the background back is not asking for the output to be reframed, and the
		// three frame values alone bring it back.
		expect(fillFramePatch(false, "16:10")).not.toHaveProperty("aspectRatio");
	});
});
