import { useEffect, useState } from "react";
import { materializeLocalSourceFile, releaseLocalSourceFile } from "@/lib/exporter/localSourceFile";
import { MAX_IN_MEMORY_SOURCE_BYTES } from "@/lib/exporter/sourceFileLimits";
import { loadFileAsArrayBuffer } from "@/lib/exporter/streamingDecoder";
import { computePeaksFromFileStreaming } from "./streamingAudioPeaks";

let _audioCtx: AudioContext | null = null;
/** Returns the shared AudioContext, creating it lazily on first call. */
function getAudioCtx(): AudioContext {
	if (!_audioCtx) _audioCtx = new AudioContext();
	return _audioCtx;
}

/**
 * Offloads peak computation to a Web Worker (zero-copy via Transferable).
 * On abort, the worker is terminated and the promise rejects with AbortError.
 */
function computePeaksInWorker(
	audioBuffer: AudioBuffer,
	signal?: AbortSignal,
): Promise<Float32Array> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}

		const worker = new Worker(new URL("./audioPeaksWorker.ts", import.meta.url), {
			type: "module",
		});

		const onAbort = () => {
			worker.terminate();
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		// slice() creates an owned copy so the transfer is safe and the
		// AudioBuffer remains valid if anything else holds a reference.
		const channels: Float32Array[] = [];
		for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
			channels.push(audioBuffer.getChannelData(c).slice());
		}

		worker.onmessage = (e: MessageEvent<Float32Array>) => {
			signal?.removeEventListener("abort", onAbort);
			worker.terminate();
			resolve(e.data);
		};

		worker.onerror = (e) => {
			signal?.removeEventListener("abort", onAbort);
			worker.terminate();
			reject(e);
		};

		worker.postMessage(
			{ channels, duration: audioBuffer.duration },
			channels.map((ch) => ch.buffer),
		);
	});
}

/**
 * Bytes one second of decoded audio occupies in an `AudioBuffer`: Float32,
 * stereo, 44.1 kHz. An estimate on purpose — it picks the pipeline, before
 * anything has been decoded and while the real rate is still unknown.
 */
const DECODED_BYTES_PER_SEC = 44_100 * 2 * 4;

/**
 * Routes to the right peaks pipeline. Small/remote files use the original
 * decodeAudioData → worker path. Recordings too big to hold decoded stream
 * instead: the file is materialized into OPFS (reused by the export afterwards)
 * and its audio is decoded chunk-by-chunk into peaks, so the whole recording is
 * never held in memory.
 *
 * "Too big" is measured on the DECODED size, estimated from duration — not on
 * the file's bytes, which is close to meaningless here and is what this used to
 * compare. Compression ratio is the entire point of a screen recording: a
 * 32-minute capture is 68 MB on disk and 656 MB decoded, and the in-memory path
 * then `slice()`s every channel again for the worker transfer. That is ~1.4 GB
 * of transient allocation to draw 400 bars, and it sat comfortably under a
 * 256 MB *file* threshold — so the streaming path built for exactly this case
 * never ran. (`ffmpeg -vn -f null` decodes the same track in 2.1s: that is the
 * floor all that allocation was being piled onto.)
 */
async function computePeaksForUrl(
	videoUrl: string,
	signal?: AbortSignal,
	durationSec?: number,
): Promise<Float32Array> {
	const isRemoteUrl = /^(https?:|blob:|data:)/i.test(videoUrl);

	// Native first. Both browser pipelines below decode the whole track in
	// Chromium — 12s on a 32-minute recording, whichever one runs — where ffmpeg
	// in the main process takes ~2s and caches the result on disk, so the second
	// time it is free. Anything that stops this from working (no ffmpeg staged,
	// an unapproved path, a clip with no audio) falls through rather than
	// dropping the waveform.
	if (!isRemoteUrl && durationSec && window.electronAPI?.getAudioPeaks) {
		try {
			const native = await window.electronAPI.getAudioPeaks(videoUrl, durationSec);
			if (native.success && native.peaks && native.peaks.length > 0) return native.peaks;
		} catch {
			// Fall through to the browser pipelines.
		}
	}

	if (!isRemoteUrl && window.electronAPI?.getReadableFileInfo) {
		const info = await window.electronAPI.getReadableFileInfo(videoUrl);
		const decodedBytes = (durationSec ?? 0) * DECODED_BYTES_PER_SEC;
		if (
			info.success &&
			((typeof info.size === "number" && info.size > MAX_IN_MEMORY_SOURCE_BYTES) ||
				decodedBytes > MAX_IN_MEMORY_SOURCE_BYTES)
		) {
			const filename = (videoUrl.split(/[\\/]/).pop() || "video").replace(/^file:/, "");
			// signal also aborts the OPFS copy (unless the export shares it).
			const file = await materializeLocalSourceFile(videoUrl, filename, { signal });
			try {
				return await computePeaksFromFileStreaming(file, signal);
			} finally {
				releaseLocalSourceFile(file.name);
			}
		}
	}

	const { data: arrayBuffer } = await loadFileAsArrayBuffer(videoUrl);
	const audioBuffer = await getAudioCtx().decodeAudioData(arrayBuffer);
	return computePeaksInWorker(audioBuffer, signal);
}

/**
 * Peaks describe a FILE, so they are cached per file, at module scope.
 *
 * This used to be a `useRef` Map, i.e. one cache per mounted component. Peaks
 * for a 32-minute recording cost seconds and (before the routing fix above) a
 * gigabyte-plus of transient allocation, and that was paid again for every clip
 * of the same asset, and again from scratch on every remount — switching
 * Media↔Edit re-decoded the whole recording, which is what "the waveform takes
 * ages to appear" actually was.
 *
 * `inFlight` is the other half: N clips of one asset mounting together must
 * share a single decode instead of racing N of them.
 */
const peaksCache = new Map<string, Float32Array>();
const peaksInFlight = new Map<string, Promise<Float32Array>>();

function loadPeaks(videoUrl: string, durationSec?: number): Promise<Float32Array> {
	const existing = peaksInFlight.get(videoUrl);
	if (existing) return existing;
	// Deliberately NOT wired to any component's AbortSignal: the work is shared,
	// so one subscriber unmounting must not cancel it for the others. An unmount
	// drops the result instead — and the cache means the next mount is free.
	const promise = computePeaksForUrl(videoUrl, undefined, durationSec)
		.then((p) => {
			peaksCache.set(videoUrl, p);
			return p;
		})
		.finally(() => {
			peaksInFlight.delete(videoUrl);
		});
	peaksInFlight.set(videoUrl, promise);
	return promise;
}

/**
 * Decodes audio from `videoUrl` into paired [min, max] peaks (length = 2 * N
 * blocks). Returns `null` while decoding, and stays `null` on no audio track or
 * decode failure (silent degradation). `durationSec` only picks the pipeline
 * (see `computePeaksForUrl`); omitting it is safe, just slower on long files.
 */
export function useAudioPeaks(videoUrl?: string, durationSec?: number): Float32Array | null {
	const [peaks, setPeaks] = useState<Float32Array | null>(() =>
		videoUrl ? (peaksCache.get(videoUrl) ?? null) : null,
	);

	useEffect(() => {
		if (!videoUrl) {
			setPeaks(null);
			return;
		}

		const cached = peaksCache.get(videoUrl);
		if (cached) {
			setPeaks(cached);
			return;
		}

		setPeaks(null);
		let cancelled = false;

		loadPeaks(videoUrl, durationSec)
			.then((p) => {
				if (!cancelled) setPeaks(p);
			})
			.catch((err: unknown) => {
				if (err instanceof DOMException && err.name === "AbortError") return;
				// No audio track or unsupported format: degrade to no waveform, but log
				// so an unexpectedly-missing waveform is diagnosable.
				console.warn("useAudioPeaks: could not decode audio for waveform:", err);
				if (!cancelled) setPeaks(null);
			});

		return () => {
			cancelled = true;
		};
	}, [videoUrl]);

	return peaks;
}
