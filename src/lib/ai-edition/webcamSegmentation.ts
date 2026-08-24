// Neural background segmentation for webcam feed using Google MediaPipe SelfieSegmentation.
// Runs locally via WebGL/WASM in real-time.

import { SelfieSegmentation } from "@mediapipe/selfie_segmentation";
import type { WebcamBackgroundMode } from "@/components/video-editor/types";

let segmenterInstance: SelfieSegmentation | null = null;
let initPromise: Promise<SelfieSegmentation> | null = null;

export function getSelfieSegmenter(): Promise<SelfieSegmentation> {
	if (segmenterInstance) return Promise.resolve(segmenterInstance);
	if (initPromise) return initPromise;

	initPromise = new Promise<SelfieSegmentation>((resolve, reject) => {
		try {
			const segmenter = new SelfieSegmentation({
				locateFile: (file) => {
					// In Vite dev & Electron build, assets are in /mediapipe/selfie_segmentation/
					return `/mediapipe/selfie_segmentation/${file}`;
				},
			});

			segmenter.setOptions({
				modelSelection: 1, // 1 = landscape model (144x256), optimized for 16:9 webcam
				selfieMode: false,
			});

			segmenter
				.initialize()
				.then(() => {
					segmenterInstance = segmenter;
					resolve(segmenter);
				})
				.catch((err) => {
					console.error("[WebcamSegmentation] Failed to initialize MediaPipe:", err);
					reject(err);
				});
		} catch (e) {
			console.error("[WebcamSegmentation] Error creating SelfieSegmentation:", e);
			reject(e);
		}
	});

	return initPromise;
}

export interface SegmentationRenderOptions {
	mode: WebcamBackgroundMode;
	blurIntensity: number;
	threshold?: number;
	feather?: number;
	wallpaper?: string;
}

let tempCanvas: HTMLCanvasElement | null = null;
let tempCtx: CanvasRenderingContext2D | null = null;

function getTempCanvas(
	width: number,
	height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
	if (!tempCanvas) {
		tempCanvas = document.createElement("canvas");
		tempCtx = tempCanvas.getContext("2d", { willReadFrequently: false });
	}
	if (tempCanvas.width !== width || tempCanvas.height !== height) {
		tempCanvas.width = width;
		tempCanvas.height = height;
	}
	return { canvas: tempCanvas, ctx: tempCtx! };
}

/**
 * Applies neural segmentation on the given video frame and renders into outputCanvas.
 */
export async function renderSegmentedWebcam(
	video: HTMLVideoElement,
	outputCanvas: HTMLCanvasElement,
	options: SegmentationRenderOptions,
): Promise<void> {
	if (video.videoWidth === 0 || video.videoHeight === 0) return;

	const segmenter = await getSelfieSegmenter();
	const outCtx = outputCanvas.getContext("2d");
	if (!outCtx) return;

	const w = video.videoWidth;
	const h = video.videoHeight;

	if (outputCanvas.width !== w || outputCanvas.height !== h) {
		outputCanvas.width = w;
		outputCanvas.height = h;
	}

	return new Promise((resolve) => {
		segmenter.onResults((results) => {
			const { canvas: maskCanvas, ctx: maskCtx } = getTempCanvas(w, h);

			outCtx.save();
			outCtx.clearRect(0, 0, w, h);

			if (options.mode === "transparent") {
				// 1. Draw segmentation mask to temp canvas
				maskCtx.save();
				maskCtx.clearRect(0, 0, w, h);
				maskCtx.drawImage(results.segmentationMask, 0, 0, w, h);
				// 2. Composite video on top of mask
				maskCtx.globalCompositeOperation = "source-in";
				maskCtx.drawImage(results.image, 0, 0, w, h);
				maskCtx.restore();

				// 3. Draw cut out person to output
				outCtx.drawImage(maskCanvas, 0, 0, w, h);
			} else if (options.mode === "blur") {
				// 1. Draw blurred background
				const intensity = typeof options.blurIntensity === "number" ? options.blurIntensity : 0.5;
				const blurPx = Math.round(intensity * 25);
				if (blurPx > 0) {
					outCtx.filter = `blur(${blurPx}px)`;
				}
				outCtx.drawImage(results.image, 0, 0, w, h);
				outCtx.filter = "none";

				// 2. Mask the sharp person
				maskCtx.save();
				maskCtx.clearRect(0, 0, w, h);
				maskCtx.drawImage(results.segmentationMask, 0, 0, w, h);
				maskCtx.globalCompositeOperation = "source-in";
				maskCtx.drawImage(results.image, 0, 0, w, h);
				maskCtx.restore();

				// 3. Composite person over blurred background
				outCtx.drawImage(maskCanvas, 0, 0, w, h);
			} else if (options.mode === "custom") {
				// 1. Draw custom background behind the person
				if (options.wallpaper) {
					if (options.wallpaper.startsWith("#") || options.wallpaper.startsWith("rgb")) {
						outCtx.fillStyle = options.wallpaper;
						outCtx.fillRect(0, 0, w, h);
					}
				}

				// 2. Draw person cut out to temp canvas
				maskCtx.save();
				maskCtx.clearRect(0, 0, w, h);
				maskCtx.drawImage(results.segmentationMask, 0, 0, w, h);
				maskCtx.globalCompositeOperation = "source-in";
				maskCtx.drawImage(results.image, 0, 0, w, h);
				maskCtx.restore();

				// 3. Draw cut out person over the custom background
				outCtx.drawImage(maskCanvas, 0, 0, w, h);
			}

			outCtx.restore();
			resolve();
		});

		segmenter.send({ image: video }).catch((err) => {
			console.warn("[WebcamSegmentation] segmenter.send failed:", err);
			resolve();
		});
	});
}

import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat } from "mediabunny";
import { toFileUrl } from "@/components/video-editor/projectPersistence";

/**
 * Pre-renders and encodes the full webcam video track using MediaPipe neural segmentation
 * so that native export (MP4 / GIF) has 100% pixel-parity with live preview (SSOT).
 */
export async function prepareSegmentedWebcamTrack(
	webcamSourcePath: string,
	options: SegmentationRenderOptions,
	onProgress?: (progress: number) => void,
): Promise<string> {
	await getSelfieSegmenter();

	const video = document.createElement("video");
	video.src = toFileUrl(webcamSourcePath);
	video.muted = true;
	video.playsInline = true;
	video.crossOrigin = "anonymous";

	await new Promise<void>((resolve, reject) => {
		video.onloadedmetadata = () => resolve();
		video.onerror = () => reject(new Error("Failed to load webcam video metadata"));
	});

	const width = video.videoWidth || 1280;
	const height = video.videoHeight || 720;
	const duration = video.duration || 1;
	const fps = 30;
	const totalFrames = Math.max(1, Math.round(duration * fps));

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;

	const isTransparent = options.mode === "transparent";
	const target = new BufferTarget();
	const output = new Output({
		format: isTransparent ? new WebMOutputFormat() : new Mp4OutputFormat(),
		target,
	});

	const videoSource = new CanvasSource(canvas, {
		codec: isTransparent ? "vp9" : "avc",
		bitrate: 4_000_000,
		width,
		height,
		...(isTransparent ? { alpha: "keep" as const } : {}),
	});

	output.addTrack(videoSource);
	await output.start();

	for (let i = 0; i < totalFrames; i++) {
		const time = i / fps;
		video.currentTime = time;
		await new Promise<void>((resolve) => {
			video.onseeked = () => resolve();
		});

		await renderSegmentedWebcam(video, canvas, options);
		await videoSource.add(time, 1 / fps);
		onProgress?.((i + 1) / totalFrames);
	}

	videoSource.close();
	await output.finalize();

	const buffer = target.buffer;
	if (!buffer) {
		throw new Error("Failed to encode segmented webcam video buffer");
	}

	const ext = isTransparent ? "webm" : "mp4";
	const fileName = `webcam-segmented-${Date.now()}.${ext}`;
	const res = (await window.electronAPI?.storeRecordedVideo?.(buffer, fileName)) as
		| { success?: boolean; path?: string }
		| undefined;
	if (res && typeof res === "object" && typeof res.path === "string") {
		return res.path;
	}
	return fileName;
}
