// The depth→scale table is now read by three consumers that used to each carry
// their own idea of it: the renderer, the native compositor, and the agent's
// tool descriptions. These tests pin the two properties that made the copies
// disagree — the mapping is NOT linear, and `customScale` wins but is clamped.

import { describe, expect, it } from "vitest";
import { getZoomScale, ZOOM_DEPTH_SCALES } from "@/components/video-editor/types";
import {
	effectiveZoomScale,
	MAX_ZOOM_SCALE,
	MIN_ZOOM_SCALE,
	ZOOM_DEPTH_LEGEND,
} from "./zoom-scale";

describe("effectiveZoomScale", () => {
	it("maps each depth to the table, which is not depth/2 + 0.5", () => {
		expect(effectiveZoomScale({ depth: 1 })).toBe(1.25);
		expect(effectiveZoomScale({ depth: 3 })).toBe(1.8);
		expect(effectiveZoomScale({ depth: 6 })).toBe(5.0);
		// The formula the agent's descriptions advertised for a release. It agrees
		// with the table at depth 2 and nowhere else — which is why "depth 3 ≈ 2.0×"
		// read plausibly while the pill showed 1.80×.
		const claimed = (depth: number) => depth / 2 + 0.5;
		const agreeing = ([1, 2, 3, 4, 5, 6] as const).filter(
			(d) => Math.abs(claimed(d) - ZOOM_DEPTH_SCALES[d]) < 0.001,
		);
		expect(agreeing).toEqual([2]);
	});

	it("prefers customScale over the depth", () => {
		expect(effectiveZoomScale({ depth: 6, customScale: 1.1 })).toBe(1.1);
	});

	it("clamps customScale into the range the renderer can produce", () => {
		// `zoomRegionSchema` accepts any positive number, so both of these are
		// documents that exist.
		expect(effectiveZoomScale({ depth: 3, customScale: 12 })).toBe(MAX_ZOOM_SCALE);
		expect(effectiveZoomScale({ depth: 3, customScale: 0.2 })).toBe(MIN_ZOOM_SCALE);
	});

	it("falls back to the depth when customScale is not a number the renderer can use", () => {
		expect(effectiveZoomScale({ depth: 4, customScale: Number.NaN })).toBe(2.2);
	});

	it("is exactly what the renderer's getZoomScale re-exports", () => {
		// types.ts re-exports rather than redefining: the split exists only because
		// the Electron main process cannot resolve the `@/` alias the renderer file
		// uses, and it must not become a second table.
		for (const depth of [1, 2, 3, 4, 5, 6] as const) {
			expect(getZoomScale({ depth })).toBe(effectiveZoomScale({ depth }));
		}
		expect(getZoomScale({ depth: 1, customScale: 9 })).toBe(
			effectiveZoomScale({ depth: 1, customScale: 9 }),
		);
	});
});

describe("ZOOM_DEPTH_LEGEND", () => {
	it("is derived from the table, in depth order", () => {
		expect(ZOOM_DEPTH_LEGEND).toBe("1=1.25×, 2=1.50×, 3=1.80×, 4=2.20×, 5=3.50×, 6=5.00×");
		for (const depth of [1, 2, 3, 4, 5, 6] as const) {
			expect(ZOOM_DEPTH_LEGEND).toContain(`${depth}=${ZOOM_DEPTH_SCALES[depth].toFixed(2)}×`);
		}
	});
});
