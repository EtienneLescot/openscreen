// @vitest-environment jsdom
/**
 * `sampleVideoPixelHex` is the half of the eyedropper that touches the DOM, so it
 * lives in its own jsdom file rather than dragging `webcamEyedropper.test.ts` —
 * pure coordinate maths — into a DOM environment it does not need.
 *
 * jsdom ships no 2D context (it returns `null` without the optional `canvas`
 * package), so the context is stubbed. That is not a weaker test than a real one
 * would be: what this function owns is the 1×1 blit, the channel order, and the
 * failure paths, and all three are observable at the stub boundary.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleVideoPixelHex } from "./webcamEyedropper";

type Ctx = {
	drawImage: ReturnType<typeof vi.fn>;
	getImageData: ReturnType<typeof vi.fn>;
};

/** Make every `<canvas>` created by the function under test hand back `ctx`. */
function stubContext(ctx: Ctx | null) {
	return vi
		.spyOn(HTMLCanvasElement.prototype, "getContext")
		.mockReturnValue(ctx as unknown as CanvasRenderingContext2D | null);
}

function pixel(r: number, g: number, b: number): Ctx {
	return {
		drawImage: vi.fn(),
		getImageData: vi.fn(() => ({ data: Uint8ClampedArray.from([r, g, b, 255]) })),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sampleVideoPixelHex", () => {
	it("returns the sampled pixel as #rrggbb", () => {
		stubContext(pixel(0, 177, 64));
		const video = document.createElement("video");
		expect(sampleVideoPixelHex(video, { x: 12, y: 34 })).toBe("#00b140");
	});

	it("copies one source pixel into a 1x1 canvas, not the whole frame", () => {
		// The reason the destination is 1x1: a click on a 4K camera must not make the
		// browser decode and copy a 4K surface. Asserting the crop rect also pins the
		// argument order — a transposed pair samples the wrong pixel and still returns
		// a plausible colour, which is the bug that would otherwise ship silently.
		const ctx = pixel(10, 20, 30);
		stubContext(ctx);
		const video = document.createElement("video");

		sampleVideoPixelHex(video, { x: 640, y: 360 });

		expect(ctx.drawImage).toHaveBeenCalledWith(video, 640, 360, 1, 1, 0, 0, 1, 1);
		expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 1, 1);
	});

	it("sizes the scratch canvas to a single pixel", () => {
		const created: HTMLCanvasElement[] = [];
		const realCreate = document.createElement.bind(document);
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
			const el = realCreate(tag);
			if (tag === "canvas") created.push(el as HTMLCanvasElement);
			return el;
		}) as typeof document.createElement);
		stubContext(pixel(0, 0, 0));

		sampleVideoPixelHex(realCreate("video") as HTMLVideoElement, { x: 0, y: 0 });

		expect(created).toHaveLength(1);
		expect([created[0].width, created[0].height]).toEqual([1, 1]);
	});

	it("returns null when no 2D context is available", () => {
		// Not hypothetical: a context request fails under memory pressure and in any
		// environment without canvas support. The pick must do nothing, not throw.
		stubContext(null);
		expect(sampleVideoPixelHex(document.createElement("video"), { x: 0, y: 0 })).toBeNull();
	});

	it("returns null when the read throws instead of tearing down the editor", () => {
		// A tainted canvas (browser-mode build serving assets over http) makes
		// `getImageData` throw a SecurityError mid-click.
		const ctx = pixel(0, 0, 0);
		ctx.getImageData = vi.fn(() => {
			throw new DOMException("tainted", "SecurityError");
		});
		stubContext(ctx);
		expect(sampleVideoPixelHex(document.createElement("video"), { x: 1, y: 1 })).toBeNull();
	});

	it("returns null when the frame cannot be drawn", () => {
		// `drawImage` throws on a video with no decoded frame yet.
		const ctx = pixel(0, 0, 0);
		ctx.drawImage = vi.fn(() => {
			throw new DOMException("no frame", "InvalidStateError");
		});
		stubContext(ctx);
		expect(sampleVideoPixelHex(document.createElement("video"), { x: 1, y: 1 })).toBeNull();
	});
});
