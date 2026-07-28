// Offline compositor for multi-window captures: decodes every window's video
// in lockstep, draws the focused window (sliding between windows on focus
// hand-offs), and encodes one intermediate video that the normal export
// pipeline then treats as the "screen recording".

import { VideoMuxer } from "@/lib/exporter/muxer";
import { StreamingVideoDecoder } from "@/lib/exporter/streamingDecoder";
import type { MultiWindowManifest } from "@/lib/windowSwitch/contracts";
import {
	buildWindowSwitchTimeline,
	switchStateAt,
	type WindowSwitchTimeline,
} from "@/lib/windowSwitch/switchTimeline";

const FRAME_RATE = 60;
const BITRATE = 18_000_000;
const CODEC = "avc1.640033";
const KEYFRAME_INTERVAL = 150;
const BACKGROUND = "#0b0b0d";

/** Single-slot handoff between a decoder's push callback and the consumer. */
class FrameChannel {
	private frame: VideoFrame | null = null;
	private waiting: (() => void) | null = null;
	private consumed: (() => void) | null = null;
	private done = false;

	async push(frame: VideoFrame): Promise<void> {
		this.frame = frame;
		this.waiting?.();
		this.waiting = null;
		await new Promise<void>((resolve) => {
			this.consumed = resolve;
		});
	}

	finish(): void {
		this.done = true;
		this.waiting?.();
		this.waiting = null;
	}

	/** Returns the next frame, or null once the stream has ended. */
	async next(): Promise<VideoFrame | null> {
		if (this.frame === null && !this.done) {
			await new Promise<void>((resolve) => {
				this.waiting = resolve;
			});
		}
		const frame = this.frame;
		this.frame = null;
		this.consumed?.();
		this.consumed = null;
		return frame;
	}
}

interface SourceStream {
	channel: FrameChannel;
	/** Most recent frame, kept alive until replaced (sources can end early). */
	lastFrame: VideoFrame | null;
	width: number;
	height: number;
	durationSec: number;
	decoder: StreamingVideoDecoder;
	decodeError: Error | null;
}

function drawSource(
	ctx: CanvasRenderingContext2D,
	source: SourceStream,
	canvasWidth: number,
	canvasHeight: number,
	offsetX: number,
): void {
	const frame = source.lastFrame;
	if (!frame) return;
	const scale = Math.min(canvasWidth / source.width, canvasHeight / source.height);
	const drawWidth = source.width * scale;
	const drawHeight = source.height * scale;
	const x = offsetX + (canvasWidth - drawWidth) / 2;
	const y = (canvasHeight - drawHeight) / 2;
	ctx.drawImage(frame, x, y, drawWidth, drawHeight);
}

export interface ComposeProgress {
	percentage: number;
	currentFrame: number;
	totalFrames: number;
}

export async function composeMultiWindowVideo(
	manifest: MultiWindowManifest,
	videoUrls: string[],
	onProgress: (progress: ComposeProgress) => void,
): Promise<{ blob: Blob; durationMs: number; timeline: WindowSwitchTimeline }> {
	if (videoUrls.length !== manifest.windows.length || videoUrls.length < 2) {
		throw new Error("Multi-window manifest and video list are inconsistent");
	}

	// Load metadata for every source to size the canvas and bound the duration.
	const sources: SourceStream[] = [];
	for (const url of videoUrls) {
		const decoder = new StreamingVideoDecoder();
		const info = await decoder.loadMetadata(url);
		sources.push({
			channel: new FrameChannel(),
			lastFrame: null,
			width: info.width,
			height: info.height,
			durationSec: info.duration,
			decoder,
			decodeError: null,
		});
	}

	const canvasWidth = Math.ceil(Math.max(...sources.map((source) => source.width)) / 2) * 2;
	const canvasHeight = Math.ceil(Math.max(...sources.map((source) => source.height)) / 2) * 2;
	const durationSec = Math.min(
		manifest.durationMs / 1000,
		Math.max(...sources.map((source) => source.durationSec)),
	);
	const totalFrames = Math.max(1, Math.floor(durationSec * FRAME_RATE));
	const timeline = buildWindowSwitchTimeline(manifest, durationSec * 1000);

	// Start every decoder; frames flow through the channels with backpressure.
	for (const source of sources) {
		void source.decoder
			.decodeAll(FRAME_RATE, undefined, undefined, async (frame) => {
				await source.channel.push(frame);
			})
			.catch((error: unknown) => {
				source.decodeError = error instanceof Error ? error : new Error(String(error));
			})
			.finally(() => {
				source.channel.finish();
			});
	}

	const canvas = document.createElement("canvas");
	canvas.width = canvasWidth;
	canvas.height = canvasHeight;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Failed to create compositor canvas");

	const muxer = new VideoMuxer(
		{ width: canvasWidth, height: canvasHeight, frameRate: FRAME_RATE, bitrate: BITRATE },
		false,
	);
	await muxer.initialize();

	let encodeError: Error | null = null;
	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
			void muxer.addVideoChunk(chunk, meta).catch((error: unknown) => {
				encodeError = error instanceof Error ? error : new Error(String(error));
			});
		},
		error: (error) => {
			encodeError = error;
		},
	});
	encoder.configure({
		codec: CODEC,
		width: canvasWidth,
		height: canvasHeight,
		bitrate: BITRATE,
		framerate: FRAME_RATE,
	});

	const frameDurationUs = 1_000_000 / FRAME_RATE;
	try {
		for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
			const timeMs = (frameIndex / FRAME_RATE) * 1000;

			// Advance every source that still has frames; hold the last frame of
			// sources that ended early.
			for (const source of sources) {
				const frame = await source.channel.next();
				if (frame) {
					source.lastFrame?.close();
					source.lastFrame = frame;
				}
				if (source.decodeError) throw source.decodeError;
			}

			const state = switchStateAt(timeline, timeMs);
			ctx.fillStyle = BACKGROUND;
			ctx.fillRect(0, 0, canvasWidth, canvasHeight);

			if (state.transition) {
				const { outgoingIndex, incomingIndex, progress, direction } = state.transition;
				const sign = direction === "from-right" ? 1 : -1;
				drawSource(
					ctx,
					sources[outgoingIndex],
					canvasWidth,
					canvasHeight,
					-sign * progress * canvasWidth,
				);
				drawSource(
					ctx,
					sources[incomingIndex],
					canvasWidth,
					canvasHeight,
					sign * (1 - progress) * canvasWidth,
				);
			} else {
				drawSource(ctx, sources[state.activeIndex], canvasWidth, canvasHeight, 0);
			}

			const composedFrame = new VideoFrame(canvas, {
				timestamp: Math.round(frameIndex * frameDurationUs),
				duration: Math.round(frameDurationUs),
			});
			// Basic encoder backpressure.
			while (encoder.encodeQueueSize > 60) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			encoder.encode(composedFrame, { keyFrame: frameIndex % KEYFRAME_INTERVAL === 0 });
			composedFrame.close();
			if (encodeError) throw encodeError;

			if (frameIndex % 30 === 0 || frameIndex === totalFrames - 1) {
				onProgress({
					percentage: ((frameIndex + 1) / totalFrames) * 100,
					currentFrame: frameIndex + 1,
					totalFrames,
				});
			}
		}

		await encoder.flush();
		encoder.close();
		const blob = await muxer.finalize();
		return { blob, durationMs: (totalFrames / FRAME_RATE) * 1000, timeline };
	} finally {
		for (const source of sources) {
			source.lastFrame?.close();
			source.lastFrame = null;
			// Drain so pending decodeAll calls can finish and release resources.
			void (async () => {
				let frame = await source.channel.next();
				while (frame) {
					frame.close();
					frame = await source.channel.next();
				}
			})();
		}
	}
}
