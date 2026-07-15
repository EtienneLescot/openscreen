import type {
	AnnotationRegion,
	CameraFullscreenRegion,
	CropRegion,
	SpeedRegion,
	TrimRegion,
	WebcamLayoutPreset,
	WebcamSizePreset,
	ZoomRegion,
} from "@/components/video-editor/types";
import { assembleConcatenatedPcm } from "@/lib/ai-edition/exporter/audioConcatAssembler";
import { buildAudioConcatPlan } from "@/lib/ai-edition/exporter/audioConcatPlan";
import type { RenderPlan, RenderSegment } from "@/lib/ai-edition/exporter/renderPlan";
import { BackgroundLoadError } from "@/lib/wallpaper";
import type { CursorRecordingData } from "@/native/contracts";
import { getPlatform } from "@/utils/platformUtils";
import { AudioProcessor, downmixPlanarChannelsForExport } from "./audioEncoder";
import { FrameRenderer } from "./frameRenderer";
import { materializeLocalSourceFile, releaseLocalSourceFile } from "./localSourceFile";
import { VideoMuxer, videoCodecFamily } from "./muxer";
import { MAX_IN_MEMORY_SOURCE_BYTES } from "./sourceFileLimits";
import { StreamingVideoDecoder } from "./streamingDecoder";
import { TimestampedVideoFrameQueue } from "./timestampedVideoFrameQueue";
import type { ExportConfig, ExportProgress, ExportResult } from "./types";

const ENCODER_STALL_TIMEOUT_MS = 15_000;
const ENCODER_FLUSH_TIMEOUT_MS = 20_000;

/**
 * Waits for the encoder's queue to drain below maxEncodeQueue before returning.
 *
 * The stall timer starts fresh on each call (not from the encoder's last output), so a
 * long gap before this call — e.g. the decoder discarding frames inside a trim region —
 * doesn't get blamed on the encoder once real frames resume.
 */
export async function waitForEncoderQueueSpace(params: {
	getQueueSize: () => number;
	maxEncodeQueue: number;
	isCancelled: () => boolean;
	encoderPreference: HardwareAcceleration;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
	const now = params.now ?? Date.now;
	const sleep = params.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

	const stallWaitStartAt = now();
	while (params.getQueueSize() >= params.maxEncodeQueue && !params.isCancelled()) {
		if (now() - stallWaitStartAt > ENCODER_STALL_TIMEOUT_MS) {
			throw new Error(
				params.encoderPreference === "prefer-hardware"
					? "The hardware video encoder stopped responding. Retrying with a safer encoder."
					: "The video encoder stopped responding during export.",
			);
		}
		await sleep(5);
	}
}

/** One clip's crop, in SOURCE-media time — the export renderer switches to
 * the covering entry's `cropRegion` before rendering each frame, so a crop
 * applies to its own clip only (see clipSchema.cropRegion), not the whole
 * export. */
export interface CropScheduleEntry {
	startSec: number;
	endSec: number;
	cropRegion: CropRegion;
}

export interface VideoExporterConfig extends ExportConfig {
	videoUrl: string;
	webcamVideoUrl?: string;
	wallpaper: string;
	zoomRegions: ZoomRegion[];
	cameraFullscreenRegions?: CameraFullscreenRegion[];
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	showShadow: boolean;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount?: number;
	borderRadius?: number;
	padding?: number;
	videoPadding?: number;
	/** Fallback crop when `cropSchedule` is absent or a source timestamp
	 * doesn't fall in any entry (e.g. no clips info available). */
	cropRegion: CropRegion;
	/** Per-clip crop, in source-media time. When present, takes priority over
	 * the flat `cropRegion` for every frame that falls inside one of its
	 * entries. */
	cropSchedule?: CropScheduleEntry[];
	webcamLayoutPreset?: WebcamLayoutPreset;
	webcamMaskShape?: import("@/components/video-editor/types").WebcamMaskShape;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: WebcamSizePreset;
	webcamPosition?: { cx: number; cy: number } | null;
	cursorRecordingData?: CursorRecordingData | null;
	cursorScale?: number;
	cursorSmoothing?: number;
	cursorMotionBlur?: number;
	cursorClickBounce?: number;
	cursorClipToBounds?: boolean;
	cursorTheme?: string;
	annotationRegions?: AnnotationRegion[];
	previewWidth?: number;
	previewHeight?: number;
	cursorTelemetry?: import("@/components/video-editor/types").CursorTelemetryPoint[];
	cursorClickTimestamps?: number[];
	onProgress?: (progress: ExportProgress) => void;
	// v2 multi-asset render plan (ordered segments, virtual-time effects,
	// per-segment cursor). Present when built by documentExporter; the segment
	// loop consumes it. Absent for the legacy single-asset callers.
	renderPlan?: RenderPlan;
}

const SOURCE_COPY_EPSILON = 0.0001;
// Looser than SOURCE_COPY_EPSILON: container-reported avg frame rate is a
// rounded rational (e.g. 59.94 for a "60fps" recording), so this only needs
// to catch a genuinely different rate selection (24/30/60), not that noise.
const FRAME_RATE_EPSILON = 0.5;

function hasActiveTimeRegions(regions?: Array<{ startMs: number; endMs: number }>) {
	return Boolean(regions?.some((region) => region.endMs - region.startMs > SOURCE_COPY_EPSILON));
}

function hasActiveSpeedRegions(regions?: SpeedRegion[]) {
	return Boolean(
		regions?.some(
			(region) =>
				region.endMs - region.startMs > SOURCE_COPY_EPSILON &&
				Math.abs(region.speed - 1) > SOURCE_COPY_EPSILON,
		),
	);
}

function hasNativeCursorOverlay(config: VideoExporterConfig) {
	return (config.cursorScale ?? 0) > 0;
}

function isDefaultCrop(cropRegion: CropRegion) {
	return (
		Math.abs(cropRegion.x) <= SOURCE_COPY_EPSILON &&
		Math.abs(cropRegion.y) <= SOURCE_COPY_EPSILON &&
		Math.abs(cropRegion.width - 1) <= SOURCE_COPY_EPSILON &&
		Math.abs(cropRegion.height - 1) <= SOURCE_COPY_EPSILON
	);
}

function hasNonDefaultCrop(config: VideoExporterConfig): boolean {
	if (config.cropSchedule && config.cropSchedule.length > 0) {
		return config.cropSchedule.some((entry) => !isDefaultCrop(entry.cropRegion));
	}
	return !isDefaultCrop(config.cropRegion);
}

/** Finds which clip's crop applies at a given SOURCE-media timestamp — the
 * first schedule entry whose [startSec, endSec) covers it, falling back to
 * `fallback` when the schedule is absent or nothing covers it (e.g. a gap). */
export function resolveCropAt(
	schedule: CropScheduleEntry[] | undefined,
	sourceSec: number,
	fallback: CropRegion,
): CropRegion {
	if (!schedule || schedule.length === 0) return fallback;
	const covering = schedule.find(
		(entry) => sourceSec >= entry.startSec && sourceSec < entry.endSec,
	);
	return covering?.cropRegion ?? fallback;
}

interface SourceCopyVideoInfo {
	width: number;
	height: number;
	frameRate: number;
	codec: string;
}

export function isSourceCopyFastPathEligible(
	config: VideoExporterConfig,
	videoInfo: SourceCopyVideoInfo,
) {
	return getSourceCopyFastPathBlockers(config, videoInfo).length === 0;
}

export function getSourceCopyFastPathBlockers(
	config: VideoExporterConfig,
	videoInfo: SourceCopyVideoInfo,
) {
	const blockers: string[] = [];

	if (config.width !== videoInfo.width || config.height !== videoInfo.height) {
		blockers.push(
			`output-size ${config.width}x${config.height} differs from source ${videoInfo.width}x${videoInfo.height}`,
		);
	}
	// A copied file keeps the source's exact frame rate/codec — if the user
	// picked a different one in the export dialog, honor it by re-encoding
	// instead of silently shipping the source's encoding under a different
	// label.
	if (Math.abs(config.frameRate - videoInfo.frameRate) > FRAME_RATE_EPSILON) {
		blockers.push(`frame rate ${config.frameRate} differs from source ${videoInfo.frameRate}`);
	}
	if (config.codec && videoCodecFamily(config.codec) !== videoCodecFamily(videoInfo.codec)) {
		blockers.push(`codec ${config.codec} differs from source ${videoInfo.codec}`);
	}
	if (config.webcamVideoUrl) blockers.push("webcam overlay is enabled");
	if (hasActiveTimeRegions(config.trimRegions)) blockers.push("trim regions are present");
	if (hasActiveSpeedRegions(config.speedRegions)) blockers.push("speed regions are present");
	if (hasActiveTimeRegions(config.zoomRegions)) blockers.push("zoom regions are present");
	if (hasActiveTimeRegions(config.cameraFullscreenRegions))
		blockers.push("camera fullscreen regions are present");
	if (hasActiveTimeRegions(config.annotationRegions))
		blockers.push("annotation regions are present");
	if (hasNativeCursorOverlay(config)) blockers.push("editable cursor overlay is enabled");
	if (hasNonDefaultCrop(config)) blockers.push("crop is not default");
	if ((config.padding ?? 0) > SOURCE_COPY_EPSILON) blockers.push("padding is not zero");
	if ((config.videoPadding ?? 0) > SOURCE_COPY_EPSILON) blockers.push("video padding is not zero");
	if ((config.borderRadius ?? 0) > SOURCE_COPY_EPSILON) blockers.push("roundness is not zero");
	if (config.showShadow || config.shadowIntensity > SOURCE_COPY_EPSILON) {
		blockers.push("shadow is enabled");
	}
	if (config.showBlur) blockers.push("background blur is enabled");
	if ((config.motionBlurAmount ?? 0) > SOURCE_COPY_EPSILON) blockers.push("motion blur is enabled");

	return blockers;
}

/** Source-time spans to CUT for one segment so its decoder emits exactly
 * [sourceStart, sourceEnd) minus the clip's intra-trims: the complement of the
 * kept window over [0, sourceDuration] plus the intra-trims (v2 segment loop). */
function buildSegmentRenderTrims(segment: RenderSegment, sourceDurationSec: number): TrimRegion[] {
	const cuts: Array<{ startSec: number; endSec: number }> = [];
	if (segment.sourceStartSec > 0) {
		cuts.push({ startSec: 0, endSec: segment.sourceStartSec });
	}
	const keptEnd = Math.min(segment.sourceEndSec, sourceDurationSec);
	if (keptEnd < sourceDurationSec) {
		cuts.push({ startSec: keptEnd, endSec: sourceDurationSec });
	}
	for (const trim of segment.intraTrims) {
		cuts.push({ startSec: trim.startSec, endSec: trim.endSec });
	}
	return cuts.map((cut, i) => ({
		id: `seg_trim_${i + 1}`,
		startMs: Math.round(cut.startSec * 1000),
		endMs: Math.round(cut.endSec * 1000),
	}));
}

/** Per-segment cursor recording for the renderer: the plan's shared cursor
 * atlas/style + THIS segment's asset samples (empty → no overlay). */
function segmentCursorRecording(
	plan: RenderPlan,
	segment: RenderSegment,
): CursorRecordingData | null {
	if (!plan.cursor) return null;
	return {
		version: plan.cursor.version,
		provider: plan.cursor.provider,
		assets: plan.cursor.assets,
		samples: segment.cursorSamples,
	};
}

// v2 multi-asset audio output layout. Both recording formats are 48 kHz, so
// decodeAudioData is an identity resample; only channel counts get normalized.
const AUDIO_OUTPUT_SAMPLE_RATE = 48_000;
const AUDIO_OUTPUT_CHANNELS = 2;
// Short equal-power fade applied at each segment audio join (seamless audio).
const AUDIO_BOUNDARY_FADE_SEC = 0.005;

/** Source-time sub-intervals of a segment that are KEPT — its window minus
 * intra-trims (the complement of buildSegmentRenderTrims within the clip) — so
 * the segment's audio removes exactly the same cuts as its video. */
function keptSourceIntervals(segment: RenderSegment): Array<{ startSec: number; endSec: number }> {
	const kept: Array<{ startSec: number; endSec: number }> = [];
	let cursor = segment.sourceStartSec;
	const trims = [...segment.intraTrims].sort((a, b) => a.startSec - b.startSec);
	for (const trim of trims) {
		const trimStart = Math.max(trim.startSec, segment.sourceStartSec);
		const trimEnd = Math.min(trim.endSec, segment.sourceEndSec);
		if (trimEnd <= cursor) continue;
		if (trimStart > cursor) {
			kept.push({ startSec: cursor, endSec: Math.min(trimStart, segment.sourceEndSec) });
		}
		cursor = Math.max(cursor, trimEnd);
	}
	if (cursor < segment.sourceEndSec) {
		kept.push({ startSec: cursor, endSec: segment.sourceEndSec });
	}
	return kept;
}

/** Decodes ONE segment's audio to planar PCM at the common export layout
 * (sampleRate/channels), keeping only the clip's source window minus its
 * intra-trims. Channel counts are normalized via the shared downmix. Returns
 * null when the source has no decodable audio track. */
async function decodeSegmentAudioPcm(
	segment: RenderSegment,
	sampleRate: number,
	channels: number,
): Promise<Float32Array[] | null> {
	let file: File | null = null;
	try {
		file = await materializeLocalSourceFile(segment.videoUrl, `seg-${segment.clipId}-audio`);
		const bytes = await file.arrayBuffer();
		const ctx = new OfflineAudioContext(Math.max(1, channels), 1, sampleRate);
		let audioBuffer: AudioBuffer;
		try {
			audioBuffer = await ctx.decodeAudioData(bytes);
		} catch {
			return null; // no decodable audio track
		}
		const sourceChannels = audioBuffer.numberOfChannels;
		if (sourceChannels === 0) return null;

		const sourcePlanes: Float32Array[] = [];
		for (let c = 0; c < sourceChannels; c++) sourcePlanes.push(audioBuffer.getChannelData(c));

		// Concatenate the kept source sub-intervals (intra-trims removed), per channel.
		const kept = keptSourceIntervals(segment);
		const keptChannels: Float32Array[] = [];
		for (let c = 0; c < sourceChannels; c++) {
			const total = kept.reduce((acc, iv) => {
				const s0 = Math.max(0, Math.round(iv.startSec * sampleRate));
				const s1 = Math.min(sourcePlanes[c].length, Math.round(iv.endSec * sampleRate));
				return acc + Math.max(0, s1 - s0);
			}, 0);
			const out = new Float32Array(total);
			let w = 0;
			for (const iv of kept) {
				const s0 = Math.max(0, Math.round(iv.startSec * sampleRate));
				const s1 = Math.min(sourcePlanes[c].length, Math.round(iv.endSec * sampleRate));
				if (s1 > s0) {
					out.set(sourcePlanes[c].subarray(s0, s1), w);
					w += s1 - s0;
				}
			}
			keptChannels.push(out);
		}

		if (sourceChannels === channels) return keptChannels;

		// Normalize channel count (e.g. mono → stereo) with the shared downmix,
		// which returns one planar Float32Array (ch0 samples, then ch1, …).
		const frameCount = keptChannels[0]?.length ?? 0;
		if (frameCount === 0) return [];
		const downmixed = downmixPlanarChannelsForExport(keptChannels, channels);
		const result: Float32Array[] = [];
		for (let c = 0; c < channels; c++) {
			result.push(downmixed.subarray(c * frameCount, (c + 1) * frameCount));
		}
		return result;
	} catch (error) {
		console.warn("[VideoExporter] segment audio decode failed:", error);
		return null;
	} finally {
		if (file) releaseLocalSourceFile(file.name);
	}
}

function isMp4Source(videoUrl: string, blob: Blob) {
	if (blob.type.toLowerCase().includes("mp4")) {
		return true;
	}

	try {
		const path = new URL(videoUrl, window.location.href).pathname;
		return path.toLowerCase().endsWith(".mp4");
	} catch {
		return videoUrl.toLowerCase().split(/[?#]/, 1)[0].endsWith(".mp4");
	}
}

export class VideoExporter {
	private config: VideoExporterConfig;
	private streamingDecoder: StreamingVideoDecoder | null = null;
	private renderer: FrameRenderer | null = null;
	private encoder: VideoEncoder | null = null;
	private muxer: VideoMuxer | null = null;
	private audioProcessor: AudioProcessor | null = null;
	private webcamDecoder: StreamingVideoDecoder | null = null;
	private cancelled = false;
	private encodeQueue = 0;
	// Keep a smaller queue for software encoding so Windows does not balloon memory.
	private readonly MAX_ENCODE_QUEUE = 120;
	private videoDescription: Uint8Array | undefined;
	private videoColorSpace: VideoColorSpaceInit | undefined;
	private muxingPromises: Promise<void>[] = [];
	private chunkCount = 0;
	private fatalEncoderError: Error | null = null;

	constructor(config: VideoExporterConfig) {
		this.config = config;
	}

	async export(): Promise<ExportResult> {
		const encoderPreferences = this.getEncoderPreferences();
		let lastError: Error | null = null;

		for (const encoderPreference of encoderPreferences) {
			try {
				return await this.exportWithEncoderPreference(encoderPreference);
			} catch (error) {
				const normalizedError = error instanceof Error ? error : new Error(String(error));
				lastError = normalizedError;

				if (this.cancelled) {
					return { success: false, error: "Export cancelled" };
				}

				if (normalizedError instanceof BackgroundLoadError) {
					throw normalizedError;
				}

				if (encoderPreferences.length > 1) {
					console.warn(
						`[VideoExporter] ${encoderPreference} export attempt failed:`,
						normalizedError,
					);
				}
			} finally {
				this.cleanup();
			}
		}

		return {
			success: false,
			error: lastError?.message || "Export failed",
		};
	}

	private async exportWithEncoderPreference(
		encoderPreference: HardwareAcceleration,
	): Promise<ExportResult> {
		let webcamFrameQueue: TimestampedVideoFrameQueue | null = null;
		let stopWebcamDecode = false;
		let webcamDecodeError: Error | null = null;
		let webcamDecodePromise: Promise<void> | null = null;
		let webcamDecoder: StreamingVideoDecoder | null = null;
		const warnings: string[] = [];
		const onWarning = (message: string) => warnings.push(message);

		this.cleanup();
		this.cancelled = false;
		this.fatalEncoderError = null;

		try {
			// v2 multi-asset path: a plan with >1 segment can't be rendered by the
			// single-stream pipeline below (it would drop every non-primary clip —
			// the P1 bug). Single-segment exports stay on the proven legacy path.
			const segmentPlan = this.config.renderPlan;
			if (segmentPlan && segmentPlan.segments.length > 1) {
				return await this.runSegmentLoop(encoderPreference, segmentPlan);
			}

			const platform = await getPlatform();

			const streamingDecoder = new StreamingVideoDecoder();
			this.streamingDecoder = streamingDecoder;
			const videoInfo = await streamingDecoder.loadMetadata(
				this.config.videoUrl,
				({ copiedBytes, totalBytes }) => {
					// Large recordings are streamed into OPFS before demuxing; surface
					// that copy as a "preparing" phase so the dialog is not stuck at 0%.
					this.reportProgress({
						currentFrame: 0,
						totalFrames: 0,
						percentage: totalBytes > 0 ? (copiedBytes / totalBytes) * 100 : 0,
						estimatedTimeRemaining: 0,
						phase: "preparing",
					});
				},
			);
			const sourceCopyResult = await this.trySourceCopyFastPath(videoInfo);
			if (sourceCopyResult) {
				return sourceCopyResult;
			}

			let webcamInfo: Awaited<ReturnType<StreamingVideoDecoder["loadMetadata"]>> | null = null;
			if (this.config.webcamVideoUrl) {
				webcamDecoder = new StreamingVideoDecoder();
				this.webcamDecoder = webcamDecoder;
				webcamInfo = await webcamDecoder.loadMetadata(this.config.webcamVideoUrl);
			}

			const renderer = new FrameRenderer({
				width: this.config.width,
				height: this.config.height,
				wallpaper: this.config.wallpaper,
				zoomRegions: this.config.zoomRegions,
				cameraFullscreenRegions: this.config.cameraFullscreenRegions,
				showShadow: this.config.showShadow,
				shadowIntensity: this.config.shadowIntensity,
				showBlur: this.config.showBlur,
				motionBlurAmount: this.config.motionBlurAmount,
				borderRadius: this.config.borderRadius,
				padding: this.config.padding,
				cropRegion: this.config.cropRegion,
				cursorRecordingData: this.config.cursorRecordingData,
				cursorScale: this.config.cursorScale,
				cursorSmoothing: this.config.cursorSmoothing,
				cursorMotionBlur: this.config.cursorMotionBlur,
				cursorClickBounce: this.config.cursorClickBounce,
				cursorClipToBounds: this.config.cursorClipToBounds,
				cursorTheme: this.config.cursorTheme,
				videoWidth: videoInfo.width,
				videoHeight: videoInfo.height,
				webcamSize: webcamInfo ? { width: webcamInfo.width, height: webcamInfo.height } : null,
				webcamLayoutPreset: this.config.webcamLayoutPreset,
				webcamMaskShape: this.config.webcamMaskShape,
				webcamMirrored: this.config.webcamMirrored,
				webcamReactiveZoom: this.config.webcamReactiveZoom,
				webcamSizePreset: this.config.webcamSizePreset,
				webcamPosition: this.config.webcamPosition,
				annotationRegions: this.config.annotationRegions,
				speedRegions: this.config.speedRegions,
				previewWidth: this.config.previewWidth,
				previewHeight: this.config.previewHeight,
				cursorTelemetry: this.config.cursorTelemetry,
				cursorClickTimestamps: this.config.cursorClickTimestamps,
				platform,
			});
			this.renderer = renderer;
			await renderer.initialize();

			await this.initializeEncoder(encoderPreference);

			const sourceDemuxer = streamingDecoder.getDemuxer();
			const audioExportCodec =
				videoInfo.hasAudio && sourceDemuxer
					? await AudioProcessor.selectSupportedExportCodecForSource(sourceDemuxer)
					: null;
			if (videoInfo.hasAudio && !audioExportCodec) {
				console.warn("[VideoExporter] No supported audio export codec, exporting video-only.");
			}

			const hasAudio = Boolean(audioExportCodec);
			const muxer = new VideoMuxer(this.config, hasAudio, audioExportCodec?.muxerCodec);
			this.muxer = muxer;
			await muxer.initialize();

			const { totalFrames } = streamingDecoder.getExportMetrics(
				this.config.frameRate,
				this.config.trimRegions,
				this.config.speedRegions,
			);

			const frameDuration = 1_000_000 / this.config.frameRate;
			let frameIndex = 0;
			const maxEncodeQueue =
				encoderPreference === "prefer-software"
					? Math.min(this.MAX_ENCODE_QUEUE, 32)
					: this.MAX_ENCODE_QUEUE;

			webcamFrameQueue = this.config.webcamVideoUrl ? new TimestampedVideoFrameQueue() : null;
			webcamDecodePromise =
				webcamDecoder && webcamFrameQueue
					? (() => {
							const queue = webcamFrameQueue;
							return webcamDecoder
								.decodeAll(
									this.config.frameRate,
									this.config.trimRegions,
									this.config.speedRegions,
									async (webcamFrame, _exportTimestampUs, webcamSourceTimestampMs) => {
										while (queue.length >= 12 && !this.cancelled && !stopWebcamDecode) {
											await new Promise((resolve) => setTimeout(resolve, 2));
										}
										if (this.cancelled || stopWebcamDecode) {
											webcamFrame.close();
											return;
										}
										queue.enqueue(webcamFrame, webcamSourceTimestampMs);
									},
									onWarning,
								)
								.catch((error) => {
									webcamDecodeError = error instanceof Error ? error : new Error(String(error));
									throw webcamDecodeError;
								})
								.finally(() => {
									if (webcamDecodeError) {
										queue.fail(webcamDecodeError);
									} else {
										queue.close();
									}
								});
						})()
					: null;

			await streamingDecoder.decodeAll(
				this.config.frameRate,
				this.config.trimRegions,
				this.config.speedRegions,
				async (videoFrame, _exportTimestampUs, sourceTimestampMs) => {
					let webcamFrame: VideoFrame | null = null;
					try {
						if (this.cancelled) {
							return;
						}

						if (this.fatalEncoderError) {
							throw this.fatalEncoderError;
						}

						const timestamp = frameIndex * frameDuration;
						webcamFrame = webcamFrameQueue
							? await webcamFrameQueue.frameAt(sourceTimestampMs)
							: null;
						if (this.cancelled) {
							return;
						}

						const sourceTimestampUs = sourceTimestampMs * 1000;
						// Crop is per-clip — switch to whichever clip's crop covers this
						// frame's source time before rendering it (see
						// FrameRenderer.setCropRegion / resolveCropAt).
						renderer.setCropRegion(
							resolveCropAt(
								this.config.cropSchedule,
								sourceTimestampMs / 1000,
								this.config.cropRegion,
							),
						);
						await renderer.renderFrame(videoFrame, sourceTimestampUs, webcamFrame);

						const canvas = renderer.getCanvas();

						let exportFrame: VideoFrame;

						// On some Linux systems the GPU shared-image path (EGL/Ozone) fails
						// silently, producing empty frames, so we force a CPU readback instead.
						if (platform === "linux") {
							const canvasCtx = canvas.getContext("2d")!;
							const imageData = canvasCtx.getImageData(0, 0, canvas.width, canvas.height);
							exportFrame = new VideoFrame(imageData.data.buffer, {
								format: "RGBA",
								codedWidth: canvas.width,
								codedHeight: canvas.height,
								timestamp,
								duration: frameDuration,
								colorSpace: {
									primaries: "bt709",
									transfer: "iec61966-2-1",
									matrix: "rgb",
									fullRange: true,
								},
							});
						} else {
							exportFrame = new VideoFrame(canvas, { timestamp, duration: frameDuration });
						}

						try {
							await waitForEncoderQueueSpace({
								getQueueSize: () => this.encoder?.encodeQueueSize ?? 0,
								maxEncodeQueue,
								isCancelled: () => this.cancelled,
								encoderPreference,
							});
						} catch (error) {
							exportFrame.close();
							throw error;
						}

						if (this.encoder && this.encoder.state === "configured") {
							this.encodeQueue++;
							this.encoder.encode(exportFrame, { keyFrame: frameIndex % 150 === 0 });
						} else {
							console.warn(
								`[Frame ${frameIndex}] Encoder not ready! State: ${this.encoder?.state}`,
							);
						}

						exportFrame.close();
						frameIndex++;

						this.reportProgress({
							currentFrame: frameIndex,
							totalFrames,
							percentage: (frameIndex / totalFrames) * 100,
							estimatedTimeRemaining: 0,
						});
					} finally {
						videoFrame.close();
						webcamFrame?.close();
					}
				},
				onWarning,
			);

			if (this.cancelled) {
				return { success: false, error: "Export cancelled" };
			}

			if (this.fatalEncoderError) {
				throw this.fatalEncoderError;
			}

			stopWebcamDecode = true;
			webcamFrameQueue?.destroy();
			webcamDecoder?.cancel();
			await webcamDecodePromise;

			if (this.encoder && this.encoder.state === "configured") {
				await this.withTimeout(
					this.encoder.flush(),
					ENCODER_FLUSH_TIMEOUT_MS,
					encoderPreference === "prefer-hardware"
						? "The hardware video encoder stopped responding while finalizing the export."
						: "The video encoder stopped responding while finalizing the export.",
				);
			}

			if (this.fatalEncoderError) {
				throw this.fatalEncoderError;
			}

			await Promise.all(this.muxingPromises);

			this.reportProgress({
				currentFrame: totalFrames,
				totalFrames,
				percentage: 100,
				estimatedTimeRemaining: 0,
				phase: "finalizing",
			});

			if (hasAudio && audioExportCodec && !this.cancelled) {
				const demuxer = streamingDecoder.getDemuxer();
				if (demuxer) {
					console.log("[VideoExporter] Processing audio track...");
					this.audioProcessor = new AudioProcessor();
					await this.audioProcessor.process(
						demuxer,
						muxer,
						this.config.videoUrl,
						this.config.trimRegions,
						this.config.speedRegions,
						videoInfo.duration,
						audioExportCodec,
						this.config.frameRate,
					);
				}
			}

			const blob = await muxer.finalize();
			return { success: true, blob, warnings: warnings.length > 0 ? warnings : undefined };
		} finally {
			stopWebcamDecode = true;
			webcamFrameQueue?.destroy();
			webcamDecoder?.cancel();
			if (webcamDecodePromise) {
				await webcamDecodePromise.catch(() => undefined);
			}
		}
	}

	/**
	 * v2 multi-asset segment loop. Walks the RenderPlan's ordered segments,
	 * decoding each from its OWN source asset into ONE renderer + encoder + muxer,
	 * advancing a single continuous virtual-time frame clock across segment
	 * boundaries so the joins are seamless. Fixes P1 (non-primary clips dropped).
	 *
	 * Renders per-segment video + webcam overlay + cursor, each drawn from its
	 * OWN asset (webcam source + cursor samples switch at every segment boundary).
	 * Per-segment audio concat (see audioConcatPlan) and virtual-time speed
	 * mapping are the remaining increments. The caller has already run
	 * cleanup()/reset.
	 */
	private async runSegmentLoop(
		encoderPreference: HardwareAcceleration,
		plan: RenderPlan,
	): Promise<ExportResult> {
		const warnings: string[] = [];
		const onWarning = (message: string) => warnings.push(message);
		const platform = await getPlatform();
		const segments = plan.segments;
		const firstSegment = segments[0];

		// One renderer for the whole export — output size is fixed; only the
		// source-dependent fields change per segment via renderer.setSource().
		const renderer = new FrameRenderer({
			width: this.config.width,
			height: this.config.height,
			wallpaper: plan.appearance.wallpaper,
			zoomRegions: plan.zoomRegions,
			annotationRegions: plan.annotationRegions,
			speedRegions: plan.speedRegions,
			showShadow: plan.appearance.shadowIntensity > 0,
			shadowIntensity: plan.appearance.shadowIntensity,
			showBlur: plan.appearance.showBlur,
			motionBlurAmount: plan.appearance.motionBlurAmount,
			borderRadius: plan.appearance.borderRadius,
			padding: plan.appearance.padding,
			cropRegion: firstSegment.cropRegion,
			videoWidth: firstSegment.sourceWidth,
			videoHeight: firstSegment.sourceHeight,
			// Source-dependent fields (webcamSize, cursor samples/scale) are set per
			// segment via setSource; webcam layout + cursor style are global.
			webcamSize: null,
			webcamLayoutPreset: plan.webcam.layoutPreset,
			webcamMaskShape: plan.webcam.maskShape,
			webcamMirrored: plan.webcam.mirrored,
			webcamReactiveZoom: plan.webcam.reactiveZoom,
			webcamSizePreset: plan.webcam.sizePreset,
			webcamPosition: plan.webcam.position,
			cursorScale: plan.cursor?.scale ?? 0,
			cursorSmoothing: plan.cursor?.smoothing,
			cursorMotionBlur: plan.cursor?.motionBlur,
			cursorClickBounce: plan.cursor?.clickBounce,
			cursorClipToBounds: plan.cursor?.clipToBounds,
			cursorTheme: plan.cursor?.theme,
			platform,
		});
		this.renderer = renderer;
		await renderer.initialize();

		await this.initializeEncoder(encoderPreference);

		// Audio pre-pass: decode each segment's audio to the common export layout
		// up-front, so we know whether to declare an audio track on the muxer (mp4
		// needs that at construction). The concatenation TIMING is applied later,
		// once the video loop has produced each segment's real frame count.
		const segmentAudioPcm: (Float32Array[] | null)[] = [];
		let anySegmentAudio = false;
		for (const segment of segments) {
			if (this.cancelled) break;
			const pcm = await decodeSegmentAudioPcm(
				segment,
				AUDIO_OUTPUT_SAMPLE_RATE,
				AUDIO_OUTPUT_CHANNELS,
			);
			if (pcm && pcm.length > 0 && (pcm[0]?.length ?? 0) > 0) anySegmentAudio = true;
			segmentAudioPcm.push(pcm);
		}
		const audioExportCodec = anySegmentAudio
			? await AudioProcessor.selectSupportedExportCodec(
					AUDIO_OUTPUT_SAMPLE_RATE,
					AUDIO_OUTPUT_CHANNELS,
				)
			: null;
		const hasAudio = Boolean(audioExportCodec);

		const muxer = new VideoMuxer(this.config, hasAudio, audioExportCodec?.muxerCodec);
		this.muxer = muxer;
		await muxer.initialize();

		const frameDuration = 1_000_000 / this.config.frameRate;
		const maxEncodeQueue =
			encoderPreference === "prefer-software"
				? Math.min(this.MAX_ENCODE_QUEUE, 32)
				: this.MAX_ENCODE_QUEUE;

		// Progress estimate from the plan (no decoder metadata needed): kept
		// virtual duration of every segment × fps.
		const estTotalFrames = Math.max(
			1,
			Math.round(
				segments.reduce((acc, s) => {
					const intra = s.intraTrims.reduce((a, iv) => a + (iv.endSec - iv.startSec), 0);
					const kept = Math.max(0, s.sourceEndSec - s.sourceStartSec - intra);
					return acc + kept * this.config.frameRate;
				}, 0),
			),
		);

		let frameIndex = 0;
		// Real per-segment video frame count — audio is sized from this so the
		// concatenated audio stays locked to the (independently retimed) video.
		const segmentFrameCounts: number[] = [];

		for (const segment of segments) {
			if (this.cancelled) break;
			if (this.fatalEncoderError) throw this.fatalEncoderError;

			const framesBeforeSegment = frameIndex;
			const decoder = new StreamingVideoDecoder();
			this.streamingDecoder = decoder;

			// Per-segment webcam overlay (this asset's camera track), decoded
			// concurrently and matched to each screen frame by source time —
			// mirrors the legacy single-asset webcam path.
			let webcamDecoder: StreamingVideoDecoder | null = null;
			let webcamFrameQueue: TimestampedVideoFrameQueue | null = null;
			let webcamDecodePromise: Promise<void> | null = null;
			let stopWebcamDecode = false;

			try {
				const info = await decoder.loadMetadata(segment.videoUrl);
				const segmentTrims = buildSegmentRenderTrims(segment, info.duration);

				let webcamSize: { width: number; height: number } | null = null;
				if (segment.camera) {
					webcamDecoder = new StreamingVideoDecoder();
					this.webcamDecoder = webcamDecoder;
					const webcamInfo = await webcamDecoder.loadMetadata(segment.camera.videoUrl);
					webcamSize = { width: webcamInfo.width, height: webcamInfo.height };
					webcamFrameQueue = new TimestampedVideoFrameQueue();
					const queue = webcamFrameQueue;
					webcamDecodePromise = webcamDecoder
						.decodeAll(
							this.config.frameRate,
							segmentTrims,
							undefined,
							async (webcamFrame, _exportTs, webcamSourceMs) => {
								while (queue.length >= 12 && !this.cancelled && !stopWebcamDecode) {
									await new Promise((resolve) => setTimeout(resolve, 2));
								}
								if (this.cancelled || stopWebcamDecode) {
									webcamFrame.close();
									return;
								}
								queue.enqueue(webcamFrame, webcamSourceMs);
							},
							onWarning,
						)
						.catch((error) => {
							const err = error instanceof Error ? error : new Error(String(error));
							this.fatalEncoderError ??= err;
							queue.fail(err);
						})
						.finally(() => {
							if (!this.cancelled) queue.close();
						});
				}

				renderer.setSource({
					videoWidth: segment.sourceWidth,
					videoHeight: segment.sourceHeight,
					webcamSize,
					cursorRecordingData: segmentCursorRecording(plan, segment),
					cursorScale: plan.cursor?.scale ?? 0,
				});
				renderer.setCropRegion(segment.cropRegion);

				await decoder.decodeAll(
					this.config.frameRate,
					segmentTrims,
					undefined,
					async (videoFrame, _exportTs, sourceTimestampMs) => {
						let webcamFrame: VideoFrame | null = null;
						try {
							if (this.cancelled) return;
							if (this.fatalEncoderError) throw this.fatalEncoderError;

							webcamFrame = webcamFrameQueue
								? await webcamFrameQueue.frameAt(sourceTimestampMs)
								: null;
							if (this.cancelled) return;

							// Continuous virtual-time clock across segments → seamless joins.
							const timestamp = frameIndex * frameDuration;
							await renderer.renderFrame(videoFrame, timestamp, webcamFrame);

							const canvas = renderer.getCanvas();
							let exportFrame: VideoFrame;
							if (platform === "linux") {
								const canvasCtx = canvas.getContext("2d")!;
								const imageData = canvasCtx.getImageData(0, 0, canvas.width, canvas.height);
								exportFrame = new VideoFrame(imageData.data.buffer, {
									format: "RGBA",
									codedWidth: canvas.width,
									codedHeight: canvas.height,
									timestamp,
									duration: frameDuration,
									colorSpace: {
										primaries: "bt709",
										transfer: "iec61966-2-1",
										matrix: "rgb",
										fullRange: true,
									},
								});
							} else {
								exportFrame = new VideoFrame(canvas, { timestamp, duration: frameDuration });
							}

							try {
								await waitForEncoderQueueSpace({
									getQueueSize: () => this.encoder?.encodeQueueSize ?? 0,
									maxEncodeQueue,
									isCancelled: () => this.cancelled,
									encoderPreference,
								});
							} catch (error) {
								exportFrame.close();
								throw error;
							}

							if (this.encoder && this.encoder.state === "configured") {
								this.encodeQueue++;
								this.encoder.encode(exportFrame, { keyFrame: frameIndex % 150 === 0 });
							}

							exportFrame.close();
							frameIndex++;
							this.reportProgress({
								currentFrame: frameIndex,
								totalFrames: estTotalFrames,
								percentage: Math.min(100, (frameIndex / estTotalFrames) * 100),
								estimatedTimeRemaining: 0,
							});
						} finally {
							videoFrame.close();
							webcamFrame?.close();
						}
					},
					onWarning,
				);
			} finally {
				stopWebcamDecode = true;
				webcamFrameQueue?.destroy();
				webcamDecoder?.cancel();
				if (webcamDecodePromise) {
					await webcamDecodePromise.catch(() => undefined);
				}
				if (this.webcamDecoder === webcamDecoder) this.webcamDecoder = null;
				decoder.destroy();
				if (this.streamingDecoder === decoder) this.streamingDecoder = null;
			}
			segmentFrameCounts.push(frameIndex - framesBeforeSegment);
		}

		if (this.cancelled) {
			return { success: false, error: "Export cancelled" };
		}
		if (this.fatalEncoderError) {
			throw this.fatalEncoderError;
		}

		if (this.encoder && this.encoder.state === "configured") {
			await this.withTimeout(
				this.encoder.flush(),
				ENCODER_FLUSH_TIMEOUT_MS,
				encoderPreference === "prefer-hardware"
					? "The hardware video encoder stopped responding while finalizing the export."
					: "The video encoder stopped responding while finalizing the export.",
			);
		}
		if (this.fatalEncoderError) {
			throw this.fatalEncoderError;
		}

		await Promise.all(this.muxingPromises);
		this.reportProgress({
			currentFrame: estTotalFrames,
			totalFrames: estTotalFrames,
			percentage: 100,
			estimatedTimeRemaining: 0,
			phase: "finalizing",
		});

		// --- Audio: concatenate every segment's decoded PCM at the plan's offsets
		// (sized from the REAL per-segment video frame counts so A/V stays locked),
		// apply an equal-power fade at each join, then encode once and mux. ---
		if (hasAudio && audioExportCodec && !this.cancelled) {
			const audioPlan = buildAudioConcatPlan(
				segments.map((s, i) => ({
					clipId: s.clipId,
					outputFrameCount: segmentFrameCounts[i] ?? 0,
					hasAudio:
						(segmentAudioPcm[i]?.length ?? 0) > 0 && (segmentAudioPcm[i]?.[0]?.length ?? 0) > 0,
				})),
				{
					frameRate: this.config.frameRate,
					sampleRate: AUDIO_OUTPUT_SAMPLE_RATE,
					channels: AUDIO_OUTPUT_CHANNELS,
				},
			);
			const assembled = assembleConcatenatedPcm(
				segmentAudioPcm.map((pcm) => ({ pcm })),
				audioPlan,
				{ boundaryFadeSamples: Math.round(AUDIO_OUTPUT_SAMPLE_RATE * AUDIO_BOUNDARY_FADE_SEC) },
			);
			this.audioProcessor = new AudioProcessor();
			await this.audioProcessor.encodePcmToMuxer(
				assembled,
				AUDIO_OUTPUT_SAMPLE_RATE,
				muxer,
				audioExportCodec,
			);
		}

		const blob = await muxer.finalize();
		return { success: true, blob, warnings: warnings.length > 0 ? warnings : undefined };
	}

	private async initializeEncoder(hardwareAcceleration: HardwareAcceleration): Promise<void> {
		this.encodeQueue = 0;
		this.muxingPromises = [];
		this.chunkCount = 0;
		this.fatalEncoderError = null;
		let videoDescription: Uint8Array | undefined;

		this.encoder = new VideoEncoder({
			output: (chunk, meta) => {
				if (meta?.decoderConfig?.description && !videoDescription) {
					const desc = meta.decoderConfig.description;
					if (desc instanceof ArrayBuffer || desc instanceof SharedArrayBuffer) {
						videoDescription = new Uint8Array(desc);
					} else if (ArrayBuffer.isView(desc)) {
						videoDescription = new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
					}
					this.videoDescription = videoDescription;
				}

				if (meta?.decoderConfig?.colorSpace && !this.videoColorSpace) {
					this.videoColorSpace = meta.decoderConfig.colorSpace;
				}

				const isFirstChunk = this.chunkCount === 0;
				this.chunkCount++;

				const muxingPromise = (async () => {
					try {
						if (isFirstChunk && this.videoDescription) {
							const colorSpace = this.videoColorSpace || {
								primaries: "bt709",
								transfer: "iec61966-2-1",
								matrix: "rgb",
								fullRange: true,
							};

							const metadata: EncodedVideoChunkMetadata = {
								decoderConfig: {
									codec: this.config.codec || "avc1.640033",
									codedWidth: this.config.width,
									codedHeight: this.config.height,
									description: this.videoDescription,
									colorSpace,
								},
							};

							await this.muxer!.addVideoChunk(chunk, metadata);
						} else {
							await this.muxer!.addVideoChunk(chunk, meta);
						}
					} catch (error) {
						console.error("Muxing error:", error);
					}
				})();

				this.muxingPromises.push(muxingPromise);
				this.encodeQueue = Math.max(0, this.encodeQueue - 1);
			},
			error: (error) => {
				console.error("[VideoExporter] Encoder error:", error);
				this.fatalEncoderError =
					error instanceof Error ? error : new Error(`Video encoder error: ${String(error)}`);
				this.streamingDecoder?.cancel();
				this.webcamDecoder?.cancel();
			},
		});

		const encoderConfig: VideoEncoderConfig = {
			codec: this.config.codec || "avc1.640033",
			width: this.config.width,
			height: this.config.height,
			bitrate: this.config.bitrate,
			framerate: this.config.frameRate,
			latencyMode: "quality",
			bitrateMode: "variable",
			hardwareAcceleration,
		};

		const support = await VideoEncoder.isConfigSupported(encoderConfig);
		if (!support.supported) {
			throw new Error(
				hardwareAcceleration === "prefer-hardware"
					? "Hardware video encoding is not supported on this system."
					: "Software video encoding is not supported on this system.",
			);
		}

		console.log(
			`[VideoExporter] Using ${hardwareAcceleration === "prefer-hardware" ? "hardware" : "software"} acceleration`,
		);
		this.encoder.configure(encoderConfig);
	}

	cancel(): void {
		this.cancelled = true;
		if (this.streamingDecoder) {
			this.streamingDecoder.cancel();
		}
		if (this.webcamDecoder) {
			this.webcamDecoder.cancel();
		}
		if (this.audioProcessor) {
			this.audioProcessor.cancel();
		}
		this.cleanup();
	}

	private cleanup(): void {
		if (this.encoder) {
			try {
				if (this.encoder.state === "configured") {
					this.encoder.close();
				}
			} catch (e) {
				console.warn("Error closing encoder:", e);
			}
			this.encoder = null;
		}

		if (this.streamingDecoder) {
			try {
				this.streamingDecoder.destroy();
			} catch (e) {
				console.warn("Error destroying streaming decoder:", e);
			}
			this.streamingDecoder = null;
		}

		if (this.webcamDecoder) {
			try {
				this.webcamDecoder.destroy();
			} catch (e) {
				console.warn("Error destroying webcam decoder:", e);
			}
			this.webcamDecoder = null;
		}

		if (this.renderer) {
			try {
				this.renderer.destroy();
			} catch (e) {
				console.warn("Error destroying renderer:", e);
			}
			this.renderer = null;
		}

		this.audioProcessor = null;
		this.muxer = null;
		this.encodeQueue = 0;
		this.muxingPromises = [];
		this.chunkCount = 0;
		this.videoDescription = undefined;
		this.videoColorSpace = undefined;
		this.fatalEncoderError = null;
	}

	private getEncoderPreferences(): HardwareAcceleration[] {
		if (typeof navigator !== "undefined" && /\bWindows\b/i.test(navigator.userAgent)) {
			return ["prefer-software", "prefer-hardware"];
		}
		return ["prefer-hardware", "prefer-software"];
	}

	private async trySourceCopyFastPath(videoInfo: SourceCopyVideoInfo) {
		const blockers = getSourceCopyFastPathBlockers(this.config, videoInfo);
		if (blockers.length > 0) {
			console.info("[VideoExporter] source-copy fast path disabled", {
				blockers,
				output: { width: this.config.width, height: this.config.height },
				source: videoInfo,
			});
			return null;
		}

		const sourceBlob = await this.loadSourceBlob();
		if (!sourceBlob || !isMp4Source(this.config.videoUrl, sourceBlob)) {
			console.info("[VideoExporter] source-copy fast path disabled", {
				blockers: ["source is not a readable MP4"],
				source: videoInfo,
			});
			return null;
		}

		if (this.cancelled) {
			return { success: false, error: "Export cancelled" };
		}

		this.reportProgress({
			currentFrame: 1,
			totalFrames: 1,
			percentage: 100,
			estimatedTimeRemaining: 0,
			phase: "finalizing",
		});
		console.info("[VideoExporter] using source-copy fast path", {
			source: videoInfo,
			bytes: sourceBlob.size,
		});

		return {
			success: true,
			blob: sourceBlob.type ? sourceBlob : new Blob([sourceBlob], { type: "video/mp4" }),
		} satisfies ExportResult;
	}

	private async loadSourceBlob() {
		const videoUrl = this.config.videoUrl;
		const isRemoteUrl = /^(https?:|blob:|data:)/i.test(videoUrl);

		if (!isRemoteUrl && window.electronAPI?.readBinaryFile) {
			// The source-copy fast path reads the whole file into a Blob. That is
			// impossible for recordings above Node's 2 GiB single-read cap, so bail
			// out and let the (streaming) re-encode path handle them instead.
			if (window.electronAPI.getReadableFileInfo) {
				const info = await window.electronAPI.getReadableFileInfo(videoUrl);
				if (
					info.success &&
					typeof info.size === "number" &&
					info.size > MAX_IN_MEMORY_SOURCE_BYTES
				) {
					return null;
				}
			}

			const result = await window.electronAPI.readBinaryFile(videoUrl);
			if (!result.success || !result.data) {
				return null;
			}

			const type = videoUrl.toLowerCase().split(/[?#]/, 1)[0].endsWith(".mp4") ? "video/mp4" : "";
			return new Blob([result.data], type ? { type } : undefined);
		}

		const response = await fetch(videoUrl);
		if (!response.ok) {
			return null;
		}

		return response.blob();
	}

	private reportProgress(progress: ExportProgress): void {
		this.config.onProgress?.(progress);
	}

	private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
			promise.then(
				(value) => {
					window.clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					window.clearTimeout(timer);
					reject(error);
				},
			);
		});
	}
}
