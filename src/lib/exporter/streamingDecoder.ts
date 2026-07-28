import { WebDemuxer } from "web-demuxer";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import {
	type MaterializeProgress,
	materializeLocalSourceFile,
	releaseLocalSourceFile,
} from "./localSourceFile";
import { MAX_IN_MEMORY_SOURCE_BYTES } from "./sourceFileLimits";
import { computeKeepSegments, splitBySpeed } from "./timelineSegments";

const SOURCE_LOAD_TIMEOUT_MS = 60_000;
// Large local recordings are streamed into OPFS before demuxing, which is
// bounded by disk/IPC throughput rather than a network round-trip. Allow far
// more time than a remote fetch so a multi-GB copy is not cut off mid-way.
const LOCAL_SOURCE_LOAD_TIMEOUT_MS = 15 * 60_000;
const EPSILON_SEC = 0.001;
/**
 * Build a full WebCodecs-compatible AV1 codec string from the AV1CodecConfigurationRecord.
 * web-demuxer can return a bare "av01" when the WASM parser fails to read the extradata.
 * Parses the record if present, otherwise returns a safe default.
 *
 * @see https://aomediacodec.github.io/av1-isobmff/#av1codecconfigurationbox-section
 */
function buildAV1CodecString(description?: BufferSource): string {
	const fallback = "av01.0.01M.08";

	if (!description) return fallback;

	const bytes =
		description instanceof ArrayBuffer
			? new Uint8Array(description)
			: new Uint8Array(description.buffer, description.byteOffset, description.byteLength);

	// AV1CodecConfigurationRecord layout (4+ bytes):
	//   Byte 0: marker (1) | version (7)
	//   Byte 1: seq_profile (3) | seq_level_idx_0 (5)
	//   Byte 2: seq_tier_0 (1) | high_bitdepth (1) | twelve_bit (1) | ...
	// Spec says version 1, but Chrome/Electron MediaRecorder may write 127 (0xFF),
	// so accept any version as long as the marker bit is set and the record is long enough.
	if (bytes.length < 4) return fallback;
	if (!(bytes[0] & 0x80)) return fallback; // marker bit must be 1

	// Byte 1: seq_profile (3) | seq_level_idx_0 (5)
	const profile = (bytes[1] >> 5) & 0x07;
	const level = bytes[1] & 0x1f;

	// Byte 2: seq_tier_0 (1) | high_bitdepth (1) | twelve_bit (1) | monochrome (1) | ...
	const tier = (bytes[2] >> 7) & 0x01;
	const highBitdepth = (bytes[2] >> 6) & 0x01;
	const twelveBit = (bytes[2] >> 5) & 0x01;
	let bitdepth = 8;
	if (highBitdepth) bitdepth = twelveBit ? 12 : 10;

	const tierChar = tier ? "H" : "M";
	const levelStr = level.toString().padStart(2, "0");
	const bitdepthStr = bitdepth.toString().padStart(2, "0");

	return `av01.${profile}.${levelStr}${tierChar}.${bitdepthStr}`;
}

export interface DecodedVideoInfo {
	width: number;
	height: number;
	duration: number; // seconds
	streamDuration?: number; // seconds
	frameRate: number;
	codec: string;
	hasAudio: boolean;
	audioCodec?: string;
}

type EarlyDecodeEndCheck = {
	cancelled: boolean;
	lastDecodedFrameSec: number | null;
	requiredEndSec: number;
	streamDurationSec?: number;
};

const EARLY_DECODE_END_THRESHOLD_SEC = 1;
const METADATA_TAIL_TOLERANCE_SEC = 2;
const STREAM_DURATION_MATCH_TOLERANCE_SEC = 0.25;
const DURATION_DIVERGENCE_THRESHOLD_SEC = 1.5;
// Fallback upper bound for the packet scan when no reliable duration hint exists.
// An explicit end is required (some containers are truncated without one), but a
// hint-derived bound would cap the scan early when duration is missing or corrupt.
const SCAN_UNBOUNDED_FALLBACK_SEC = 24 * 60 * 60;

/**
 * Pick the most trustworthy duration. Chrome/Electron MediaRecorder writes WebM
 * with unreliable Duration fields (often Infinity, 0, or inflated), especially on Linux.
 *
 * @param containerDuration  Duration from the container-level metadata
 * @param scannedDuration    Duration derived from actual packet timestamps (ground truth)
 */
export function validateDuration(containerDuration: number, scannedDuration: number): number {
	if (scannedDuration <= 0) {
		// Corrupted/empty file, fall back to container.
		// (downstream shouldFailDecodeEndedEarly catches truly empty files)
		return Number.isFinite(containerDuration) ? Math.max(containerDuration, 0) : 0;
	}
	if (!Number.isFinite(containerDuration) || containerDuration <= 0) {
		return scannedDuration;
	}
	if (Math.abs(containerDuration - scannedDuration) > DURATION_DIVERGENCE_THRESHOLD_SEC) {
		return scannedDuration;
	}
	return containerDuration;
}

export function shouldFailDecodeEndedEarly({
	cancelled,
	lastDecodedFrameSec,
	requiredEndSec,
	streamDurationSec,
}: EarlyDecodeEndCheck): boolean {
	if (cancelled || requiredEndSec <= 0) {
		return false;
	}

	if (lastDecodedFrameSec === null) {
		return true;
	}

	const decodeGapSec = requiredEndSec - lastDecodedFrameSec;
	if (decodeGapSec <= EARLY_DECODE_END_THRESHOLD_SEC) {
		return false;
	}

	if (typeof streamDurationSec !== "number" || !Number.isFinite(streamDurationSec)) {
		return true;
	}

	const metadataTailSec = requiredEndSec - streamDurationSec;
	const decodedNearStreamEnd =
		Math.abs(lastDecodedFrameSec - streamDurationSec) <= STREAM_DURATION_MATCH_TOLERANCE_SEC;

	const maxTailSec = Math.max(METADATA_TAIL_TOLERANCE_SEC, requiredEndSec * 0.01);
	if (decodedNearStreamEnd && metadataTailSec > 0 && metadataTailSec <= maxTailSec) {
		return false;
	}

	return true;
}

/**
 * Loads a video file as an ArrayBuffer via the local (Electron IPC) or remote loader.
 * contentType is empty for local IPC reads, which carry no Content-Type.
 */
export async function loadFileAsArrayBuffer(
	videoUrl: string,
): Promise<{ data: ArrayBuffer; contentType: string }> {
	const isRemoteUrl = /^(https?:|blob:|data:)/i.test(videoUrl);

	if (!isRemoteUrl && window.electronAPI) {
		// This path loads the entire file into an ArrayBuffer for decodeAudioData,
		// and readBinaryFile also copies the bytes in the main process during IPC,
		// so a large recording would exhaust memory and crash. Callers must route
		// oversized files elsewhere (useAudioPeaks streams peaks via
		// computePeaksFromFileStreaming); this guard is a safety net for any
		// caller that does not.
		const info = await window.electronAPI.getReadableFileInfo?.(videoUrl);
		if (info?.success && typeof info.size === "number" && info.size > MAX_IN_MEMORY_SOURCE_BYTES) {
			throw new Error("Recording is too large to load into memory for waveform rendering.");
		}
		const result = await window.electronAPI.readBinaryFile(videoUrl);
		if (!result.success || !result.data) {
			throw new Error(result.message || result.error || "Failed to read source video");
		}
		return { data: result.data, contentType: "" };
	}

	const file = await StreamingVideoDecoder.loadRemoteSourceFile(videoUrl);
	return { data: await file.arrayBuffer(), contentType: file.type };
}

/** Caller must close the VideoFrame after use. */
type OnFrameCallback = (
	frame: VideoFrame,
	exportTimestampUs: number,
	sourceTimestampMs: number,
) => Promise<void>;

/**
 * Decodes video frames via web-demuxer + VideoDecoder in a single forward pass.
 * Way faster than seeking an HTMLVideoElement per frame.
 *
 * Frames in trimmed regions are decoded (needed for P/B-frame state) but discarded.
 * Kept frames are resampled to the target frame rate in a streaming pass.
 */
export class StreamingVideoDecoder {
	private demuxer: WebDemuxer | null = null;
	private decoder: VideoDecoder | null = null;
	private cancelled = false;
	private metadata: DecodedVideoInfo | null = null;
	// Name of the OPFS cache entry backing a large local source (equals the
	// File's .name), released on destroy() so the copy can be pruned once no
	// demuxer is reading it. Null for small/remote sources (never retained).
	private sourceCacheName: string | null = null;
	// Aborts an in-flight OPFS materialization when the decoder is cancelled,
	// destroyed, or the load times out — otherwise a cancelled export would keep
	// streaming gigabytes in the background and leak the cache reference.
	private readonly loadAbort = new AbortController();

	/** Routes to the appropriate loader based on whether the source is local or remote. */
	private async loadSourceFile(
		videoUrl: string,
		onProgress?: (progress: MaterializeProgress) => void,
	): Promise<File> {
		const isRemoteUrl = /^(https?:|blob:|data:)/i.test(videoUrl);
		if (!isRemoteUrl && window.electronAPI) {
			return this.withTimeout(
				StreamingVideoDecoder.loadLocalSourceFile(videoUrl, onProgress, this.loadAbort.signal),
				LOCAL_SOURCE_LOAD_TIMEOUT_MS,
				"Timed out while loading the source video.",
				// Stop the underlying copy too; a bare reject would leave it running.
				() => this.loadAbort.abort(),
			);
		}
		return this.withTimeout(
			StreamingVideoDecoder.loadRemoteSourceFile(videoUrl),
			SOURCE_LOAD_TIMEOUT_MS,
			"Timed out while loading the source video.",
		);
	}

	/**
	 * Loads a local video file for demuxing. Large recordings are streamed into
	 * an OPFS-backed File so nothing multi-GB is held in memory; web-demuxer reads
	 * the File on demand. See {@link materializeLocalSourceFile}.
	 */
	static async loadLocalSourceFile(
		videoUrl: string,
		onProgress?: (progress: MaterializeProgress) => void,
		signal?: AbortSignal,
	): Promise<File> {
		const filename = (videoUrl.split(/[\\/]/).pop() || "video").replace(/^file:/, "");
		return materializeLocalSourceFile(videoUrl, filename, { onProgress, signal });
	}

	/** Loads a remote or blob video URL via fetch. */
	static async loadRemoteSourceFile(videoUrl: string): Promise<File> {
		const response = await fetch(videoUrl);
		if (!response.ok) {
			throw new Error(`Failed to fetch source video: ${response.status} ${response.statusText}`);
		}
		const blob = await response.blob();
		const filename = videoUrl.split("/").pop() || "video";
		return new File([blob], filename, { type: blob.type });
	}

	async loadMetadata(
		videoUrl: string,
		onSourceProgress?: (progress: MaterializeProgress) => void,
	): Promise<DecodedVideoInfo> {
		const file = await this.loadSourceFile(videoUrl, onSourceProgress);
		// For OPFS-streamed sources the File name is the cache-entry key; retained
		// by materialize and released in destroy(). No-op key for small/remote.
		this.sourceCacheName = file.name;

		// Relative URL so it resolves in both dev (http) and packaged (file://) builds
		const wasmUrl = new URL("./wasm/web-demuxer.wasm", window.location.href).href;
		this.demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });
		await this.withTimeout(
			this.demuxer.load(file),
			SOURCE_LOAD_TIMEOUT_MS,
			"Timed out while parsing the source video.",
		);

		const mediaInfo = await this.withTimeout(
			this.demuxer.getMediaInfo(),
			SOURCE_LOAD_TIMEOUT_MS,
			"Timed out while reading video metadata.",
		);
		const videoStream = mediaInfo.streams.find((s) => s.codec_type_string === "video");

		let frameRate = 60;
		if (videoStream?.avg_frame_rate) {
			const parts = videoStream.avg_frame_rate.split("/");
			if (parts.length === 2) {
				const num = parseInt(parts[0], 10);
				const den = parseInt(parts[1], 10);
				if (den > 0 && num > 0) frameRate = num / den;
			}
		}

		const audioStream = mediaInfo.streams.find((s) => s.codec_type_string === "audio");

		// Scan video packets for the true content boundary; MediaRecorder (especially on
		// Linux) writes unreliable container durations and packet timestamps are ground truth.
		// Pass an explicit range because some containers are truncated without one.
		// Sanitize because mediaInfo.duration can be NaN/Infinity (Chromium Linux bug), which
		// would reach demuxer.read() as an invalid endpoint.
		const containerDurationSec = Number.isFinite(mediaInfo.duration) ? mediaInfo.duration : 0;
		const streamDurationSec =
			typeof videoStream?.duration === "number" && Number.isFinite(videoStream.duration)
				? videoStream.duration
				: 0;
		const hintedDurationSec = Math.max(containerDurationSec, streamDurationSec, 0);
		const scanEndSec =
			hintedDurationSec > 0 ? hintedDurationSec + 0.5 : SCAN_UNBOUNDED_FALLBACK_SEC;
		let maxPacketEndUs = 0;
		const scanReader = this.demuxer.read("video", 0, scanEndSec).getReader();
		try {
			while (true) {
				const { done, value } = await scanReader.read();
				if (done || !value) break;
				const endUs = value.timestamp + (value.duration ?? 0);
				if (endUs > maxPacketEndUs) maxPacketEndUs = endUs;
			}
		} finally {
			try {
				await scanReader.cancel();
			} catch {
				/* already closed */
			}
		}
		const scannedDuration = maxPacketEndUs / 1_000_000;
		const validatedDuration = validateDuration(mediaInfo.duration, scannedDuration);

		this.metadata = {
			width: videoStream?.width || 1920,
			height: videoStream?.height || 1080,
			duration: validatedDuration,
			streamDuration:
				typeof videoStream?.duration === "number" && Number.isFinite(videoStream.duration)
					? videoStream.duration
					: undefined,
			frameRate,
			codec: videoStream?.codec_string || "unknown",
			hasAudio: !!audioStream,
			audioCodec: audioStream?.codec_string,
		};

		return this.metadata;
	}
	/**
	 * Decodes all video frames, applying trim/speed and resampling to the target frame rate.
	 * @param targetFrameRate - Desired output frame rate.
	 * @param trimRegions - Time regions to keep (others discarded).
	 * @param speedRegions - Speed adjustments for specific time ranges.
	 * @param onFrame - Async callback receiving each decoded VideoFrame.
	 */
	async decodeAll(
		targetFrameRate: number,
		trimRegions: TrimRegion[] | undefined,
		speedRegions: SpeedRegion[] | undefined,
		onFrame: OnFrameCallback,
		onWarning?: (message: string) => void,
	): Promise<void> {
		if (!this.demuxer || !this.metadata) {
			throw new Error("Must call loadMetadata() before decodeAll()");
		}

		const decoderConfig = await this.demuxer.getDecoderConfig("video");

		console.log("[StreamingVideoDecoder] decoderConfig.codec:", decoderConfig.codec);
		console.log("[StreamingVideoDecoder] decoderConfig.description:", decoderConfig.description);

		// web-demuxer can return bare fourcc strings ("av01", "vp08", "vp09", "avc1")
		// that WebCodecs rejects; normalize to forms VideoDecoder accepts.
		if (/^av01$/i.test(decoderConfig.codec)) {
			decoderConfig.codec = buildAV1CodecString(
				decoderConfig.description as BufferSource | undefined,
			);
		}

		if (/^vp08$/i.test(decoderConfig.codec)) {
			decoderConfig.codec = "vp8";
		}
		if (/^vp09$/i.test(decoderConfig.codec)) {
			decoderConfig.codec = "vp9";
		}

		if (/^avc1$/i.test(decoderConfig.codec)) {
			decoderConfig.codec = "avc1.640033";
		}
		if (/^h264$/i.test(decoderConfig.codec)) {
			decoderConfig.codec = "avc1.640033";
		}

		const codec = decoderConfig.codec.toLowerCase();
		const shouldPreferSoftwareDecode =
			codec.includes("av01") ||
			codec.includes("av1") ||
			codec.includes("vp09") ||
			codec.includes("vp9");
		const segments = splitBySpeed(
			computeKeepSegments(this.metadata.duration, trimRegions),
			speedRegions,
		);
		const requiredEndSec = segments[segments.length - 1]?.endSec ?? 0;

		const segmentOutputFrameCounts = segments.map((segment) =>
			Math.ceil(
				((segment.endSec - segment.startSec - EPSILON_SEC) / segment.speed) * targetFrameRate,
			),
		);
		const frameDurationUs = 1_000_000 / targetFrameRate;

		// Async frame queue: decoder pushes, consumer pulls.
		const pendingFrames: VideoFrame[] = [];
		let frameResolve: ((frame: VideoFrame | null) => void) | null = null;
		let decodeError: Error | null = null;
		let decodeDone = false;

		this.decoder = new VideoDecoder({
			output: (frame: VideoFrame) => {
				if (frameResolve) {
					const resolve = frameResolve;
					frameResolve = null;
					resolve(frame);
				} else {
					pendingFrames.push(frame);
				}
			},
			error: (e: DOMException) => {
				console.warn(
					`[StreamingVideoDecoder] decoder error for codec "${decoderConfig.codec}":`,
					e.message,
				);
				decodeError = new Error(`VideoDecoder error: ${e.message}`);
				if (frameResolve) {
					const resolve = frameResolve;
					frameResolve = null;
					resolve(null);
				}
			},
		});
		const preferredDecoderConfig = shouldPreferSoftwareDecode
			? {
					...decoderConfig,
					hardwareAcceleration: "prefer-software" as const,
				}
			: decoderConfig;

		try {
			const support = await VideoDecoder.isConfigSupported(preferredDecoderConfig);
			console.log(
				`[StreamingVideoDecoder] isConfigSupported for "${preferredDecoderConfig.codec}":`,
				support.supported,
			);
			if (!support.supported) {
				throw new Error(`Unsupported codec: ${preferredDecoderConfig.codec}`);
			}
			this.decoder.configure(preferredDecoderConfig);
		} catch (error) {
			if (shouldPreferSoftwareDecode) {
				this.decoder.configure(decoderConfig);
			} else if (/^avc1/i.test(codec)) {
				const fallback = { ...decoderConfig, codec: "avc1.640033" };
				console.warn(
					`[StreamingVideoDecoder] codec "${codec}" unsupported, ` +
						`falling back to "${fallback.codec}"`,
				);
				this.decoder.configure(fallback);
			} else {
				throw error;
			}
		}

		const getNextFrame = (): Promise<VideoFrame | null> => {
			if (decodeError) throw decodeError;
			if (pendingFrames.length > 0) return Promise.resolve(pendingFrames.shift()!);
			if (decodeDone) return Promise.resolve(null);
			return new Promise((resolve) => {
				frameResolve = resolve;
			});
		};

		// One forward stream through the whole file. Pass an explicit range because
		// some containers are truncated when no end is provided.
		const readEndSec = this.metadata.duration + 0.5;
		const reader = this.demuxer.read("video", 0, readEndSec).getReader();

		// Feed chunks to the decoder in the background with backpressure.
		const feedPromise = (async () => {
			try {
				while (!this.cancelled) {
					const { done, value: chunk } = await reader.read();
					if (done || !chunk) break;

					// Backpressure on both decode queue and decoded frame backlog.
					while (
						(this.decoder!.decodeQueueSize > 10 || pendingFrames.length > 24) &&
						!this.cancelled
					) {
						await new Promise((resolve) => setTimeout(resolve, 1));
					}
					if (this.cancelled) break;

					this.decoder!.decode(chunk);
				}

				if (!this.cancelled && this.decoder!.state === "configured") {
					await this.decoder!.flush();
				}
			} catch (e) {
				decodeError = e instanceof Error ? e : new Error(String(e));
			} finally {
				decodeDone = true;
				if (frameResolve) {
					const resolve = frameResolve;
					frameResolve = null;
					resolve(null);
				}
			}
		})();

		// Route decoded frames into segments by timestamp, then deliver with VFR to CFR resampling.
		let segmentIdx = 0;
		let segmentFrameIndex = 0;
		let exportFrameIndex = 0;
		let lastDecodedFrameSec: number | null = null;
		let heldFrame: VideoFrame | null = null;
		let heldFrameSec = 0;

		const emitHeldFrameForTarget = async (segment: {
			startSec: number;
			endSec: number;
			speed: number;
		}) => {
			if (!heldFrame) return false;
			const segmentFrameCount = segmentOutputFrameCounts[segmentIdx];
			if (segmentFrameIndex >= segmentFrameCount) return false;

			const sourceTimeSec =
				segment.startSec + (segmentFrameIndex / targetFrameRate) * segment.speed;
			if (sourceTimeSec >= segment.endSec - EPSILON_SEC) return false;

			const clone = new VideoFrame(heldFrame, { timestamp: heldFrame.timestamp });
			await onFrame(clone, exportFrameIndex * frameDurationUs, sourceTimeSec * 1000);
			segmentFrameIndex++;
			exportFrameIndex++;
			return true;
		};

		while (!this.cancelled && segmentIdx < segments.length) {
			const frame = await getNextFrame();
			if (!frame) break;

			const frameTimeSec = frame.timestamp / 1_000_000;
			lastDecodedFrameSec = frameTimeSec;

			// Finalize completed segments before handling this frame.
			while (
				segmentIdx < segments.length &&
				frameTimeSec >= segments[segmentIdx].endSec - EPSILON_SEC
			) {
				const segment = segments[segmentIdx];
				while (!this.cancelled && (await emitHeldFrameForTarget(segment))) {
					// Keep emitting remaining output frames for this segment from the last known frame.
				}

				segmentIdx++;
				segmentFrameIndex = 0;
				if (
					heldFrame &&
					segmentIdx < segments.length &&
					heldFrameSec < segments[segmentIdx].startSec - EPSILON_SEC
				) {
					heldFrame.close();
					heldFrame = null;
				}
			}

			if (segmentIdx >= segments.length) {
				frame.close();
				continue;
			}

			const currentSegment = segments[segmentIdx];

			// Before current segment (trimmed region or pre-roll).
			if (frameTimeSec < currentSegment.startSec - EPSILON_SEC) {
				frame.close();
				continue;
			}

			if (!heldFrame) {
				heldFrame = frame;
				heldFrameSec = frameTimeSec;
				continue;
			}

			// Any target timestamp before this midpoint is closer to heldFrame than current frame.
			const handoffBoundarySec = (heldFrameSec + frameTimeSec) / 2;
			while (!this.cancelled) {
				const segmentFrameCount = segmentOutputFrameCounts[segmentIdx];
				if (segmentFrameIndex >= segmentFrameCount) {
					break;
				}

				const sourceTimeSec =
					currentSegment.startSec + (segmentFrameIndex / targetFrameRate) * currentSegment.speed;
				if (sourceTimeSec >= currentSegment.endSec - EPSILON_SEC) {
					break;
				}
				if (sourceTimeSec > handoffBoundarySec) {
					break;
				}

				const clone = new VideoFrame(heldFrame, { timestamp: heldFrame.timestamp });
				await onFrame(clone, exportFrameIndex * frameDurationUs, sourceTimeSec * 1000);
				segmentFrameIndex++;
				exportFrameIndex++;
			}

			heldFrame.close();
			heldFrame = frame;
			heldFrameSec = frameTimeSec;
		}

		// Flush remaining output frames for the last decoded frame.
		if (heldFrame && segmentIdx < segments.length) {
			while (!this.cancelled && segmentIdx < segments.length) {
				const segment = segments[segmentIdx];
				if (heldFrameSec < segment.startSec - EPSILON_SEC) {
					break;
				}

				while (!this.cancelled && (await emitHeldFrameForTarget(segment))) {
					// Keep emitting output frames for the active segment.
				}

				segmentIdx++;
				segmentFrameIndex = 0;
				if (
					segmentIdx < segments.length &&
					heldFrameSec < segments[segmentIdx].startSec - EPSILON_SEC
				) {
					break;
				}
			}
			heldFrame.close();
			heldFrame = null;
		}

		// Drain leftover decoded frames
		while (!decodeDone) {
			const frame = await getNextFrame();
			if (!frame) break;
			frame.close();
		}

		try {
			reader.cancel();
		} catch {
			/* already closed */
		}
		await feedPromise;
		for (const f of pendingFrames) f.close();
		pendingFrames.length = 0;

		if (this.decoder?.state === "configured") {
			this.decoder.close();
		}
		this.decoder = null;

		if (
			shouldFailDecodeEndedEarly({
				cancelled: this.cancelled,
				lastDecodedFrameSec,
				requiredEndSec,
				streamDurationSec: this.metadata.streamDuration,
			})
		) {
			const decodedAtLabel =
				lastDecodedFrameSec === null ? "no decoded frame" : `${lastDecodedFrameSec.toFixed(3)}s`;
			const message = `Decode ended early at ${decodedAtLabel} (needed ${requiredEndSec.toFixed(3)}s) – export may be slightly shorter than expected.`;
			console.warn(`[StreamingVideoDecoder] ${message}`);
			onWarning?.(message);
		}
	}

	/**
	 * Effective output duration (seconds) and total frame count for the given trim/speed
	 * regions at the target frame rate. Requires loadMetadata() first.
	 */
	getExportMetrics(
		targetFrameRate: number,
		trimRegions?: TrimRegion[],
		speedRegions?: SpeedRegion[],
	): { effectiveDuration: number; totalFrames: number } {
		if (!this.metadata) throw new Error("Must call loadMetadata() first");
		const trimSegments = computeKeepSegments(this.metadata.duration, trimRegions);
		const segments = splitBySpeed(trimSegments, speedRegions);
		return {
			effectiveDuration: segments.reduce(
				(sum, seg) => sum + (seg.endSec - seg.startSec) / seg.speed,
				0,
			),
			totalFrames: segments.reduce((sum, seg) => {
				const segDur = seg.endSec - seg.startSec - EPSILON_SEC;
				return sum + Math.max(0, Math.ceil((segDur / seg.speed) * targetFrameRate));
			}, 0),
		};
	}

	/** Returns the underlying WebDemuxer instance, or null if not yet loaded. */
	getDemuxer(): WebDemuxer | null {
		return this.demuxer;
	}

	/** Signals the decoder to stop processing at the next cancellation checkpoint. */
	cancel(): void {
		this.cancelled = true;
		this.loadAbort.abort();
	}

	/** Cancels decoding and releases the VideoDecoder and WebDemuxer resources. */
	destroy(): void {
		this.cancelled = true;
		this.loadAbort.abort();

		if (this.decoder) {
			try {
				if (this.decoder.state === "configured") this.decoder.close();
			} catch {
				/* ignore */
			}
			this.decoder = null;
		}

		if (this.demuxer) {
			try {
				this.demuxer.destroy();
			} catch {
				/* ignore */
			}
			this.demuxer = null;
		}

		if (this.sourceCacheName) {
			releaseLocalSourceFile(this.sourceCacheName);
			this.sourceCacheName = null;
		}
	}

	/** Wraps a promise with a hard timeout, rejecting with `message` if it exceeds `timeoutMs`. */
	private withTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number,
		message: string,
		onTimeout?: () => void,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				onTimeout?.();
				reject(new Error(message));
			}, timeoutMs);
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
