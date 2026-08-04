import { beforeEach, describe, expect, it } from "vitest";
import {
	newRegionDurationSec,
	PILL_CREATE_MIN_SEC,
	PILL_CREATE_PX,
	setTimelineScale,
} from "./newRegionDuration";

describe("newRegionDurationSec", () => {
	beforeEach(() => setTimelineScale(0));

	it("trades duration for a constant width", () => {
		// The reported case: 30 minutes across a ~760px panel is 0.42 px/s, where a
		// flat 2 s region is under a pixel — invisible behind the playhead it was
		// created at. At that scale a readable pill is worth nearly four minutes.
		setTimelineScale(760 / 1800);
		expect(newRegionDurationSec()).toBeCloseTo(227.4, 1);

		// Zoom in 50x and the same gesture creates a region 50x shorter — the pill
		// on screen is the same size either way, which is the whole point.
		setTimelineScale((760 / 1800) * 50);
		expect(newRegionDurationSec()).toBeCloseTo(4.55, 2);
	});

	it("stays at the floor when the pixels are worth almost nothing", () => {
		// 40px of a 3-second clip zoomed to the ceiling: without the floor the
		// region would be born a few hundredths of a second long.
		setTimelineScale(10_000);
		expect(newRegionDurationSec()).toBe(PILL_CREATE_MIN_SEC);
	});

	it("says nothing at all before the timeline has been measured", () => {
		// First paint, or no timeline mounted: callers fall back to their own
		// default rather than deriving a length from a width of zero.
		expect(newRegionDurationSec()).toBeUndefined();
		setTimelineScale(Number.NaN);
		expect(newRegionDurationSec()).toBeUndefined();
		setTimelineScale(Number.POSITIVE_INFINITY);
		expect(newRegionDurationSec()).toBeUndefined();
	});

	it("keeps the width it promises", () => {
		for (const pxPerSec of [0.2, 1, 7.5, 120]) {
			setTimelineScale(pxPerSec);
			const width = (newRegionDurationSec() as number) * pxPerSec;
			// Above the floor the duration is exactly PILL_CREATE_PX worth of time.
			expect(width).toBeCloseTo(PILL_CREATE_PX, 6);
		}
	});
});
