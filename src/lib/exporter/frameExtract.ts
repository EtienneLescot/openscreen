/**
 * Pulls composited pixels off the canvas as raw bytes for the native encoder.
 *
 * `new VideoFrame(canvas)` is LAZY — it does not read anything back; the
 * GPU->CPU descent happens inside copyTo(). Timing the constructor measures
 * nothing (that mistake is why the v2 spec originally blamed readback for a
 * cost it does not have).
 *
 * Chromium will only hand us BGRA here: copyTo({format: "NV12"}) throws
 * NotSupportedError. Packing to NV12 on the GPU before extraction is the next
 * step (3.0 MB/frame instead of 7.9, measured ~2x end to end) — see the v2
 * spec's Phase 4.
 */

export interface FrameLayoutPlane {
	offset: number;
	stride: number;
}

/**
 * Raw video has no stride: ffmpeg reads width*4 bytes per row, forever. If
 * Chromium ever pads rows, feeding the buffer through unchanged would skew
 * every frame into diagonal garbage — visibly broken, but only at runtime and
 * only on whatever machine pads. Fail loudly instead.
 */
export function assertTightBgraLayout(
	layout: readonly FrameLayoutPlane[],
	width: number,
	height: number,
	byteLength: number,
): void {
	if (layout.length !== 1) {
		throw new Error(`Expected 1 BGRA plane from the canvas, got ${layout.length}`);
	}
	const plane = layout[0];
	const tightStride = width * 4;
	if (plane.stride !== tightStride) {
		throw new Error(
			`Canvas frame is padded (stride ${plane.stride}, expected ${tightStride}). ` +
				"Raw video cannot carry stride; the frame would be skewed.",
		);
	}
	if (plane.offset !== 0) {
		throw new Error(`Canvas frame plane starts at ${plane.offset}, expected 0`);
	}
	const expected = tightStride * height;
	if (byteLength !== expected) {
		throw new Error(`Canvas frame is ${byteLength} bytes, expected ${expected}`);
	}
}

/**
 * Reusable extraction buffer. The frame is copied by IPC during send(), so the
 * caller may refill this as soon as the sink's write() resolves — which saves
 * allocating (and collecting) ~8 MB per frame.
 */
export class CanvasFrameExtractor {
	private buffer: ArrayBuffer | null = null;

	constructor(
		private readonly width: number,
		private readonly height: number,
	) {}

	/** BGRA is what Chromium yields from a canvas; ffmpeg is told to expect it. */
	readonly pixelFormat = "bgra" as const;

	async extract(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<ArrayBuffer> {
		const frame = new VideoFrame(canvas as HTMLCanvasElement, { timestamp: 0 });
		try {
			const size = frame.allocationSize();
			this.buffer ??= new ArrayBuffer(size);
			if (this.buffer.byteLength !== size) {
				// Output size is fixed for the whole export; a change here means the
				// renderer was reconfigured mid-flight and ffmpeg's -s is now wrong.
				throw new Error(
					`Frame size changed mid-export (${this.buffer.byteLength} -> ${size} bytes)`,
				);
			}
			const layout = await frame.copyTo(this.buffer);
			assertTightBgraLayout(layout, this.width, this.height, size);
			return this.buffer;
		} finally {
			frame.close();
		}
	}
}
