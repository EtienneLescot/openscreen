// Post-export voiceover mixing for the CLI (`openscreen export --audio`), and
// audio-LAYER mixing for the editor (voiceover + background music placed on
// the timeline).
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

/** Shared remux: copy the video packets untouched, replace the audio track. */
async function remuxWithMixedAudio(videoBlob: Blob, mixedAudio: AudioBuffer): Promise<Blob> {
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
		const durationSec = await input.computeDuration();

		// The full-file bytes are only needed to decode the original bed in
		// "mix" mode; "replace" skips the copy entirely.
		const videoData = options.mode === "mix" ? await videoBlob.arrayBuffer() : null;
		const mixedAudio = await renderMixedAudio(videoData, durationSec, options);

		return await remuxWithMixedAudio(videoBlob, mixedAudio);
	} finally {
		input.dispose();
	}
}

// ── editor audio layers ───────────────────────────────────────────────────

/** One timeline audio layer, already projected onto the EXPORT timeline. */
export interface AudioLayerMixInput {
	/** Encoded audio file bytes. */
	data: ArrayBuffer;
	/** Layer start on the exported timeline, in seconds. */
	startSec: number;
	/** Layer end on the exported timeline, in seconds. */
	endSec: number;
	/** Skip into the source file before it starts playing. */
	offsetSec?: number;
	/** Volume in dB — applied at full scale, so +12 dB can exceed unity. */
	gainDb?: number;
	/** Repeat the source for the layer's whole span. */
	loop?: boolean;
	fadeInMs?: number;
	fadeOutMs?: number;
	/** A muted layer is silent (and skipped entirely at render time). */
	muted?: boolean;
}

export interface MixAudioLayersOptions {
	layers: AudioLayerMixInput[];
	/** Gain applied to the original track (0..1). Default 1 — the exported
	 *  file's own audio (already gain-trimmed by the compositor) is kept
	 *  as-is, with the layers summed on top. */
	originalGain?: number;
}

/** One buffer-source scheduling unit of a layer (one loop iteration, or the
 *  whole non-looping span). Pure, unit-testable. */
export interface AudioLayerIteration {
	/** Start time on the OUTPUT timeline. */
	startSec: number;
	/** Offset into the source file. */
	offsetSec: number;
	/** Source seconds this iteration plays. */
	playSec: number;
}

export function planLayerIterations(
	layer: {
		startSec: number;
		endSec: number;
		offsetSec: number;
		loop: boolean;
	},
	sourceDurationSec: number,
): AudioLayerIteration[] {
	const span = layer.endSec - layer.startSec;
	if (span <= 0) return [];
	const source = Math.max(0, sourceDurationSec - layer.offsetSec);
	if (source <= 0) return [];
	if (!layer.loop) {
		return [
			{
				startSec: layer.startSec,
				offsetSec: layer.offsetSec,
				playSec: Math.min(source, span),
			},
		];
	}
	const iterations: AudioLayerIteration[] = [];
	let cursor = 0;
	// Guard against a pathological tiny loop (sub-millisecond source) never
	// converging.
	while (cursor < span && iterations.length < 100_000) {
		iterations.push({
			startSec: layer.startSec + cursor,
			offsetSec: layer.offsetSec,
			playSec: Math.min(source, span - cursor),
		});
		cursor += source;
	}
	return iterations;
}

/** Gain curve for one layer: fades in/out at the span's edges, held at the
 *  layer's volume in between. A muted layer is silence from the start. */
export function planLayerGain(layer: {
	startSec: number;
	endSec: number;
	fadeInMs: number;
	fadeOutMs: number;
	muted: boolean;
	gainDb: number;
}): Array<{ atSec: number; value: number; ramp?: boolean }> {
	const scalar = layer.muted ? 0 : 10 ** (layer.gainDb / 20);
	const fadeInSec = layer.fadeInMs / 1000;
	const fadeOutSec = layer.fadeOutMs / 1000;
	const events: Array<{ atSec: number; value: number; ramp?: boolean }> = [];
	events.push({ atSec: layer.startSec, value: fadeInSec > 0 ? 0 : scalar });
	if (fadeInSec > 0 && layer.startSec + fadeInSec < layer.endSec) {
		events.push({ atSec: layer.startSec + fadeInSec, value: scalar, ramp: true });
	}
	if (fadeOutSec > 0) {
		const fadeStart = Math.max(layer.startSec, layer.endSec - fadeOutSec);
		events.push({ atSec: fadeStart, value: scalar, ramp: true });
		events.push({ atSec: layer.endSec, value: 0 });
	}
	return events;
}

/** Renders the assembled audio: original bed (optional) + every layer. */
async function renderLayeredAudio(
	videoData: ArrayBuffer | null,
	durationSec: number,
	layers: AudioLayerMixInput[],
	originalGain: number,
): Promise<AudioBuffer> {
	const frameCount = Math.max(1, Math.ceil(durationSec * OUTPUT_SAMPLE_RATE));
	const context = new OfflineAudioContext(OUTPUT_CHANNELS, frameCount, OUTPUT_SAMPLE_RATE);

	if (videoData) {
		try {
			const original = await decodeToBuffer(context, videoData);
			const originalNode = context.createBufferSource();
			originalNode.buffer = original;
			const gainNode = context.createGain();
			gainNode.gain.value = originalGain;
			originalNode.connect(gainNode);
			gainNode.connect(context.destination);
			originalNode.start(0);
		} catch {
			// The exported video has no decodable audio track; the layers
			// become the only audio.
		}
	}

	for (const layer of layers) {
		if (layer.muted || layer.endSec <= layer.startSec) continue;
		const decoded = await decodeToBuffer(context, layer.data);
		const iterations = planLayerIterations(
			{
				startSec: layer.startSec,
				endSec: layer.endSec,
				offsetSec: Math.max(0, layer.offsetSec ?? 0),
				loop: layer.loop ?? false,
			},
			decoded.duration,
		);
		if (iterations.length === 0) continue;

		const gainNode = context.createGain();
		gainNode.connect(context.destination);
		for (const event of planLayerGain({
			startSec: layer.startSec,
			endSec: layer.endSec,
			fadeInMs: layer.fadeInMs ?? 0,
			fadeOutMs: layer.fadeOutMs ?? 0,
			muted: false,
			gainDb: layer.gainDb ?? 0,
		})) {
			if (event.ramp) {
				gainNode.gain.linearRampToValueAtTime(event.value, event.atSec);
			} else {
				gainNode.gain.setValueAtTime(event.value, event.atSec);
			}
		}

		for (const it of iterations) {
			const source = context.createBufferSource();
			source.buffer = decoded;
			source.connect(gainNode);
			source.start(it.startSec, it.offsetSec, it.playSec);
		}
	}

	return context.startRendering();
}

/**
 * Mix any number of audio layers (voiceover / background music) into an
 * already-exported MP4: the video stream is copied untouched, the audio track
 * is re-rendered as original bed + layers. Positions are EXPRESSED IN EXPORTED
 * TIMELINE SECONDS — project them from ruler ms with
 * `audioLayerTimeline.ts` before calling.
 */
export async function mixAudioLayersIntoVideo(
	videoBlob: Blob,
	options: MixAudioLayersOptions,
): Promise<Blob> {
	const layers = options.layers.filter((l) => !l.muted && l.endSec > l.startSec);
	const input = new Input({ source: new BlobSource(videoBlob), formats: ALL_FORMATS });
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new Error("Exported file has no video track to remux");
		}
		const videoDuration = await input.computeDuration();
		const durationSec = Math.max(videoDuration, ...layers.map((l) => l.endSec));

		const videoData = await videoBlob.arrayBuffer();
		const mixedAudio = await renderLayeredAudio(
			videoData,
			durationSec,
			layers,
			options.originalGain ?? 1,
		);

		return await remuxWithMixedAudio(videoBlob, mixedAudio);
	} finally {
		input.dispose();
	}
}
