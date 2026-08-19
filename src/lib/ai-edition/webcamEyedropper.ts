// Sampling the RAW camera pixel under the pointer, for the chroma-key colour picker.
//
// WHY THE RAW CAMERA AND NOT THE PREVIEW CANVAS. The preview canvas holds the
// COMPOSED frame — wallpaper, screen, camera, cursor, and (once the key is on)
// the key itself. Sampling it would feed the key its own output, so the second
// pick would never find the backdrop it just removed. The editor keeps a real
// `<video>` of the camera mounted at exactly the webcam rect (CSS-hidden, alive
// to drive decode: `NewEditorShell.module.css` `.webcamSlot .webcamVideo`), and
// that element is the un-keyed source.
//
// The geometry below inverts what CSS already did to that element:
// `object-fit: cover` (crop the long axis, never letterbox) and, when the user
// has mirroring on, `transform: scaleX(-1)`.

/** A box in any consistent unit — the slot's CSS size, or the video's natural size. */
export interface EyedropperBox {
	width: number;
	height: number;
}

/**
 * Slot-relative point (px from the slot's top-left) → pixel coordinates in the
 * video's own natural raster.
 *
 * `null` when the geometry is degenerate (zero-sized slot, or a video whose
 * metadata has not loaded so `videoWidth`/`videoHeight` are still 0) — the caller
 * treats that as "nothing to sample", not as the origin pixel.
 */
export function mapSlotPointToVideoPixel(
	point: { x: number; y: number },
	slot: EyedropperBox,
	video: EyedropperBox,
	mirrored: boolean,
): { x: number; y: number } | null {
	if (slot.width <= 0 || slot.height <= 0 || video.width <= 0 || video.height <= 0) {
		return null;
	}

	// Un-mirror FIRST, in slot space. `scaleX(-1)` flips the element about its own
	// vertical centre, so the pixel the user aimed at sits at the mirrored x — and
	// every step after this one is the same for both cases.
	const x = mirrored ? slot.width - point.x : point.x;
	const y = point.y;

	// `object-fit: cover` scales by the LARGER ratio so the box is filled, then
	// centres the overflow and clips it. Inverting it: divide out that scale, then
	// add back the half that was cropped off each side.
	const scale = Math.max(slot.width / video.width, slot.height / video.height);
	const shownWidth = video.width * scale;
	const shownHeight = video.height * scale;
	const cropX = (shownWidth - slot.width) / 2;
	const cropY = (shownHeight - slot.height) / 2;

	const videoX = (x + cropX) / scale;
	const videoY = (y + cropY) / scale;

	// Clamp rather than reject: a click exactly on the slot's right or bottom edge
	// lands one pixel past the raster after rounding, and refusing it would make the
	// border of the camera silently unpickable.
	return {
		x: clampIndex(videoX, video.width),
		y: clampIndex(videoY, video.height),
	};
}

function clampIndex(value: number, size: number): number {
	return Math.min(size - 1, Math.max(0, Math.floor(value)));
}

/** `[12, 200, 80]` → `"#0cc850"`. */
export function rgbToHex(r: number, g: number, b: number): string {
	const hex = (v: number) =>
		Math.min(255, Math.max(0, Math.round(v)))
			.toString(16)
			.padStart(2, "0");
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Reads one pixel out of a playing `<video>`, as `#rrggbb`. `null` if the frame
 * cannot be sampled.
 *
 * `getImageData` does not throw here: the editor window runs with
 * `webSecurity: false` (`electron/windows.ts`), so the `file://` source does not
 * taint the canvas. It is still wrapped — a browser-mode build serving assets
 * over http would taint, and a thrown SecurityError must degrade to "pick did
 * nothing" rather than tear down the editor.
 *
 * Note the colour comes from the BROWSER's YUV→RGB conversion while the shader
 * uses its own BT.709-limited matrix. Any mismatch is far smaller than one step
 * of the Similarity slider.
 */
export function sampleVideoPixelHex(
	video: HTMLVideoElement,
	at: { x: number; y: number },
): string | null {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return null;
		// Blit the single source pixel, rather than the whole frame followed by a
		// read at an offset: a 1x1 destination means the browser decodes and copies
		// one pixel, not a 1080p surface, on every click.
		ctx.drawImage(video, at.x, at.y, 1, 1, 0, 0, 1, 1);
		const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
		return rgbToHex(r, g, b);
	} catch {
		return null;
	}
}
