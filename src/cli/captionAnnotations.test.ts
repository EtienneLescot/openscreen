import { describe, expect, it } from "vitest";
import type { CaptionSegment } from "@/lib/captioning/transcribe";
import { captionSegmentsToAnnotationRegions } from "./captionAnnotations";

const words = (...texts: string[]): CaptionSegment[] =>
	texts.map((text, i) => ({ text, startSec: i * 0.5, endSec: i * 0.5 + 0.4 }));

describe("captionSegmentsToAnnotationRegions", () => {
	it("numbers ids and z-indexes from the given start, with non-empty spans", () => {
		const regions = captionSegmentsToAnnotationRegions(words("one", "two", "three", "four"), 7, 3);

		expect(regions.length).toBeGreaterThan(0);
		expect(regions.map((r) => r.id)).toEqual(regions.map((_, i) => `annotation-${7 + i}`));
		expect(regions.map((r) => r.zIndex)).toEqual(regions.map((_, i) => 3 + i));
		for (const region of regions) {
			expect(region.endMs).toBeGreaterThan(region.startMs);
			expect(region.annotationSource).toBe("auto-caption");
			expect(region.content.trim()).not.toBe("");
		}
	});

	it("groups phrase-granularity segments one line at a time", () => {
		const regions = captionSegmentsToAnnotationRegions(
			[
				{ text: "hello there", startSec: 0, endSec: 1 },
				{ text: "second line", startSec: 1.2, endSec: 2 },
			],
			1,
			1,
			{ timestampGranularity: "phrase" },
		);

		expect(regions.map((r) => r.content)).toEqual(["hello there", "second line"]);
	});
});
