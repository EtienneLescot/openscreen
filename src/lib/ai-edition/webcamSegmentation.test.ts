// @vitest-environment jsdom
//
// The MediaPipe result channel is a SINGLE callback slot: `onResults` holds one
// listener and `send()` gives no way to tell two outstanding results apart. These
// tests pin the protocol that makes that safe — one listener for the segmenter's
// lifetime, one send in flight at a time, and every caller's promise settled
// exactly once — because getting it wrong strands a promise, and a stranded
// promise silently freezes the preview instead of failing.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (results: { image: unknown; segmentationMask: unknown }) => void;

/** Deliveries are queued so a test can control WHEN a send produces its result. */
const pendingSends: Array<() => void> = [];
let listener: Listener | null = null;
let sendCount = 0;

vi.mock("@mediapipe/selfie_segmentation", () => {
	class FakeSelfieSegmentation {
		setOptions() {
			// options do not affect the protocol under test
		}
		initialize() {
			return Promise.resolve();
		}
		onResults(fn: Listener) {
			listener = fn;
		}
		send() {
			sendCount += 1;
			pendingSends.push(() => {
				listener?.({
					image: makeSource(640, 360),
					segmentationMask: makeSource(256, 144),
				});
			});
			return Promise.resolve();
		}
	}
	return { SelfieSegmentation: FakeSelfieSegmentation };
});

/** Stand-in for a MediaPipe `GpuBuffer` — deliberately a DIFFERENT resolution for
 *  the mask than the image, which is the real behaviour of the landscape model. */
function makeSource(width: number, height: number) {
	const el = window.document.createElement("canvas");
	el.width = width;
	el.height = height;
	return el;
}

function flushOneSend() {
	const next = pendingSends.shift();
	next?.();
}

function makeVideo(width = 640, height = 360): HTMLVideoElement {
	const video = window.document.createElement("video");
	Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
	Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
	return video;
}

// jsdom has no 2D backend; a recording stub is enough since these tests assert on
// the promise protocol and the source rects, not on pixels.
interface DrawCall {
	args: unknown[];
}
const drawCalls: DrawCall[] = [];

function installCanvasStub() {
	HTMLCanvasElement.prototype.getContext = vi.fn(function stubGetContext(this: HTMLCanvasElement) {
		return {
			canvas: this,
			filter: "none",
			fillStyle: "",
			globalCompositeOperation: "source-over",
			save: () => undefined,
			restore: () => undefined,
			clearRect: () => undefined,
			fillRect: () => undefined,
			createLinearGradient: () => ({ addColorStop: () => undefined }),
			drawImage: (...args: unknown[]) => {
				drawCalls.push({ args });
			},
		};
	}) as unknown as HTMLCanvasElement["getContext"];
}

describe("renderSegmentedWebcam (MediaPipe result channel)", () => {
	beforeEach(() => {
		// `listener` is deliberately NOT reset: `getSelfieSegmenter` caches the segmenter,
		// so `onResults` is registered once for the whole file — which is the property
		// under test. Clearing it here would orphan every later delivery.
		drawCalls.length = 0;
		sendCount = 0;
		installCanvasStub();
	});

	it("resolves the caller's promise when MediaPipe delivers a result", async () => {
		const { renderSegmentedWebcam } = await import("./webcamSegmentation");
		const canvas = window.document.createElement("canvas");

		let settled = false;
		const done = renderSegmentedWebcam(makeVideo(), canvas, {
			mode: "blur",
			blurIntensity: 0.5,
		}).then(() => {
			settled = true;
		});

		// Let the queue reach `send()` before delivering.
		await vi.waitFor(() => expect(sendCount).toBe(1));
		expect(settled).toBe(false);
		flushOneSend();
		await done;
		expect(settled).toBe(true);
	});

	// The regression this file exists for: two overlapping calls used to share one
	// `onResults` slot, so the first caller's promise was never settled and the
	// preview's in-flight guard stayed stuck forever.
	it("settles BOTH promises when two renders overlap", async () => {
		const { renderSegmentedWebcam } = await import("./webcamSegmentation");
		const canvasA = window.document.createElement("canvas");
		const canvasB = window.document.createElement("canvas");

		const first = renderSegmentedWebcam(makeVideo(), canvasA, {
			mode: "transparent",
			blurIntensity: 0,
		});
		const second = renderSegmentedWebcam(makeVideo(), canvasB, {
			mode: "transparent",
			blurIntensity: 0,
		});

		// Sends are serialised: the second must not start until the first is delivered.
		await vi.waitFor(() => expect(sendCount).toBe(1));
		flushOneSend();
		await first;

		await vi.waitFor(() => expect(sendCount).toBe(2));
		flushOneSend();
		await second;

		await expect(Promise.all([first, second])).resolves.toBeDefined();
	});

	it("sizes the canvas to the crop and reads each source at its own resolution", async () => {
		const { renderSegmentedWebcam } = await import("./webcamSegmentation");
		const canvas = window.document.createElement("canvas");

		const done = renderSegmentedWebcam(makeVideo(640, 360), canvas, {
			mode: "transparent",
			blurIntensity: 0,
			crop: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 },
		});
		await vi.waitFor(() => expect(sendCount).toBe(1));
		flushOneSend();
		await done;

		expect(canvas.width).toBe(320);
		expect(canvas.height).toBe(180);

		// The mask is 256x144 while the image is 640x360, so a source rect computed from
		// the video's dimensions would read the wrong region out of the mask.
		const maskDraw = drawCalls.find(
			(c) => (c.args[0] as HTMLCanvasElement)?.width === 256 && c.args.length === 9,
		);
		const imageDraw = drawCalls.find(
			(c) => (c.args[0] as HTMLCanvasElement)?.width === 640 && c.args.length === 9,
		);
		expect(maskDraw?.args.slice(1, 5)).toEqual([64, 72, 128, 72]);
		expect(imageDraw?.args.slice(1, 5)).toEqual([160, 180, 320, 180]);
	});
});
