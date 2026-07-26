import { WebDemuxer } from "web-demuxer";
import {
	MAX_NATIVE_PLAYBACK_RATE,
	type SpeedRegion,
	type TrimRegion,
} from "@/components/video-editor/types";
import { WsolaTimeStretcher } from "./audioTimeStretch";
import type { ExportAudioMuxerCodec, VideoMuxer } from "./muxer";
import { PlanarChunkQueue } from "./planarChunkQueue";
import {
	buildSpeedSegments,
	maxTimelineSpeed,
	type SpeedTimelineSegment,
} from "./timelineSegments";

const AUDIO_BITRATE = 128_000;
const DECODE_BACKPRESSURE_LIMIT = 20;
const MIN_SPEED_REGION_DELTA_MS = 0.0001;
const SEEK_TIMEOUT_MS = 5_000;
// AudioData slice size fed to the encoder from the offline time-stretch path.
const OFFLINE_OUTPUT_FRAMES = 4096;
const ENCODE_BACKPRESSURE_LIMIT = 20;
// Must match streamingDecoder's EPSILON_SEC so the offline audio segment lengths
// use the same per-frame quantization as the video output.
const VIDEO_EPSILON_SEC = 0.001;

export interface ExportAudioCodec {
	encoderCodec: string;
	muxerCodec: ExportAudioMuxerCodec;
	label: string;
	sampleRate: number;
	numberOfChannels: number;
}

type ExportAudioCodecCandidate = Omit<ExportAudioCodec, "sampleRate" | "numberOfChannels">;

const EXPORT_AUDIO_CODECS: ExportAudioCodecCandidate[] = [
	{ encoderCodec: "mp4a.40.2", muxerCodec: "aac", label: "AAC" },
	{ encoderCodec: "opus", muxerCodec: "opus", label: "Opus" },
];

function averageChannels(sourcePlanes: Float32Array[], frame: number) {
	let mixed = 0;
	for (const plane of sourcePlanes) {
		mixed += plane[frame] ?? 0;
	}
	return mixed / Math.max(1, sourcePlanes.length);
}

function weightedSample(
	sourcePlanes: Float32Array[],
	frame: number,
	weights: Array<[channel: number, weight: number]>,
) {
	let mixed = 0;
	let weightSum = 0;
	for (const [channel, weight] of weights) {
		const sample = sourcePlanes[channel]?.[frame];
		if (typeof sample !== "number") {
			continue;
		}
		mixed += sample * weight;
		weightSum += weight;
	}
	return weightSum > 0 ? mixed / weightSum : averageChannels(sourcePlanes, frame);
}

function getStereoDownmixWeights(sourceChannels: number) {
	const centerWeight = Math.SQRT1_2;
	const surroundWeight = Math.SQRT1_2;
	const lfeWeight = 0.5;

	if (sourceChannels >= 8) {
		// Windows 7.1 order: FL, FR, FC, LFE, BL, BR, SL, SR.
		return {
			left: [
				[0, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[4, surroundWeight],
				[6, surroundWeight],
			] satisfies Array<[number, number]>,
			right: [
				[1, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[5, surroundWeight],
				[7, surroundWeight],
			] satisfies Array<[number, number]>,
		};
	}

	if (sourceChannels >= 6) {
		// Windows 5.1 order: FL, FR, FC, LFE, BL, BR.
		return {
			left: [
				[0, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[4, surroundWeight],
			] satisfies Array<[number, number]>,
			right: [
				[1, 1],
				[2, centerWeight],
				[3, lfeWeight],
				[5, surroundWeight],
			] satisfies Array<[number, number]>,
		};
	}

	if (sourceChannels >= 4) {
		return {
			left: [
				[0, 1],
				[2, surroundWeight],
			] satisfies Array<[number, number]>,
			right: [
				[1, 1],
				[3, surroundWeight],
			] satisfies Array<[number, number]>,
		};
	}

	return {
		left: [
			[0, 1],
			[2, centerWeight],
		] satisfies Array<[number, number]>,
		right: [
			[1, 1],
			[2, centerWeight],
		] satisfies Array<[number, number]>,
	};
}

export function downmixPlanarChannelsForExport(
	sourcePlanes: Float32Array[],
	targetChannels: number,
): Float32Array {
	const frameCount = sourcePlanes[0]?.length ?? 0;
	const output = new Float32Array(frameCount * targetChannels);

	if (targetChannels === 1) {
		for (let frame = 0; frame < frameCount; frame++) {
			output[frame] = averageChannels(sourcePlanes, frame);
		}
		return output;
	}

	if (targetChannels !== 2) {
		throw new Error(`Unsupported target channel count: ${targetChannels}`);
	}

	if (sourcePlanes.length === 1) {
		output.set(sourcePlanes[0], 0);
		output.set(sourcePlanes[0], frameCount);
		return output;
	}

	if (sourcePlanes.length === 2) {
		output.set(sourcePlanes[0], 0);
		output.set(sourcePlanes[1], frameCount);
		return output;
	}

	const weights = getStereoDownmixWeights(sourcePlanes.length);
	for (let frame = 0; frame < frameCount; frame++) {
		output[frame] = weightedSample(sourcePlanes, frame, weights.left);
		output[frameCount + frame] = weightedSample(sourcePlanes, frame, weights.right);
	}
	return output;
}

export class AudioProcessor {
	private cancelled = false;

	static async selectSupportedExportCodec(
		sampleRate: number,
		numberOfChannels: number,
	): Promise<ExportAudioCodec | null> {
		const channelOptions = [numberOfChannels];
		if (numberOfChannels > 2) {
			channelOptions.push(2);
		}

		if (!channelOptions.includes(1)) {
			channelOptions.push(1);
		}

		for (const codec of EXPORT_AUDIO_CODECS) {
			for (const channels of channelOptions) {
				const support = await AudioEncoder.isConfigSupported({
					codec: codec.encoderCodec,
					sampleRate,
					numberOfChannels: channels,
					bitrate: AUDIO_BITRATE,
				});
				if (support.supported) {
					return { ...codec, sampleRate, numberOfChannels: channels };
				}
			}
		}

		return null;
	}

	static async selectSupportedExportCodecForSource(
		demuxer: WebDemuxer,
	): Promise<ExportAudioCodec | null> {
		let audioConfig: AudioDecoderConfig;
		try {
			audioConfig = await demuxer.getDecoderConfig("audio");
		} catch {
			return null;
		}

		const codecCheck = await AudioDecoder.isConfigSupported(audioConfig);
		if (!codecCheck.supported) {
			console.warn("[AudioProcessor] Audio codec not supported:", audioConfig.codec);
			return null;
		}

		return AudioProcessor.selectSupportedExportCodec(
			audioConfig.sampleRate || 48000,
			audioConfig.numberOfChannels || 2,
		);
	}

	/**
	 * Two modes: no speed regions uses the fast WebCodecs trim-only pipeline; speed
	 * regions use the pitch-preserving rendered timeline pipeline.
	 */
	async process(
		demuxer: WebDemuxer,
		muxer: VideoMuxer,
		videoUrl: string,
		trimRegions: TrimRegion[] | undefined,
		speedRegions: SpeedRegion[] | undefined,
		validatedDurationSec: number,
		exportCodec: ExportAudioCodec,
		targetFrameRate: number,
	): Promise<void> {
		const sortedTrims = trimRegions ? [...trimRegions].sort((a, b) => a.startMs - b.startMs) : [];
		const sortedSpeedRegions = speedRegions
			? [...speedRegions]
					.filter((region) => region.endMs - region.startMs > MIN_SPEED_REGION_DELTA_MS)
					.sort((a, b) => a.startMs - b.startMs)
			: [];

		// Speed edits need pitch preservation. Segments at or below the native
		// playbackRate cap use the real-time <audio> capture (proven, sounds best);
		// anything faster can't be played in real time, so the whole timeline is
		// rendered offline with a WSOLA time-stretch instead.
		if (sortedSpeedRegions.length > 0) {
			const segments = buildSpeedSegments(validatedDurationSec, sortedTrims, sortedSpeedRegions);

			if (maxTimelineSpeed(segments) > MAX_NATIVE_PLAYBACK_RATE) {
				await this.renderOfflineTimelineAudio(
					demuxer,
					muxer,
					segments,
					exportCodec,
					targetFrameRate,
				);
				return;
			}

			const renderedAudioBlob = await this.renderPitchPreservedTimelineAudio(
				videoUrl,
				sortedTrims,
				sortedSpeedRegions,
				validatedDurationSec,
			);
			if (!this.cancelled && renderedAudioBlob.size > 0) {
				await this.muxRenderedAudioBlob(renderedAudioBlob, muxer, exportCodec);
				return;
			}
			return;
		}

		// No speed edits: demux/decode/encode with trim timestamp remap. The +0.5s mirrors
		// streamingDecoder.decodeAll's read window so both paths read the same distance past
		// the validated duration boundary.
		const readEndSec = validatedDurationSec + 0.5;
		await this.processTrimOnlyAudio(demuxer, muxer, sortedTrims, readEndSec, exportCodec);
	}

	// Trim-only path, used for projects without speed regions.
	private async processTrimOnlyAudio(
		demuxer: WebDemuxer,
		muxer: VideoMuxer,
		sortedTrims: TrimRegion[],
		readEndSec?: number,
		exportCodec?: ExportAudioCodec,
	): Promise<void> {
		let audioConfig: AudioDecoderConfig;
		try {
			audioConfig = await demuxer.getDecoderConfig("audio");
		} catch {
			console.warn("[AudioProcessor] No audio track found, skipping");
			return;
		}

		const codecCheck = await AudioDecoder.isConfigSupported(audioConfig);
		if (!codecCheck.supported) {
			console.warn("[AudioProcessor] Audio codec not supported:", audioConfig.codec);
			return;
		}

		// Phase 1: decode, skipping trimmed regions.
		const decodedFrames: AudioData[] = [];

		const decoder = new AudioDecoder({
			output: (data: AudioData) => decodedFrames.push(data),
			error: (e: DOMException) => console.error("[AudioProcessor] Decode error:", e),
		});
		decoder.configure(audioConfig);

		const safeReadEndSec =
			typeof readEndSec === "number" && Number.isFinite(readEndSec)
				? Math.max(0, readEndSec)
				: undefined;
		const audioStream =
			safeReadEndSec !== undefined
				? demuxer.read("audio", 0, safeReadEndSec)
				: demuxer.read("audio");
		const reader = audioStream.getReader();

		try {
			while (!this.cancelled) {
				const { done, value: chunk } = await reader.read();
				if (done || !chunk) break;

				const timestampMs = chunk.timestamp / 1000;
				if (this.isInTrimRegion(timestampMs, sortedTrims)) continue;

				decoder.decode(chunk);

				while (decoder.decodeQueueSize > DECODE_BACKPRESSURE_LIMIT && !this.cancelled) {
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
			}
		} finally {
			try {
				await reader.cancel();
			} catch {
				/* reader already closed */
			}
		}

		if (decoder.state === "configured") {
			await decoder.flush();
			decoder.close();
		}

		if (this.cancelled || decodedFrames.length === 0) {
			for (const frame of decodedFrames) frame.close();
			return;
		}

		// Phase 2: re-encode with timestamps adjusted for trim gaps.
		const encodedChunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];

		const encoder = new AudioEncoder({
			output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
				encodedChunks.push({ chunk, meta });
			},
			error: (e: DOMException) => console.error("[AudioProcessor] Encode error:", e),
		});

		const sampleRate = audioConfig.sampleRate || 48000;
		const channels = audioConfig.numberOfChannels || 2;
		const selectedCodec =
			exportCodec ?? (await AudioProcessor.selectSupportedExportCodec(sampleRate, channels));
		if (!selectedCodec) {
			console.warn("[AudioProcessor] No supported audio export codec, skipping audio");
			for (const frame of decodedFrames) frame.close();
			return;
		}

		const outputSampleRate = selectedCodec.sampleRate || sampleRate;
		const outputChannels = selectedCodec.numberOfChannels || channels;
		const encodeConfig: AudioEncoderConfig = {
			codec: selectedCodec.encoderCodec,
			sampleRate: outputSampleRate,
			numberOfChannels: outputChannels,
			bitrate: AUDIO_BITRATE,
		};

		const encodeSupport = await AudioEncoder.isConfigSupported(encodeConfig);
		if (!encodeSupport.supported) {
			console.warn(
				`[AudioProcessor] ${selectedCodec.label} encoding not supported, skipping audio`,
			);
			for (const frame of decodedFrames) frame.close();
			return;
		}

		encoder.configure(encodeConfig);

		for (const audioData of decodedFrames) {
			if (this.cancelled) {
				audioData.close();
				continue;
			}

			const timestampMs = audioData.timestamp / 1000;
			const trimOffsetMs = this.computeTrimOffset(timestampMs, sortedTrims);
			const adjustedTimestampUs = audioData.timestamp - trimOffsetMs * 1000;

			const adjusted = this.cloneForEncoding(
				audioData,
				Math.max(0, adjustedTimestampUs),
				outputChannels,
			);
			audioData.close();

			encoder.encode(adjusted);
			adjusted.close();
		}

		if (encoder.state === "configured") {
			await encoder.flush();
			encoder.close();
		}

		// Phase 3: flush encoded chunks to muxer.
		for (const { chunk, meta } of encodedChunks) {
			if (this.cancelled) break;
			await muxer.addAudioChunk(chunk, meta);
		}

		console.log(
			`[AudioProcessor] Processed ${decodedFrames.length} audio frames, encoded ${encodedChunks.length} chunks`,
		);
	}

	// Speed-aware path mirroring preview semantics (trim skipping + playbackRate). Relies on
	// browser media playback to preserve pitch and avoid the chipmunk effect.
	private async renderPitchPreservedTimelineAudio(
		videoUrl: string,
		trimRegions: TrimRegion[],
		speedRegions: SpeedRegion[],
		validatedDurationSec: number,
	): Promise<Blob> {
		const media = document.createElement("audio");
		media.src = videoUrl;
		media.preload = "auto";

		const pitchMedia = media as HTMLMediaElement & {
			preservesPitch?: boolean;
			mozPreservesPitch?: boolean;
			webkitPreservesPitch?: boolean;
		};
		pitchMedia.preservesPitch = true;
		pitchMedia.mozPreservesPitch = true;
		pitchMedia.webkitPreservesPitch = true;

		await this.waitForLoadedMetadata(media);
		if (this.cancelled) {
			throw new Error("Export cancelled");
		}

		const audioContext = new AudioContext();
		const sourceNode = audioContext.createMediaElementSource(media);
		const destinationNode = audioContext.createMediaStreamDestination();
		sourceNode.connect(destinationNode);

		let rafId: number | null = null;
		let recorder: MediaRecorder | null = null;
		let recordedBlobPromise: Promise<Blob> | null = null;

		try {
			if (audioContext.state === "suspended") {
				await audioContext.resume();
			}

			// Skip initial trim region(s) before recording so the first rAF frames don't
			// capture trimmed audio. Loops to handle back-to-back/overlapping trims at t=0.
			const effectiveEnd = validatedDurationSec;
			let startPosition = 0;
			for (let i = 0; i <= trimRegions.length; i++) {
				const activeTrim = this.findActiveTrimRegion(startPosition * 1000, trimRegions);
				if (!activeTrim) break;
				startPosition = activeTrim.endMs / 1000;
				if (startPosition >= effectiveEnd) break;
			}

			if (startPosition >= effectiveEnd) {
				// Everything is trimmed; return a silent blob.
				return new Blob([], { type: "audio/webm" });
			}

			await this.seekTo(media, startPosition);

			// Set initial playback rate for the starting position.
			const initialSpeedRegion = this.findActiveSpeedRegion(startPosition * 1000, speedRegions);
			if (initialSpeedRegion) {
				media.playbackRate = initialSpeedRegion.speed;
			}

			// Start recording only after seeking past trims.
			const recording = this.startAudioRecording(destinationNode.stream);
			recorder = recording.recorder;
			recordedBlobPromise = recording.recordedBlobPromise;
			await media.play();

			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					if (rafId !== null) {
						cancelAnimationFrame(rafId);
						rafId = null;
					}
					media.removeEventListener("error", onError);
					media.removeEventListener("ended", onEnded);
				};

				const onError = () => {
					cleanup();
					reject(new Error("Failed while rendering speed-adjusted audio timeline"));
				};

				const onEnded = () => {
					cleanup();
					resolve();
				};

				const tick = () => {
					if (this.cancelled) {
						cleanup();
						resolve();
						return;
					}

					// Stop at validated duration; media.duration can be inflated by bad
					// container metadata.
					if (media.currentTime >= validatedDurationSec) {
						media.pause();
						cleanup();
						resolve();
						return;
					}

					const currentTimeMs = media.currentTime * 1000;
					const activeTrimRegion = this.findActiveTrimRegion(currentTimeMs, trimRegions);

					if (activeTrimRegion && !media.paused && !media.ended) {
						const skipToTime = activeTrimRegion.endMs / 1000;
						if (skipToTime >= media.duration || skipToTime >= validatedDurationSec) {
							media.pause();
							cleanup();
							resolve();
							return;
						}
						// Pause recording during the seek so we don't capture silence/noise.
						media.pause();
						if (recorder?.state === "recording") recorder.pause();
						const onSeeked = () => {
							clearTimeout(seekTimer);
							if (this.cancelled) {
								cleanup();
								resolve();
								return;
							}
							if (recorder?.state === "paused") recorder.resume();
							media
								.play()
								.then(() => {
									if (!this.cancelled) rafId = requestAnimationFrame(tick);
								})
								.catch((err) => {
									cleanup();
									reject(
										new Error(
											`Failed to resume playback after trim seek: ${err instanceof Error ? err.message : String(err)}`,
										),
									);
								});
						};
						const seekTimer = window.setTimeout(() => {
							media.removeEventListener("seeked", onSeeked);
							cleanup();
							reject(new Error("Audio seek timed out while skipping trim region"));
						}, SEEK_TIMEOUT_MS);
						media.addEventListener("seeked", onSeeked, { once: true });
						media.currentTime = skipToTime;
						return;
					}

					const activeSpeedRegion = this.findActiveSpeedRegion(currentTimeMs, speedRegions);
					const playbackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;
					if (Math.abs(media.playbackRate - playbackRate) > 0.0001) {
						media.playbackRate = playbackRate;
					}

					if (!media.paused && !media.ended) {
						rafId = requestAnimationFrame(tick);
					} else {
						cleanup();
						resolve();
					}
				};

				media.addEventListener("error", onError, { once: true });
				media.addEventListener("ended", onEnded, { once: true });
				rafId = requestAnimationFrame(tick);
			});
		} finally {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			media.pause();
			if (recorder && recorder.state !== "inactive") {
				recorder.stop();
			}
			destinationNode.stream.getTracks().forEach((track) => track.stop());
			sourceNode.disconnect();
			destinationNode.disconnect();
			await audioContext.close();
			media.src = "";
			media.load();
		}

		if (!recordedBlobPromise) {
			// Either an early return fired or startAudioRecording set this before playback
			// resolved. Reaching here means that broke; fail loud rather than return silence.
			throw new Error("Audio recorder finished without assigning recordedBlobPromise");
		}
		const recordedBlob = await recordedBlobPromise;
		if (this.cancelled) {
			throw new Error("Export cancelled");
		}
		return recordedBlob;
	}

	/**
	 * Offline pitch-preserved timeline audio for projects that contain a segment
	 * faster than the native playbackRate cap (which the real-time capture path
	 * can't reach). Streams the source once, routes each frame's PCM into the
	 * active timeline segment, applies a WSOLA time-stretch per segment, and
	 * encodes the result — clamping each segment to its exact expected length so
	 * the audio stays locked to the (independently retimed) video.
	 */
	private async renderOfflineTimelineAudio(
		demuxer: WebDemuxer,
		muxer: VideoMuxer,
		segments: SpeedTimelineSegment[],
		exportCodec: ExportAudioCodec,
		targetFrameRate: number,
	): Promise<void> {
		let audioConfig: AudioDecoderConfig;
		try {
			audioConfig = await demuxer.getDecoderConfig("audio");
		} catch {
			console.warn("[AudioProcessor] No audio track found, skipping");
			return;
		}

		const codecCheck = await AudioDecoder.isConfigSupported(audioConfig);
		if (!codecCheck.supported) {
			console.warn("[AudioProcessor] Audio codec not supported:", audioConfig.codec);
			return;
		}

		const sampleRate = audioConfig.sampleRate || 48000;
		const outputChannels = exportCodec.numberOfChannels || audioConfig.numberOfChannels || 2;
		const outputSampleRate = exportCodec.sampleRate || sampleRate;

		const encodeConfig: AudioEncoderConfig = {
			codec: exportCodec.encoderCodec,
			sampleRate: outputSampleRate,
			numberOfChannels: outputChannels,
			bitrate: AUDIO_BITRATE,
		};
		const encodeSupport = await AudioEncoder.isConfigSupported(encodeConfig);
		if (!encodeSupport.supported) {
			console.warn(`[AudioProcessor] ${exportCodec.label} encoding not supported, skipping audio`);
			return;
		}

		const encodedChunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];
		const encoder = new AudioEncoder({
			output: (chunk, meta) => encodedChunks.push({ chunk, meta }),
			error: (e: DOMException) => console.error("[AudioProcessor] Encode error:", e),
		});
		encoder.configure(encodeConfig);

		// Output-side accumulator: a chunk queue (O(1) append, front-drained) coalesced
		// into fixed-size AudioData slices with running (monotonic) output timestamps.
		const outQueue = new PlanarChunkQueue(outputChannels);
		let outTimestampSamples = 0;

		const appendOutput = (planes: Float32Array[], count: number) => {
			outQueue.push(planes, count);
		};

		const flushOutput = (drainAll: boolean) => {
			while (outQueue.length >= OFFLINE_OUTPUT_FRAMES || (drainAll && outQueue.length > 0)) {
				const take = Math.min(OFFLINE_OUTPUT_FRAMES, outQueue.length);
				const data = outQueue.take(take);
				const audioData = new AudioData({
					format: "f32-planar",
					sampleRate: outputSampleRate,
					numberOfFrames: take,
					numberOfChannels: outputChannels,
					timestamp: Math.round((outTimestampSamples / outputSampleRate) * 1_000_000),
					data: data.buffer as ArrayBuffer,
				});
				outTimestampSamples += take;
				encoder.encode(audioData);
				audioData.close();
			}
		};

		// Per-segment state.
		let segIdx = 0;
		let stretcher: WsolaTimeStretcher | null = null;
		let segExpectedOut = 0;
		let segEmittedOut = 0;

		const startSegment = (seg: SpeedTimelineSegment) => {
			// Match the video path's per-segment frame quantization exactly (streamingDecoder
			// emits ceil((dur - EPSILON)/speed * fps) frames) so audio and video advance by
			// the same amount each segment and never accumulate drift.
			const frameCount = Math.ceil(
				((seg.endSec - seg.startSec - VIDEO_EPSILON_SEC) / seg.speed) * targetFrameRate,
			);
			segExpectedOut = Math.max(0, Math.round((frameCount / targetFrameRate) * outputSampleRate));
			segEmittedOut = 0;
			stretcher = new WsolaTimeStretcher({
				sampleRate,
				channels: outputChannels,
				speed: seg.speed,
				expectedOutputSamples: segExpectedOut,
			});
		};

		// Clamp each segment's emitted output to its expected length (drops the WSOLA
		// tail overshoot; pads with silence on the rare underrun) so cumulative A/V
		// timing matches the video the audio is retimed against.
		const emitStretched = (planes: Float32Array[]) => {
			const produced = planes[0]?.length ?? 0;
			const allowed = Math.max(0, segExpectedOut - segEmittedOut);
			const take = Math.min(produced, allowed);
			appendOutput(planes, take);
			segEmittedOut += take;
		};

		// Feed `count` source-domain silence samples into the current segment's
		// stretcher (compressed by its speed, then clamped/encoded like real audio).
		const feedSilence = (count: number) => {
			if (!stretcher) return;
			let remaining = count;
			while (remaining > 0) {
				const n = Math.min(8192, remaining);
				const silence = Array.from({ length: outputChannels }, () => new Float32Array(n));
				emitStretched(stretcher.push(silence));
				remaining -= n;
			}
		};

		const finalizeSegment = () => {
			if (!stretcher) return;
			emitStretched(stretcher.flush());
			// Intentional: pad the deficit with silence when WSOLA under-fills a short
			// high-speed segment, so the segment keeps its exact A/V-locked length. Do
			// not "fix" this by removing the pad.
			if (segEmittedOut < segExpectedOut) {
				const pad = segExpectedOut - segEmittedOut;
				const silence = Array.from({ length: outputChannels }, () => new Float32Array(pad));
				appendOutput(silence, pad);
				segEmittedOut += pad;
			}
			stretcher = null;
		};

		const segStartSample = (seg: SpeedTimelineSegment) => Math.round(seg.startSec * sampleRate);
		const segEndSample = (seg: SpeedTimelineSegment) => Math.round(seg.endSec * sampleRate);

		const routeFrame = (planes: Float32Array[], frameStartSample: number, frameCount: number) => {
			let local = 0;
			while (local < frameCount && segIdx < segments.length) {
				const seg = segments[segIdx];
				const segStart = segStartSample(seg);
				const segEnd = segEndSample(seg);
				const currentAbs = frameStartSample + local;

				if (currentAbs < segStart) {
					// In a trimmed gap (or before the first segment): discard.
					local += Math.min(segStart - currentAbs, frameCount - local);
					continue;
				}
				if (currentAbs >= segEnd) {
					finalizeSegment();
					segIdx += 1;
					continue;
				}
				if (!stretcher) {
					startSegment(seg);
					// If the very first source sample lands after the timeline origin (codec
					// priming, or an audio track that starts after the video), fill the head
					// with leading silence so real audio keeps its true source-time position.
					// The video path holds its first frame over the same head, so this keeps
					// A/V aligned; it is a no-op when the first sample is at 0, and negative
					// preroll was already discarded by the `currentAbs < segStart` branch above.
					if (segIdx === 0 && currentAbs > segStart) feedSilence(currentAbs - segStart);
				}
				const take = Math.min(segEnd, frameStartSample + frameCount) - currentAbs;
				const slice = planes.map((p) => p.subarray(local, local + take));
				emitStretched((stretcher as WsolaTimeStretcher).push(slice));
				local += take;
			}
		};

		// Streaming decode: frames arrive in source order via the decoder callback.
		const pending: AudioData[] = [];
		const decoder = new AudioDecoder({
			output: (data: AudioData) => pending.push(data),
			error: (e: DOMException) => console.error("[AudioProcessor] Decode error:", e),
		});
		decoder.configure(audioConfig);

		const drainPending = async () => {
			while (pending.length > 0) {
				if (this.cancelled) {
					for (const d of pending) d.close();
					pending.length = 0;
					return;
				}
				const data = pending.shift();
				if (!data) continue;
				const frameCount = data.numberOfFrames;
				const sourceChannels = data.numberOfChannels;
				const srcPlanes: Float32Array[] = [];
				for (let c = 0; c < sourceChannels; c++) {
					const plane = new Float32Array(frameCount);
					data.copyTo(plane, { format: "f32-planar", planeIndex: c });
					srcPlanes.push(plane);
				}
				// Raw source timestamps — the same origin the video decoder uses
				// (streamingDecoder), so audio and video stay in one coordinate system.
				// Frames before the first segment start (e.g. negative-timestamp codec
				// preroll, or a leading trim) are correctly discarded by routeFrame.
				const frameStartSample = Math.round((data.timestamp / 1_000_000) * sampleRate);
				data.close();

				// Match source channels through untouched; otherwise downmix (to 1 or 2).
				let planes: Float32Array[];
				if (outputChannels === sourceChannels) {
					planes = srcPlanes;
				} else {
					const downmixed = downmixPlanarChannelsForExport(srcPlanes, outputChannels);
					planes = [];
					for (let c = 0; c < outputChannels; c++) {
						planes.push(downmixed.subarray(c * frameCount, (c + 1) * frameCount));
					}
				}

				routeFrame(planes, frameStartSample, frameCount);
				flushOutput(false);

				while (encoder.encodeQueueSize > ENCODE_BACKPRESSURE_LIMIT && !this.cancelled) {
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
			}
		};

		// Read past the last segment's source end (mirrors streamingDecoder's +0.5s
		// window so both paths read the same distance past the boundary).
		const lastSegmentEndSec = segments.length > 0 ? segments[segments.length - 1].endSec : 0;
		const readEndSec = lastSegmentEndSec + 0.5;
		const reader = demuxer.read("audio", 0, readEndSec).getReader();
		try {
			while (!this.cancelled) {
				const { done, value: chunk } = await reader.read();
				if (done || !chunk) break;
				decoder.decode(chunk);
				while (decoder.decodeQueueSize > DECODE_BACKPRESSURE_LIMIT && !this.cancelled) {
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
				await drainPending();
			}
		} finally {
			try {
				await reader.cancel();
			} catch {
				/* reader already closed */
			}
		}

		if (decoder.state === "configured") {
			if (!this.cancelled) {
				await decoder.flush();
			}
			decoder.close();
		}
		await drainPending();

		if (this.cancelled) {
			if (encoder.state === "configured") encoder.close();
			return;
		}

		// Finalize the segment still open at end-of-stream, then pad any segments that
		// never received audio (source shorter than the timeline) with silence.
		if (stretcher) {
			finalizeSegment();
			segIdx += 1;
		}
		for (; segIdx < segments.length; segIdx++) {
			startSegment(segments[segIdx]);
			finalizeSegment();
		}

		flushOutput(true);

		if (encoder.state === "configured") {
			await encoder.flush();
			encoder.close();
		}

		for (const { chunk, meta } of encodedChunks) {
			if (this.cancelled) break;
			await muxer.addAudioChunk(chunk, meta);
		}

		console.log(
			`[AudioProcessor] Offline timeline audio: ${segments.length} segments, ${encodedChunks.length} chunks`,
		);
	}

	// Demux the rendered speed-adjusted blob and feed its chunks into the MP4 muxer.
	private async muxRenderedAudioBlob(
		blob: Blob,
		muxer: VideoMuxer,
		exportCodec: ExportAudioCodec,
	): Promise<void> {
		if (this.cancelled) return;

		const file = new File([blob], "speed-audio.webm", { type: blob.type || "audio/webm" });
		const wasmUrl = new URL("./wasm/web-demuxer.wasm", window.location.href).href;
		const demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });

		try {
			await demuxer.load(file);
			await this.processTrimOnlyAudio(demuxer, muxer, [], undefined, exportCodec);
		} finally {
			try {
				demuxer.destroy();
			} catch {
				/* ignore */
			}
		}
	}

	private startAudioRecording(stream: MediaStream): {
		recorder: MediaRecorder;
		recordedBlobPromise: Promise<Blob>;
	} {
		const mimeType = this.getSupportedAudioMimeType();
		const options: MediaRecorderOptions = {
			audioBitsPerSecond: AUDIO_BITRATE,
			...(mimeType ? { mimeType } : {}),
		};

		const recorder = new MediaRecorder(stream, options);
		const chunks: Blob[] = [];

		const recordedBlobPromise = new Promise<Blob>((resolve, reject) => {
			recorder.ondataavailable = (event: BlobEvent) => {
				if (event.data && event.data.size > 0) {
					chunks.push(event.data);
				}
			};
			recorder.onerror = () => {
				reject(new Error("MediaRecorder failed while capturing speed-adjusted audio"));
			};
			recorder.onstop = () => {
				const type = mimeType || chunks[0]?.type || "audio/webm";
				resolve(new Blob(chunks, { type }));
			};
		});

		recorder.start();
		return { recorder, recordedBlobPromise };
	}

	private getSupportedAudioMimeType(): string | undefined {
		const candidates = ["audio/webm;codecs=opus", "audio/webm"];
		for (const candidate of candidates) {
			if (MediaRecorder.isTypeSupported(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private waitForLoadedMetadata(media: HTMLMediaElement): Promise<void> {
		if (Number.isFinite(media.duration) && media.readyState >= HTMLMediaElement.HAVE_METADATA) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const onLoaded = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("Failed to load media metadata for speed-adjusted audio"));
			};
			const cleanup = () => {
				media.removeEventListener("loadedmetadata", onLoaded);
				media.removeEventListener("error", onError);
			};

			media.addEventListener("loadedmetadata", onLoaded);
			media.addEventListener("error", onError, { once: true });
		});
	}

	private seekTo(media: HTMLMediaElement, targetSec: number): Promise<void> {
		if (Math.abs(media.currentTime - targetSec) < 0.0001) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const onSeeked = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("Failed to seek media for speed-adjusted audio"));
			};
			const cleanup = () => {
				media.removeEventListener("seeked", onSeeked);
				media.removeEventListener("error", onError);
			};

			media.addEventListener("seeked", onSeeked, { once: true });
			media.addEventListener("error", onError, { once: true });
			media.currentTime = targetSec;
		});
	}

	private findActiveTrimRegion(
		currentTimeMs: number,
		trimRegions: TrimRegion[],
	): TrimRegion | null {
		return (
			trimRegions.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	}

	private findActiveSpeedRegion(
		currentTimeMs: number,
		speedRegions: SpeedRegion[],
	): SpeedRegion | null {
		return (
			speedRegions.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	}

	private cloneForEncoding(
		src: AudioData,
		newTimestamp: number,
		targetChannels: number,
	): AudioData {
		if (targetChannels !== src.numberOfChannels) {
			return this.downmixWithTimestamp(src, newTimestamp, targetChannels);
		}

		if (!src.format) {
			throw new Error("AudioData format is required for cloning");
		}
		const isPlanar = src.format.includes("planar");
		const numPlanes = isPlanar ? src.numberOfChannels : 1;

		let totalSize = 0;
		for (let planeIndex = 0; planeIndex < numPlanes; planeIndex++) {
			totalSize += src.allocationSize({ planeIndex });
		}

		const buffer = new ArrayBuffer(totalSize);
		let offset = 0;
		for (let planeIndex = 0; planeIndex < numPlanes; planeIndex++) {
			const planeSize = src.allocationSize({ planeIndex });
			src.copyTo(new Uint8Array(buffer, offset, planeSize), { planeIndex });
			offset += planeSize;
		}

		return new AudioData({
			format: src.format,
			sampleRate: src.sampleRate,
			numberOfFrames: src.numberOfFrames,
			numberOfChannels: src.numberOfChannels,
			timestamp: newTimestamp,
			data: buffer,
		});
	}

	private downmixWithTimestamp(
		src: AudioData,
		newTimestamp: number,
		targetChannels: number,
	): AudioData {
		const sourceChannels = src.numberOfChannels;
		const frameCount = src.numberOfFrames;
		if (targetChannels < 1 || targetChannels > 2) {
			throw new Error(`Unsupported target channel count: ${targetChannels}`);
		}

		const sourcePlanes = Array.from({ length: sourceChannels }, () => new Float32Array(frameCount));
		for (let channel = 0; channel < sourceChannels; channel++) {
			src.copyTo(sourcePlanes[channel], {
				format: "f32-planar",
				planeIndex: channel,
			});
		}

		const output = downmixPlanarChannelsForExport(sourcePlanes, targetChannels);

		return new AudioData({
			format: "f32-planar",
			sampleRate: src.sampleRate,
			numberOfFrames: frameCount,
			numberOfChannels: targetChannels,
			timestamp: newTimestamp,
			data: output.buffer instanceof ArrayBuffer ? output.buffer : output.slice().buffer,
		});
	}

	private isInTrimRegion(timestampMs: number, trims: TrimRegion[]): boolean {
		return trims.some((trim) => timestampMs >= trim.startMs && timestampMs < trim.endMs);
	}

	private computeTrimOffset(timestampMs: number, trims: TrimRegion[]): number {
		let offset = 0;
		for (const trim of trims) {
			if (trim.endMs <= timestampMs) {
				offset += trim.endMs - trim.startMs;
			}
		}
		return offset;
	}

	/**
	 * Encodes an already-assembled planar PCM timeline (one Float32Array per
	 * channel, at `sampleRate`) into `exportCodec` and muxes the chunks. Used by
	 * the v2 multi-asset segment loop: per-segment audio is decoded, concatenated
	 * and boundary-faded upstream (audioConcatAssembler), then handed here as one
	 * continuous buffer — so this method only chops it into encoder-sized frames.
	 */
	async encodePcmToMuxer(
		pcm: Float32Array[],
		sampleRate: number,
		muxer: VideoMuxer,
		exportCodec: ExportAudioCodec,
	): Promise<void> {
		if (this.cancelled) return;
		const channels = pcm.length;
		const totalFrames = pcm[0]?.length ?? 0;
		if (channels === 0 || totalFrames === 0) return;

		const encodeConfig: AudioEncoderConfig = {
			codec: exportCodec.encoderCodec,
			sampleRate,
			numberOfChannels: channels,
			bitrate: AUDIO_BITRATE,
		};
		const support = await AudioEncoder.isConfigSupported(encodeConfig);
		if (!support.supported) {
			console.warn(`[AudioProcessor] ${exportCodec.label} encoding not supported, skipping audio`);
			return;
		}

		const encodedChunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];
		const encoder = new AudioEncoder({
			output: (chunk, meta) => encodedChunks.push({ chunk, meta }),
			error: (e: DOMException) => console.error("[AudioProcessor] Encode error:", e),
		});
		encoder.configure(encodeConfig);

		let offset = 0;
		while (offset < totalFrames && !this.cancelled) {
			const count = Math.min(OFFLINE_OUTPUT_FRAMES, totalFrames - offset);
			// f32-planar layout: channel 0's `count` samples, then channel 1's, …
			const planar = new Float32Array(count * channels);
			for (let c = 0; c < channels; c++) {
				planar.set(pcm[c].subarray(offset, offset + count), c * count);
			}
			const audioData = new AudioData({
				format: "f32-planar",
				sampleRate,
				numberOfFrames: count,
				numberOfChannels: channels,
				timestamp: Math.round((offset / sampleRate) * 1_000_000),
				data: planar.buffer as ArrayBuffer,
			});
			encoder.encode(audioData);
			audioData.close();
			offset += count;
			while (encoder.encodeQueueSize > ENCODE_BACKPRESSURE_LIMIT && !this.cancelled) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		}

		if (encoder.state === "configured") {
			await encoder.flush();
			encoder.close();
		}
		for (const { chunk, meta } of encodedChunks) {
			if (this.cancelled) break;
			await muxer.addAudioChunk(chunk, meta);
		}
		console.log(`[AudioProcessor] Segmented audio: ${encodedChunks.length} chunks`);
	}

	cancel(): void {
		this.cancelled = true;
	}
}
