// Neural background segmentation for webcam feed using Google MediaPipe SelfieSegmentation.
// Runs locally via WebGL/WASM in real-time.

import { type Results, SelfieSegmentation } from "@mediapipe/selfie_segmentation";
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat } from "mediabunny";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import {
	type CropRegion,
	DEFAULT_CROP_REGION,
	type WebcamBackgroundMode,
} from "@/components/video-editor/types";
import getAssetPath from "@/lib/assetPath";
import {
	getLinearGradientPoints,
	parseCssGradient,
	resolveLinearGradientAngle,
} from "@/lib/exporter/gradientParser";
import { classifyWallpaper, resolveImageWallpaperUrl } from "@/lib/wallpaper";
import type { CompositorClipInput } from "@/native/contracts";

let segmenterInstance: SelfieSegmentation | null = null;
let initPromise: Promise<SelfieSegmentation> | null = null;
let lastInitFailure: { at: number; error: unknown } | null = null;

/** Init is retryable, but the preview asks for a segmenter on every rAF tick — without a
 *  cooldown a persistent failure (missing WASM, no GPU) would construct a new
 *  `SelfieSegmentation` 60 times a second. */
const INIT_RETRY_COOLDOWN_MS = 5_000;

export function getSelfieSegmenter(): Promise<SelfieSegmentation> {
	if (segmenterInstance) return Promise.resolve(segmenterInstance);
	if (initPromise) return initPromise;
	if (lastInitFailure && Date.now() - lastInitFailure.at < INIT_RETRY_COOLDOWN_MS) {
		return Promise.reject(lastInitFailure.error);
	}

	const pending = new Promise<SelfieSegmentation>((resolve, reject) => {
		try {
			const segmenter = new SelfieSegmentation({
				// The renderer runs from `file://` in a packaged build, so a root-absolute
				// "/mediapipe/…" would resolve to the filesystem root and 404. `getAssetPath`
				// is the repo's one way to address `public/` from both dev (http) and packaged
				// (file:// + electronAPI.assetBaseUrl) — same path wallpapers take.
				locateFile: (file) => getAssetPath(`mediapipe/selfie_segmentation/${file}`),
			});

			segmenter.setOptions({
				modelSelection: 1, // 1 = landscape model (144x256), optimized for 16:9 webcam
				selfieMode: false,
			});

			// One listener for the lifetime of the segmenter. `onResults` holds a SINGLE
			// callback, so re-registering per frame lets a second caller overwrite the first
			// and strand its promise forever. Results are routed to whoever is at the head of
			// `sendQueue` instead.
			// Deliver to whoever is at the head of the queue; `settle` is what clears the
			// slot. (Clearing it HERE would make `settle`'s own identity guard fail and
			// strand every frame.) A second delivery for the same send finds an empty slot
			// and is ignored.
			segmenter.onResults((results) => {
				pendingResults?.(results);
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

	// A rejected `initPromise` cached forever makes the first failure permanent for the
	// session; clearing it lets a later call retry (the assets may just not have been
	// reachable yet), while `lastInitFailure` keeps that retry from spinning per frame.
	initPromise = pending.then(
		(segmenter) => {
			lastInitFailure = null;
			return segmenter;
		},
		(err) => {
			initPromise = null;
			lastInitFailure = { at: Date.now(), error: err };
			throw err;
		},
	);
	return initPromise;
}

export interface SegmentationRenderOptions {
	mode: WebcamBackgroundMode;
	blurIntensity: number;
	wallpaper?: string;
	/** Source sub-rect (fractions of the frame) to render, mirroring the native
	 *  `webcam_crop`. Omit during export: native applies the crop itself to the
	 *  pre-rendered track, and applying it here too would crop twice. */
	crop?: CropRegion;
}

/** Head of the single-slot result channel — see the `onResults` comment above. */
let pendingResults: ((results: Results | null) => void) | null = null;
/** Serialises `send()` calls: MediaPipe has one result channel, so two overlapping
 *  sends cannot be told apart. Preview rAF, seek re-renders and the export loop all
 *  queue here. */
let sendQueue: Promise<unknown> = Promise.resolve();

/** A frame MediaPipe silently drops would otherwise wedge the queue for good. */
const SEGMENTATION_TIMEOUT_MS = 10_000;

function runSegmentation(video: HTMLVideoElement): Promise<Results | null> {
	const run = sendQueue.then(async () => {
		const segmenter = await getSelfieSegmenter();
		return new Promise<Results | null>((resolve) => {
			const settle = (results: Results | null) => {
				if (pendingResults !== settle) return;
				pendingResults = null;
				clearTimeout(timer);
				resolve(results);
			};
			const timer = setTimeout(() => {
				console.warn("[WebcamSegmentation] segmentation timed out; dropping frame");
				settle(null);
			}, SEGMENTATION_TIMEOUT_MS);
			pendingResults = settle;
			segmenter.send({ image: video }).catch((err) => {
				console.warn("[WebcamSegmentation] segmenter.send failed:", err);
				settle(null);
			});
		});
	});
	// Keep the queue alive even when one run rejects, or every later frame is dropped.
	sendQueue = run.catch(() => undefined);
	return run;
}

/** Source sub-rect in a `GpuBuffer`'s OWN pixels. The mask comes back at the model's
 *  resolution (144x256 for the landscape model), not the video's, so a rect computed
 *  from `video.videoWidth` would crop the wrong region out of it. */
function sourceRect(src: Results["image"], crop: CropRegion): [number, number, number, number] {
	const iw = "naturalWidth" in src ? src.naturalWidth : src.width;
	const ih = "naturalHeight" in src ? src.naturalHeight : src.height;
	return [
		Math.round(crop.x * iw),
		Math.round(crop.y * ih),
		Math.max(1, Math.round(crop.width * iw)),
		Math.max(1, Math.round(crop.height * ih)),
	];
}

let tempCanvas: HTMLCanvasElement | null = null;
let tempCtx: CanvasRenderingContext2D | null = null;

function getTempCanvas(
	width: number,
	height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
	if (!tempCanvas) {
		tempCanvas = document.createElement("canvas");
		tempCtx = tempCanvas.getContext("2d", { willReadFrequently: false });
	}
	if (!tempCtx) return null;
	if (tempCanvas.width !== width || tempCanvas.height !== height) {
		tempCanvas.width = width;
		tempCanvas.height = height;
	}
	return { canvas: tempCanvas, ctx: tempCtx };
}

const wallpaperImageCache = new Map<string, HTMLImageElement>();

/** Loads (and caches) an image wallpaper. Resolves to null when the path is
 *  unsafe or the file cannot be decoded — the caller then leaves the background
 *  unpainted rather than failing the whole render. */
async function loadWallpaperImage(path: string): Promise<HTMLImageElement | null> {
	const cached = wallpaperImageCache.get(path);
	if (cached) return cached;
	let url: string;
	try {
		url = resolveImageWallpaperUrl(path);
	} catch (err) {
		console.warn("[WebcamSegmentation] Unusable image wallpaper:", err);
		return null;
	}
	return new Promise<HTMLImageElement | null>((resolve) => {
		const img = new Image();
		img.onload = () => {
			wallpaperImageCache.set(path, img);
			resolve(img);
		};
		img.onerror = () => resolve(null);
		img.src = url;
	});
}

/**
 * Paints a wallpaper string behind the subject, covering `w`x`h`.
 *
 * Dispatches through `classifyWallpaper` — the same classifier the picker and the
 * scene description use — so every value the UI can produce (colour, gradient,
 * bundled `/wallpapers/…` path, uploaded `data:` URL) reaches the encoded track.
 * A raw `startsWith("#")` test silently dropped gradients and images, which then
 * exported as black.
 */
type BackgroundPainter = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

/**
 * Resolves a wallpaper string into a SYNCHRONOUS painter.
 *
 * Async work (decoding an image wallpaper) happens here, before the segmentation
 * result is in hand, so that everything after it — which writes the shared module-level
 * `tempCanvas` — runs without an await that another render could interleave into.
 *
 * Dispatches through `classifyWallpaper`, the same classifier the picker and the scene
 * description use, so every value the UI can produce (colour, gradient, bundled
 * `/wallpapers/…` path, uploaded `data:` URL) reaches the encoded track. A raw
 * `startsWith("#")` test silently dropped gradients and images, which exported as black.
 */
async function resolveBackgroundPainter(wallpaper: string): Promise<BackgroundPainter | null> {
	const classified = classifyWallpaper(wallpaper);

	if (classified.kind === "color") {
		return (ctx, w, h) => {
			ctx.fillStyle = classified.value;
			ctx.fillRect(0, 0, w, h);
		};
	}

	if (classified.kind === "gradient") {
		const parsed = parseCssGradient(classified.value);
		if (!parsed || parsed.stops.length === 0) return null;
		// Same angle convention the native gradient uses (0deg = up, 90deg = right).
		const angle = resolveLinearGradientAngle(parsed.descriptor);
		return (ctx, w, h) => {
			const { x0, y0, x1, y1 } = getLinearGradientPoints(angle, w, h);
			const grad = ctx.createLinearGradient(x0, y0, x1, y1);
			for (const stop of parsed.stops) {
				grad.addColorStop(Math.min(1, Math.max(0, stop.offset)), stop.color);
			}
			ctx.fillStyle = grad;
			ctx.fillRect(0, 0, w, h);
		};
	}

	const img = await loadWallpaperImage(classified.path);
	if (!img?.naturalWidth || !img.naturalHeight) return null;
	return (ctx, w, h) => {
		// cover-fit, matching `draw_image_bg` on the native side.
		const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
		const dw = img.naturalWidth * scale;
		const dh = img.naturalHeight * scale;
		ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
	};
}

/**
 * Applies neural segmentation on the given video frame and renders into outputCanvas.
 *
 * Returns false when nothing was drawn (frame not ready, no 2D context, or MediaPipe
 * dropped the frame). The live preview can ignore that — it will try again next tick —
 * but the export MUST NOT, or a dropped frame is silently encoded as a duplicate of the
 * previous one (or a blank first frame).
 */
export async function renderSegmentedWebcam(
	video: HTMLVideoElement,
	outputCanvas: HTMLCanvasElement,
	options: SegmentationRenderOptions,
): Promise<boolean> {
	if (video.videoWidth === 0 || video.videoHeight === 0) return false;

	const outCtx = outputCanvas.getContext("2d");
	if (!outCtx) return false;

	// The native path crops first and cover-fits afterwards; CSS `object-fit: cover` on
	// the canvas supplies that second step, so honouring the crop here is what makes
	// preview and export agree.
	const crop = options.crop ?? DEFAULT_CROP_REGION;
	const w = Math.max(1, Math.round(crop.width * video.videoWidth));
	const h = Math.max(1, Math.round(crop.height * video.videoHeight));

	if (outputCanvas.width !== w || outputCanvas.height !== h) {
		outputCanvas.width = w;
		outputCanvas.height = h;
	}

	// Resolved BEFORE the segmentation await so the drawing section below — which owns
	// the shared `tempCanvas` — contains no await for another render to interleave into.
	const paintBackground =
		options.mode === "custom" && options.wallpaper
			? await resolveBackgroundPainter(options.wallpaper)
			: null;

	const results = await runSegmentation(video);
	if (!results) return false;

	const temp = getTempCanvas(w, h);
	if (!temp) return false;
	const { canvas: maskCanvas, ctx: maskCtx } = temp;

	const imageRect = sourceRect(results.image, crop);
	const maskRect = sourceRect(results.segmentationMask, crop);
	const drawCropped = (
		ctx: CanvasRenderingContext2D,
		src: Results["image"],
		[rx, ry, rw, rh]: readonly [number, number, number, number],
	) => {
		ctx.drawImage(src, rx, ry, rw, rh, 0, 0, w, h);
	};

	// The cut-out subject: the mask carries the alpha, `source-in` keeps only the
	// video pixels that fall inside it. Identical in all three modes.
	const drawCutout = () => {
		maskCtx.save();
		maskCtx.clearRect(0, 0, w, h);
		drawCropped(maskCtx, results.segmentationMask, maskRect);
		maskCtx.globalCompositeOperation = "source-in";
		drawCropped(maskCtx, results.image, imageRect);
		maskCtx.restore();
	};

	outCtx.save();
	outCtx.clearRect(0, 0, w, h);

	if (options.mode === "transparent") {
		drawCutout();
		outCtx.drawImage(maskCanvas, 0, 0, w, h);
	} else if (options.mode === "blur") {
		const intensity = typeof options.blurIntensity === "number" ? options.blurIntensity : 0.5;
		const blurPx = Math.round(Math.min(1, Math.max(0, intensity)) * 25);
		if (blurPx > 0) {
			outCtx.filter = `blur(${blurPx}px)`;
		}
		drawCropped(outCtx, results.image, imageRect);
		outCtx.filter = "none";

		drawCutout();
		outCtx.drawImage(maskCanvas, 0, 0, w, h);
	} else if (options.mode === "custom") {
		paintBackground?.(outCtx, w, h);

		drawCutout();
		outCtx.drawImage(maskCanvas, 0, 0, w, h);
	}

	outCtx.restore();
	return true;
}

/** Rejects once `ms` elapses, so a seek or a decode that never settles fails the
 *  export instead of hanging it. */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		}),
	]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const SEEK_TIMEOUT_MS = 15_000;

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

	await withTimeout(
		new Promise<void>((resolve, reject) => {
			video.onloadedmetadata = () => resolve();
			video.onerror = () => reject(new Error("Failed to load webcam video metadata"));
		}),
		SEEK_TIMEOUT_MS,
		"Timed out loading webcam video metadata",
	);

	const width = video.videoWidth || 1280;
	const height = video.videoHeight || 720;
	// MediaRecorder WebM files report `Infinity` when the Duration header is missing
	// (see `repairRecordingContainer`, which patches it only for streamed takes). It is
	// truthy, so `|| 1` let it through and the frame loop below never terminated.
	const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
	if (duration <= 0) {
		throw new Error(
			"Webcam track has no usable duration, so the background effect cannot be pre-rendered",
		);
	}
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
		...(isTransparent ? { alpha: "keep" as const } : {}),
	});

	output.addVideoTrack(videoSource);
	await output.start();

	// The crop is deliberately NOT forwarded: native applies `webcam_crop` to this
	// pre-rendered track itself, and cropping here too would apply it twice.
	const renderOptions: SegmentationRenderOptions = { ...options, crop: undefined };

	let sourceClosed = false;
	try {
		for (let i = 0; i < totalFrames; i++) {
			const time = i / fps;
			await withTimeout(
				new Promise<void>((resolve, reject) => {
					video.onseeked = () => resolve();
					video.onerror = () => reject(new Error(`Failed to decode webcam frame at ${time}s`));
					video.currentTime = time;
				}),
				SEEK_TIMEOUT_MS,
				`Timed out seeking the webcam track to ${time}s`,
			);

			const drawn = await renderSegmentedWebcam(video, canvas, renderOptions);
			if (!drawn) {
				throw new Error(`Background segmentation produced no frame at ${time.toFixed(2)}s`);
			}
			await videoSource.add(time, 1 / fps);
			onProgress?.((i + 1) / totalFrames);
		}
		// Close BEFORE finalize: the muxer flushes a source that is done, not one that
		// might still receive frames.
		videoSource.close();
		sourceClosed = true;
		await output.finalize();
	} finally {
		// The encoder and the decoding <video> hold native resources; an aborted export
		// must not strand them.
		if (!sourceClosed) videoSource.close();
		video.removeAttribute("src");
		video.load();
	}

	const buffer = target.buffer;
	if (!buffer) {
		throw new Error("Failed to encode segmented webcam video buffer");
	}

	const ext = isTransparent ? "webm" : "mp4";
	const fileName = `webcam-segmented-${Date.now()}.${ext}`;
	const res = await window.electronAPI?.writeDerivedMedia?.(buffer, fileName);
	if (!res?.success || typeof res.path !== "string") {
		// Falling back to the bare file name handed the native exporter a relative
		// path it resolves against the process CWD — an unrelated "cannot open input"
		// or a silently webcam-less export.
		throw new Error(res?.message ?? res?.error ?? "Failed to store the pre-rendered webcam track");
	}
	return res.path;
}

/**
 * Pre-renders every distinct webcam track a clip list references and returns the list with
 * `webcamPath` pointing at the segmented copies.
 *
 * Shared by `ExportDialog` and `CliExportRunner`: both used to carry their own copy of this
 * loop, which is exactly the divergence `resolveVisibleClips` was introduced to stop for the
 * clip list itself.
 */
export async function applySegmentedWebcamTracks(
	clips: CompositorClipInput[],
	options: SegmentationRenderOptions,
	onProgress?: (progress: number) => void,
): Promise<CompositorClipInput[]> {
	if (options.mode === "none") return clips;

	// Distinct tracks first, so per-track progress can be scaled into one 0..1 sweep
	// instead of restarting at 0 for every track.
	const sourcePaths = [...new Set(clips.map((clip) => clip.webcamPath).filter(Boolean))];
	const processedByPath = new Map<string, string>();
	for (const [index, sourcePath] of sourcePaths.entries()) {
		const processedPath = await prepareSegmentedWebcamTrack(sourcePath, options, (prog) =>
			onProgress?.((index + prog) / sourcePaths.length),
		);
		processedByPath.set(sourcePath, processedPath);
	}

	return clips.map((clip) => {
		const processed = clip.webcamPath ? processedByPath.get(clip.webcamPath) : undefined;
		return processed ? { ...clip, webcamPath: processed } : clip;
	});
}
