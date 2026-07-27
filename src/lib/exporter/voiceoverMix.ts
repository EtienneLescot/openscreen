// Post-export voiceover mixing for the CLI (`openscreen export --audio`).
//
// Takes the finished MP4 blob, copies its video packets untouched (no
// re-encode), renders a new audio track with OfflineAudioContext — the
// original audio and the voiceover mixed, or the voiceover alone — and
// re-muxes both into a new MP4 via mediabunny.

import {
	ALL_FORMATS,
	AudioBufferSource,
	BlobSource,
	BufferTarget,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	Mp4OutputFormat,
	Output,
} from "mediabunny";

export type VoiceoverMixMode = "mix" | "replace";

export interface VoiceoverMixOptions {
	/** Encoded audio file bytes (mp3/wav/m4a — anything decodeAudioData accepts). */
	voiceoverData: ArrayBuffer;
	mode: VoiceoverMixMode;
	/** Delay before the voiceover starts, in seconds. */
	offsetSec: number;
	/** Gain applied to the original track in "mix" mode (0..1). */
	originalGain?: number;
}

// Duck the original bed under the voiceover by default so the unity-gain sum
// of two loud sources doesn't hard-clip.
const DEFAULT_ORIGINAL_GAIN = 0.4;

const OUTPUT_SAMPLE_RATE = 48_000;
const OUTPUT_CHANNELS = 2;
const VOICEOVER_AUDIO_BITRATE = 192_000;

async function decodeToBuffer(
	context: OfflineAudioContext,
	data: ArrayBuffer,
): Promise<AudioBuffer> {
	// decodeAudioData detaches the buffer, so hand it a copy.
	return context.decodeAudioData(data.slice(0));
}

/** Renders the final audio track: original bed (optional) + offset voiceover. */
async function renderMixedAudio(
	videoData: ArrayBuffer | null,
	durationSec: number,
	options: VoiceoverMixOptions,
): Promise<AudioBuffer> {
	const frameCount = Math.max(1, Math.ceil(durationSec * OUTPUT_SAMPLE_RATE));
	const context = new OfflineAudioContext(OUTPUT_CHANNELS, frameCount, OUTPUT_SAMPLE_RATE);

	const voiceover = await decodeToBuffer(context, options.voiceoverData);
	const voiceoverNode = context.createBufferSource();
	voiceoverNode.buffer = voiceover;
	voiceoverNode.connect(context.destination);
	voiceoverNode.start(Math.max(0, options.offsetSec));

	if (options.mode === "mix" && videoData) {
		try {
			const original = await decodeToBuffer(context, videoData);
			const originalNode = context.createBufferSource();
			originalNode.buffer = original;
			const gainNode = context.createGain();
			gainNode.gain.value = options.originalGain ?? DEFAULT_ORIGINAL_GAIN;
			originalNode.connect(gainNode);
			gainNode.connect(context.destination);
			originalNode.start(0);
		} catch {
			// The exported video has no decodable audio track; the voiceover
			// becomes the only audio, same as "replace".
		}
	}

	return context.startRendering();
}

/**
 * Returns a new MP4 blob with the same video stream and the mixed audio track.
 * The video packets are copied without re-encoding.
 */
export async function mixVoiceoverIntoVideo(
	videoBlob: Blob,
	options: VoiceoverMixOptions,
): Promise<Blob> {
	const input = new Input({ source: new BlobSource(videoBlob), formats: ALL_FORMATS });
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new Error("Exported file has no video track to remux");
		}
		const codec = videoTrack.codec;
		if (!codec) {
			throw new Error("Exported file's video codec was not recognized");
		}
		const decoderConfig = await videoTrack.getDecoderConfig();
		if (!decoderConfig) {
			throw new Error("Exported file's video decoder config could not be read");
		}
		const durationSec = await input.computeDuration();

		// The full-file bytes are only needed to decode the original bed in
		// "mix" mode; "replace" skips the copy entirely.
		const videoData = options.mode === "mix" ? await videoBlob.arrayBuffer() : null;
		const mixedAudio = await renderMixedAudio(videoData, durationSec, options);

		const target = new BufferTarget();
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: "in-memory" }),
			target,
		});
		try {
			const videoSource = new EncodedVideoPacketSource(codec);
			output.addVideoTrack(videoSource);
			const audioSource = new AudioBufferSource({
				codec: "aac",
				bitrate: VOICEOVER_AUDIO_BITRATE,
			});
			output.addAudioTrack(audioSource);
			await output.start();

			const sink = new EncodedPacketSink(videoTrack);
			let isFirstPacket = true;
			for await (const packet of sink.packets()) {
				await videoSource.add(packet, isFirstPacket ? { decoderConfig } : undefined);
				isFirstPacket = false;
			}
			await audioSource.add(mixedAudio);

			await output.finalize();
		} catch (error) {
			await output.cancel().catch(() => undefined);
			throw error;
		}
		const buffer = target.buffer;
		if (!buffer) {
			throw new Error("Voiceover remux produced no output");
		}
		return new Blob([buffer], { type: "video/mp4" });
	} finally {
		input.dispose();
	}
}
