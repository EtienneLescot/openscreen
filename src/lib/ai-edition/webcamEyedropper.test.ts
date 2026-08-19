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
