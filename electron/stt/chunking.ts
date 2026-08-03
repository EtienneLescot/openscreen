/**
 * Splits a long recording into inference-sized chunks for the STT pipeline.
 *
 * Why chunk at all: whisper-stt-server answers a `/inference` request only once
 * it has transcribed the WHOLE upload, so a 30-minute recording was one ~10
 * minute request with no progress and no recovery — one hiccup lost everything
 * (and undici's 300s `headersTimeout` killed it outright before it ever
 * finished). Per-chunk requests give the caller a progress signal, a retry unit,
 * and requests short enough that no transport timeout is in play.
 *
 * Where the cut lands matters: slicing on a fixed grid cuts mid-word, and
 * whisper then mis-transcribes both halves. So the boundary is nudged to the
 * quietest 20ms frame within a search window around the ideal position — a
 * pause between words in practice.
 *
 * ponytail: energy minimum, not a real VAD. whisper.cpp ships a Silero VAD, but
 * it lives behind the server's own `--vad` flag and would run per REQUEST — it
 * can't tell us where to cut BEFORE we upload. A plain RMS scan over a few
 * seconds is enough to find a pause and costs nothing. If a recording is so
 * dense that no pause exists in the window, the cut lands at the quietest point
 * anyway and one word may be split; upgrade path is an overlap + de-duplication
 * pass on the seam, which is a lot more code than it is worth today.
 */

/** One chunk of the source buffer: `[startSample, endSample)`. */
export interface SttChunkPlan {
	startSample: number;
	/** Exclusive. */
	endSample: number;
}

/** Energy is measured over frames this long; a cut lands on a frame boundary. */
const FRAME_MS = 20;

export interface PlanChunksOptions {
	/** Ideal chunk length. Shorter = smoother progress, more per-request overhead. */
	targetSec?: number;
	/** How far on either side of the ideal boundary to hunt for a pause. */
	searchSec?: number;
}

/**
 * 90s is a compromise between three pressures: progress granularity (the bar
 * only moves once a chunk lands), whisper's own quality (it decodes in 30s
 * windows and loses cross-chunk context at every seam, so more seams is worse),
 * and `whisperServer`'s 280s per-request ceiling — 90s of audio has to
 * transcribe in under that on the SLOWEST machine we care about (~0.3x realtime;
 * this Vulkan box does 3.1x, i.e. ~29s per chunk).
 */
const DEFAULT_TARGET_SEC = 90;

/**
 * Index of the quietest frame start in `[from, to)`, breaking ties toward the
 * frame nearest `preferred`. Both bounds are clamped by the caller; returns
 * `from` when the range holds less than one full frame.
 *
 * The tie-break is not decoration. Digital silence — a muted track, a gap
 * between takes — makes every frame in the window score exactly 0, and keeping
 * the first one would pull every boundary back to `from`, i.e. shorten every
 * chunk by the whole search window (90s → 87s by default, and 10s → 5s in the
 * silent test case). That is extra requests and extra seams bought for nothing,
 * against the very context loss `DEFAULT_TARGET_SEC` is sized to limit.
 */
function quietestFrameStart(
	samples: Float32Array,
	from: number,
	to: number,
	frameSamples: number,
	preferred: number,
): number {
	let bestStart = from;
	let bestEnergy = Number.POSITIVE_INFINITY;
	for (let start = from; start + frameSamples <= to; start += frameSamples) {
		let energy = 0;
		for (let i = start; i < start + frameSamples; i++) {
			energy += samples[i] * samples[i];
		}
		if (
			energy < bestEnergy ||
			(energy === bestEnergy && Math.abs(start - preferred) < Math.abs(bestStart - preferred))
		) {
			bestEnergy = energy;
			bestStart = start;
		}
	}
	return bestStart;
}

/**
 * Plan the chunk boundaries for `samples`. Chunks are contiguous and cover the
 * whole buffer: `chunks[0].startSample === 0`, each `endSample` is the next
 * `startSample`, and the last one ends at `samples.length`.
 */
export function planChunks(
	samples: Float32Array,
	sampleRate: number,
	options: PlanChunksOptions = {},
): SttChunkPlan[] {
	if (samples.length === 0 || sampleRate <= 0) return [];
	const frameSamples = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
	// One frame is the floor: a target shorter than the unit the scan works in
	// would put the ideal boundary BEFORE the earliest legal cut, which is the
	// only way the loop below could fail to make progress.
	const targetSamples = Math.max(
		frameSamples,
		Math.round((options.targetSec ?? DEFAULT_TARGET_SEC) * sampleRate),
	);
	const searchSamples = Math.max(0, Math.round((options.searchSec ?? 3) * sampleRate));

	const chunks: SttChunkPlan[] = [];
	let start = 0;
	while (start < samples.length) {
		const ideal = start + targetSamples;
		// Last chunk: what's left is at most one target long, so there's nothing to cut.
		if (ideal >= samples.length) {
			chunks.push({ startSample: start, endSample: samples.length });
			break;
		}
		// The search window never reaches back to `start` (a zero-length chunk would
		// loop forever) and never past the end of the buffer.
		const from = Math.max(start + frameSamples, ideal - searchSamples);
		const to = Math.min(samples.length, ideal + searchSamples);
		// No clamping needed on either side: `ideal >= from` because `targetSamples`
		// is at least one frame, and every value the scan can return lies in
		// `[from, to)` — so the cut is always past `start` and inside the buffer.
		const endSample =
			to > from ? quietestFrameStart(samples, from, to, frameSamples, ideal) : ideal;
		chunks.push({ startSample: start, endSample });
		start = endSample;
	}
	return chunks;
}
