import { materializeLocalSourceFile, releaseLocalSourceFile } from "@/lib/exporter/localSourceFile";
import { MAX_IN_MEMORY_SOURCE_BYTES } from "@/lib/exporter/sourceFileLimits";
import { MAX_CAPTION_AUDIO_SEC } from "./captionConstants";
import { extractMonoPcmViaWebDemuxer } from "./extractMono16kWebDemuxer";

export { MAX_CAPTION_AUDIO_SEC };

const FETCH_TIMEOUT_MS = 120_000;
// The demuxer caption path holds every decoded AudioData frame plus full-rate
// merge buffers in memory (~50 MB per minute of 48 kHz audio all-in), so very
// long recordings would exhaust the renderer heap well before the 4 h caption
// ceiling. For sources too large to load in memory anyway, cap the decoded
// audio; captions come back truncated instead of crashing the renderer.
const LARGE_FILE_CAPTION_SEC = 30 * 60;

async function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<Response> {
	const ctrl = new AbortController();
	const timer = window.setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	const onAbort = () => ctrl.abort();
	if (signal) {
		if (signal.aborted) ctrl.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		return await fetch(url, { signal: ctrl.signal });
	} finally {
		window.clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Load the editor video like `StreamingVideoDecoder`: Electron `readBinaryFile`
 * for local paths (fetch(file://) is unreliable in the renderer), otherwise
 * HTTP/blob/data URLs via fetch.
 */
async function loadSourceVideoFile(videoUrl: string, signal?: AbortSignal): Promise<File> {
	const isRemoteUrl = /^(https?:|blob:|data:)/i.test(videoUrl);

	if (!isRemoteUrl && window.electronAPI) {
		// Streams large recordings through OPFS instead of reading them whole, so
		// captions work for multi-GB files just like export does. The signal also
		// aborts the copy itself when the caption pass is cancelled.
		const filename = (videoUrl.split(/[\\/]/).pop() || "video").replace(/^file:/, "");
		return materializeLocalSourceFile(videoUrl, filename, { signal });
	}

	const response = await fetchWithTimeout(videoUrl, signal);
	if (!response.ok) {
		throw new Error(`Failed to load video for captions: ${response.status} ${response.statusText}`);
	}
	const blob = await response.blob();
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	const filename = videoUrl.split("/").pop() || "video";
	return new File([blob], filename, { type: blob.type || "video/webm" });
}

function mixToMono(audioBuffer: AudioBuffer): Float32Array {
	const { length, numberOfChannels } = audioBuffer;
	if (numberOfChannels === 0) return new Float32Array(length);
	// `getChannelData` is a WebIDL call, so calling it INSIDE the sample loop cost
	// one call per sample per channel — ~57 M of them for a ten-minute stereo
	// recording, seconds of blocked main thread. That was survivable while
	// transcription only ran when the user asked for it; it now runs by itself when
	// a project opens, and a frozen window (spinners included) is exactly what the
	// automatic pass must not look like. Hoisting the channel arrays out of the loop
	// leaves plain typed-array indexing.
	const channels: Float32Array[] = [];
	for (let c = 0; c < numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
	// Mono source: the mixdown is a copy. `slice` keeps the caller's contract of
	// owning its buffer (the AudioBuffer's own array is reused by the context).
	if (numberOfChannels === 1) return channels[0].slice();
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		let sum = 0;
		for (let c = 0; c < numberOfChannels; c++) sum += channels[c][i];
		out[i] = sum / numberOfChannels;
	}
	return out;
}

async function resampleMono(
	mono: Float32Array,
	fromRate: number,
	toRate: number,
	signal?: AbortSignal,
): Promise<Float32Array> {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	if (fromRate === toRate) return mono;
	const durationSec = mono.length / fromRate;
	const outLength = Math.max(1, Math.ceil(durationSec * toRate));
	const offline = new OfflineAudioContext(1, outLength, toRate);
	const buf = offline.createBuffer(1, mono.length, fromRate);
	buf.copyToChannel(Float32Array.from(mono), 0);
	const src = offline.createBufferSource();
	src.buffer = buf;
	src.connect(offline.destination);
	src.start(0);
	const rendered = await offline.startRendering();
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	return rendered.getChannelData(0).slice();
}

async function truncateAndResampleTo16k(
	mono: Float32Array,
	fromRate: number,
	durationSec: number,
	signal?: AbortSignal,
): Promise<{ samples: Float32Array; truncated: boolean; durationSec: number }> {
	let truncated = false;
	let work = mono;
	if (durationSec > MAX_CAPTION_AUDIO_SEC) {
		const maxSamples = Math.floor(MAX_CAPTION_AUDIO_SEC * fromRate);
		work = mono.subarray(0, Math.min(mono.length, maxSamples));
		truncated = true;
	}

	const samples = await resampleMono(work, fromRate, 16_000, signal);
	return { samples, truncated, durationSec: samples.length / 16_000 };
}

/**
 * Decode the video's audio track to mono 16 kHz float samples (Whisper input).
 * Prefers `decodeAudioData` when the container is supported, else the same
 * web-demuxer + AudioDecoder path as export.
 */
export async function extractMono16kFromVideoUrl(
	videoUrl: string,
	options?: { signal?: AbortSignal },
): Promise<{ samples: Float32Array; truncated: boolean; durationSec: number }> {
	const file = await loadSourceVideoFile(videoUrl, options?.signal);

	/** When this returns null, use web-demuxer + AudioDecoder (same as export). */
	const tryDecodeAudioDataPath = async (): Promise<{
		samples: Float32Array;
		truncated: boolean;
		durationSec: number;
	} | null> => {
		const audioContext = new AudioContext();
		try {
			const ab = await file.arrayBuffer();
			if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			const audioBuffer = await audioContext.decodeAudioData(ab.slice(0));
			if (
				audioBuffer.numberOfChannels === 0 ||
				audioBuffer.length === 0 ||
				!Number.isFinite(audioBuffer.duration) ||
				audioBuffer.duration <= 0
			) {
				return null;
			}
			const durationSec = audioBuffer.duration;
			const mono = mixToMono(audioBuffer);
			const fromRate = audioBuffer.sampleRate;
			const out = await truncateAndResampleTo16k(mono, fromRate, durationSec, options?.signal);
			// decodeAudioData can resolve for some WebM/Matroska inputs yet yield almost no usable
			// PCM, and captions only fall back to the demuxer path on throw, so return null to recover.
			if (out.samples.length < 800) {
				return null;
			}
			return out;
		} catch {
			return null;
		} finally {
			await audioContext.close().catch(() => undefined);
		}
	};

	try {
		// Large recordings skip the in-memory decodeAudioData path (it would load
		// the whole file) and go straight to the streaming web-demuxer path below.
		const isLargeFile = file.size > MAX_IN_MEMORY_SOURCE_BYTES;
		const primary = isLargeFile ? null : await tryDecodeAudioDataPath();
		if (primary) {
			return primary;
		}

		// For oversized sources, also cap how much audio the demuxer path decodes
		// — its frame/merge buffers are in-memory and scale with duration.
		const pcm = await extractMonoPcmViaWebDemuxer(
			file,
			options?.signal,
			isLargeFile ? LARGE_FILE_CAPTION_SEC : undefined,
		);
		const out = await truncateAndResampleTo16k(
			pcm.mono,
			pcm.sampleRate,
			pcm.durationSec,
			options?.signal,
		);
		return { ...out, truncated: out.truncated || pcm.capped };
	} finally {
		// Release the OPFS cache reference taken when streaming a large source.
		// The File name is the cache-entry key (no-op for small/remote sources).
		releaseLocalSourceFile(file.name);
	}
}
