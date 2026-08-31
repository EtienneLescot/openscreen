import { describe, expect, it } from "vitest";
import type { AxcutCursorMotionRegion } from "../schema";
import { sampleStoredCursorMotionRegion, toModelCursorMotionRegion } from "./cursorMotionRegions";

const region = (patch: Partial<AxcutCursorMotionRegion> = {}): AxcutCursorMotionRegion => ({
	id: "cm_1",
	startMs: 2000,
	endMs: 4000,
	clipId: "clip_a",
	assetId: "asset_1",
	sourceStartSec: 1,
	sourceEndSec: 3,
	startPoint: { cx: 0.1, cy: 0.5 },
	endPoint: { cx: 0.9, cy: 0.5 },
	controlPoint: { cx: 0.5, cy: 0.2 },
	startAnchor: "manual",
	endAnchor: "click",
	segmentKind: "move",
	preset: "arc",
	speed: 1,
	cycles: 1,
	easing: "linear",
	...patch,
});

describe("toModelCursorMotionRegion", () => {
	it("converts the stored anchor's seconds into the sampler's milliseconds", () => {
		// The document stores `sourceStartSec`/`sourceEndSec` because that is the
		// clip-anchor convention every region kind shares; the sampler works in ms.
		// A conversion off by 1000 would put every region outside its own span and
		// make the whole feature silently inert, so it gets its own assertion.
		const model = toModelCursorMotionRegion(region());
		expect(model.sourceStartMs).toBe(1000);
		expect(model.sourceEndMs).toBe(3000);
	});

	it("wraps the single stored control point into the list the sampler takes", () => {
		const model = toModelCursorMotionRegion(region());
		expect(model.controlPoints).toEqual([{ cx: 0.5, cy: 0.2 }]);
	});

	it("survives a region with no clip anchor rather than producing NaN times", () => {
		// The anchor is optional in the schema (shared with every other region kind,
		// and v2 imports arrive without one). An unanchored region should collapse to
		// a zero-length span, not to `NaN`, which would poison every comparison the
		// sampler makes.
		const model = toModelCursorMotionRegion(
			region({ clipId: undefined, sourceStartSec: undefined, sourceEndSec: undefined }),
		);
		expect(model.sourceStartMs).toBe(0);
		expect(model.sourceEndMs).toBe(0);
		expect(model.clipId).toBe("");
	});
});

describe("sampleStoredCursorMotionRegion", () => {
	it("lands exactly on its anchors at both ends", () => {
		// The endpoints are where the recording actually put the cursor. A path that
		// starts or ends a pixel off teleports the pointer at the seam between two
		// sections, which is the artefact the whole split-at-rests design exists to
		// avoid.
		const r = region();
		expect(sampleStoredCursorMotionRegion(r, 1000)).toEqual(r.startPoint);
		expect(sampleStoredCursorMotionRegion(r, 3000)).toEqual(r.endPoint);
	});

	it("clamps outside its span instead of extrapolating", () => {
		const r = region();
		expect(sampleStoredCursorMotionRegion(r, 0)).toEqual(r.startPoint);
		expect(sampleStoredCursorMotionRegion(r, 99_000)).toEqual(r.endPoint);
	});

	it("bends towards the control point for an arc", () => {
		// The control point sits above the chord (cy 0.2 against 0.5), so the middle
		// of the path must too. This is the assertion that would fail if the control
		// point were ever read as an offset rather than an absolute position.
		const middle = sampleStoredCursorMotionRegion(region(), 2000);
		expect(middle.cy).toBeLessThan(0.5);
	});

	it("leaves the chord alone when the preset is `recorded`", () => {
		// `recorded` is inert by contract: it exists so a section can hold a selection
		// without changing the picture. If it ever started bending, creating regions
		// would silently alter footage nobody asked to edit.
		const straight = sampleStoredCursorMotionRegion(region({ preset: "recorded" }), 2000);
		expect(straight.cy).toBeCloseTo(0.5, 6);
	});

	it("reaches further along the path at 4x than at 1x, at the same instant", () => {
		// Speed reshapes progress inside the section; it does not retime it. A quarter
		// of the way through, the fast one has covered more ground — and both still
		// end on the same anchor at the same time, which the anchor test above pins.
		const at = (speed: number) =>
			sampleStoredCursorMotionRegion(region({ preset: "straight", speed }), 1500).cx;
		expect(at(4)).toBeGreaterThan(at(1));
		expect(sampleStoredCursorMotionRegion(region({ preset: "straight", speed: 4 }), 3000)).toEqual(
			region().endPoint,
		);
	});
});
