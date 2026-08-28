import { describe, expect, it } from "vitest";
import { mapSlotPointToVideoPixel, rgbToHex } from "./webcamEyedropper";

// A 16:9 camera in a square slot — the `circle`/`square` mask shapes, where
// `object-fit: cover` crops the WIDTH. The other orientation (a 16:9 camera in a
// wide slot) crops the HEIGHT, and both are exercised below: a mapping that only
// handled one axis would still pass a single-orientation test.
const CAMERA = { width: 1280, height: 720 };

describe("mapSlotPointToVideoPixel", () => {
	it("maps the slot centre to the camera centre, whatever gets cropped", () => {
		for (const slot of [
			{ width: 300, height: 300 }, // square slot: crops width
			{ width: 400, height: 100 }, // wide slot: crops height
			{ width: 320, height: 180 }, // exact ratio: crops nothing
		]) {
			const at = mapSlotPointToVideoPixel(
				{ x: slot.width / 2, y: slot.height / 2 },
				slot,
				CAMERA,
				false,
			);
			expect(at).not.toBeNull();
			expect(at?.x).toBe(CAMERA.width / 2);
			expect(at?.y).toBe(CAMERA.height / 2);
		}
	});

	it("accounts for the width cropped off a square slot", () => {
		// scale = max(300/1280, 300/720) = 300/720. Shown width = 1280*300/720
		// = 533.33, so 116.67px is cropped off each side. The slot's left edge is
		// therefore camera x = 116.67/scale = 280, not 0.
		const at = mapSlotPointToVideoPixel({ x: 0, y: 0 }, { width: 300, height: 300 }, CAMERA, false);
		expect(at?.x).toBe(280);
		expect(at?.y).toBe(0);
	});

	it("mirrors horizontally without touching the vertical axis", () => {
		const slot = { width: 320, height: 180 }; // exact ratio: no crop, so the
		// mirror is the only transform in play and the arithmetic is checkable.
		const plain = mapSlotPointToVideoPixel({ x: 80, y: 45 }, slot, CAMERA, false);
		const mirrored = mapSlotPointToVideoPixel({ x: 80, y: 45 }, slot, CAMERA, true);
		expect(plain?.x).toBe(320);
		// 320 - 80 = 240 slot px → 240 * (1280/320) = 960.
		expect(mirrored?.x).toBe(960);
		expect(mirrored?.y).toBe(plain?.y);
	});

	it("keeps the far edges inside the raster", () => {
		// A click exactly on the right/bottom edge rounds one pixel past the end.
		// Clamping rather than rejecting is what keeps the camera's border pickable.
		const slot = { width: 320, height: 180 };
		const at = mapSlotPointToVideoPixel({ x: slot.width, y: slot.height }, slot, CAMERA, false);
		expect(at).toEqual({ x: CAMERA.width - 1, y: CAMERA.height - 1 });
	});

	it("returns null on degenerate geometry instead of the origin pixel", () => {
		// `videoWidth`/`videoHeight` are 0 until metadata loads; sampling then
		// would silently key on the top-left pixel of nothing.
		expect(
			mapSlotPointToVideoPixel(
				{ x: 5, y: 5 },
				{ width: 300, height: 300 },
				{
					width: 0,
					height: 0,
				},
				false,
			),
		).toBeNull();
		expect(
			mapSlotPointToVideoPixel({ x: 5, y: 5 }, { width: 0, height: 300 }, CAMERA, false),
		).toBeNull();
	});

	// The webcam crop (zoom + pan) landed after the eyedropper did. The element the
	// user picks from carries the crop as an `object-view-box`, so the pick has to
	// invert it too — otherwise the sample drifts further from the pointer the more
	// the camera is zoomed, which is the failure that looks like "the key picked the
	// wrong green".
	it("defaults to the full frame, so an unzoomed pick is unchanged", () => {
		const slot = { width: 320, height: 180 };
		const implicit = mapSlotPointToVideoPixel({ x: 80, y: 45 }, slot, CAMERA, false);
		const explicit = mapSlotPointToVideoPixel({ x: 80, y: 45 }, slot, CAMERA, false, {
			x: 0,
			y: 0,
			width: 1,
			height: 1,
		});
		expect(explicit).toEqual(implicit);
	});

	it("samples inside the crop window when the camera is zoomed", () => {
		// A 2x zoom centred on the frame: the window is the middle half of the raster,
		// x 320..960 and y 180..540. The slot has the window's ratio (640:360), so
		// cover crops nothing and the mapping is a straight scale within the window.
		const slot = { width: 320, height: 180 };
		const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
		// Slot centre → window centre → raster centre, because this crop is centred.
		expect(mapSlotPointToVideoPixel({ x: 160, y: 90 }, slot, CAMERA, false, crop)).toEqual({
			x: 640,
			y: 360,
		});
		// The slot's ORIGIN is the window's origin, not the raster's — this is the
		// assertion that fails if the crop offset is dropped.
		expect(mapSlotPointToVideoPixel({ x: 0, y: 0 }, slot, CAMERA, false, crop)).toEqual({
			x: 320,
			y: 180,
		});
	});

	it("follows the pan, not just the zoom", () => {
		// Same 2x window, panned hard to the bottom-right: it now covers x 640..1280
		// and y 360..720, so the same click lands 320px further along each axis.
		const slot = { width: 320, height: 180 };
		const crop = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
		expect(mapSlotPointToVideoPixel({ x: 0, y: 0 }, slot, CAMERA, false, crop)).toEqual({
			x: 640,
			y: 360,
		});
	});

	it("mirrors within the crop window rather than the whole raster", () => {
		// Mirroring flips the element, and the element shows the WINDOW — so the far
		// edge of a panned window maps to that window's other edge, never the raster's.
		const slot = { width: 320, height: 180 };
		const crop = { x: 0.5, y: 0, width: 0.5, height: 0.5 };
		const at = mapSlotPointToVideoPixel({ x: 0, y: 0 }, slot, CAMERA, true, crop);
		// Un-mirrored, x=0 reads the window's RIGHT edge: 640 + 640 - 1, clamped.
		expect(at?.x).toBe(1279);
		expect(at?.y).toBe(0);
	});

	it("returns null for a degenerate crop instead of dividing by zero", () => {
		expect(
			mapSlotPointToVideoPixel({ x: 5, y: 5 }, { width: 320, height: 180 }, CAMERA, false, {
				x: 0,
				y: 0,
				width: 0,
				height: 0,
			}),
		).toBeNull();
	});
});

describe("rgbToHex", () => {
	it("pads each channel to two digits", () => {
		expect(rgbToHex(0, 177, 64)).toBe("#00b140");
		expect(rgbToHex(0, 0, 0)).toBe("#000000");
		expect(rgbToHex(255, 255, 255)).toBe("#ffffff");
	});

	it("rounds and clamps out-of-range channels", () => {
		expect(rgbToHex(-5, 300, 127.6)).toBe("#00ff80");
	});
});
