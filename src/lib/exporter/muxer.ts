import {
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedVideoPacketSource,
	Mp4OutputFormat,
	Output,
} from "mediabunny";
import type { ExportConfig } from "./types";

export type ExportAudioMuxerCodec = "aac" | "opus";

export class VideoMuxer {
	private output: Output | null = null;
	private videoSource: EncodedVideoPacketSource | null = null;
	private audioSource: EncodedAudioPacketSource | null = null;
	private hasAudio: boolean;
	private target: BufferTarget | null = null;
	private config: ExportConfig;
	private audioCodec: ExportAudioMuxerCodec;

	constructor(config: ExportConfig, hasAudio = false, audioCodec: ExportAudioMuxerCodec = "aac") {
		this.config = config;
		this.hasAudio = hasAudio;
		this.audioCodec = audioCodec;
	}

	// Map the WebCodecs codec string (e.g. "avc1.640033", "hvc1.1.6.L120.90",
	// "vp09.00.10.08") to mediabunny's codec family for the mp4 track.
	private videoCodecFamily(): "avc" | "hevc" | "vp9" {
		const codec = (this.config.codec ?? "").toLowerCase();
		if (codec.startsWith("hvc1") || codec.startsWith("hev1")) return "hevc";
		if (codec.startsWith("vp09") || codec.startsWith("vp9")) return "vp9";
		return "avc";
	}

	async initialize(): Promise<void> {
		this.target = new BufferTarget();

		this.output = new Output({
			format: new Mp4OutputFormat({
				fastStart: "in-memory",
			}),
			target: this.target,
		});

		// Codec details are deduced from the chunk metadata; the family must
		// match the encoder codec (F2.4 exposes h264/h265/vp9 in the dialog).
		this.videoSource = new EncodedVideoPacketSource(this.videoCodecFamily());
		this.output.addVideoTrack(this.videoSource, {
			frameRate: this.config.frameRate,
		});

		if (this.hasAudio) {
			this.audioSource = new EncodedAudioPacketSource(this.audioCodec);
			this.output.addAudioTrack(this.audioSource);
		}

		await this.output.start();
	}

	async addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): Promise<void> {
		if (!this.videoSource) {
			throw new Error("Muxer not initialized");
		}

		const packet = EncodedPacket.fromEncodedChunk(chunk);

		await this.videoSource.add(packet, meta);
	}

	async addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): Promise<void> {
		if (!this.audioSource) {
			throw new Error("Audio not configured for this muxer");
		}

		const packet = EncodedPacket.fromEncodedChunk(chunk);

		await this.audioSource.add(packet, meta);
	}

	async finalize(): Promise<Blob> {
		if (!this.output || !this.target) {
			throw new Error("Muxer not initialized");
		}

		await this.output.finalize();
		const buffer = this.target.buffer;

		if (!buffer) {
			throw new Error("Failed to finalize output");
		}

		return new Blob([buffer], { type: "video/mp4" });
	}
}
