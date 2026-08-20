import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type CropRegion,
	DEFAULT_CROP_REGION,
	MAX_NATIVE_PLAYBACK_RATE,
} from "@/components/video-editor/types";
import { resolvePlaybackSegments } from "@/lib/ai-edition/document/timeline";
import type { AxcutClip, AxcutTrimRange, AxcutZoomRegion } from "@/lib/ai-edition/schema";
import { audioGainScalar } from "@/lib/ai-edition/store/editorSettings";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import type { PlaybackClockRef } from "@/lib/ai-edition/timeline/playback-clock";
import { findActiveSpeedRegion, type SpeedRegion } from "@/lib/ai-edition/timeline/speed";
import {
	clampVirtualTime,
	findNextKeptSegment,
	findRawClipForSegment,
	getRawVirtualStartTime,
	locateKeptSegment,
	locateSourcePosition,
	locateVirtualPosition,
	totalVirtualDuration,
} from "@/lib/ai-edition/timeline/virtual-preview";
import {
	computeZoomPreviewTransform,
	IDENTITY_ZOOM_TRANSFORM,
} from "@/lib/ai-edition/timeline/zoom-preview";
import {
	describeMediaError,
	formatMediaError,
	mediaErrorDisposition,
	pruneReloads,
	retryDelayMs,
} from "./mediaError";
import styles from "./VirtualPreview.module.css";

export interface VideoSource {
	id: string;
	src: string;
	/** Original filesystem path, used by the main process to expose the second audio track. */
	filePath?: string;
	label: string;
}

/**
 * Where an audio element should sit to track the video, and whether it should be playing.
 *
 * The audio elements mirror the video's own time — there is no offset to apply, because the
 * only per-track difference that survives is length: the supplemental track is extracted
 * separately and can end before the video does. Past its end the element is parked at its
 * duration and paused rather than left seeking into nothing.
 *
 * Only an unusable duration falls back to Infinity — `NaN` before the element has its
 * metadata, or a negative value. Zero is a real length, and the shortest track that is
 * already over: an empty extraction has to read as ended, or the rAF loop below spends the
 * whole timeline seeking and calling `play()` on an element that has nothing to play.
 */
export function resolveAudioTrackPlayback(
	videoTimeSec: number,
	durationSec = Number.POSITIVE_INFINITY,
) {
	const finiteDuration = Number.isFinite(durationSec) && durationSec >= 0 ? durationSec : Infinity;
	return {
		targetTimeSec: Math.min(Math.max(0, videoTimeSec), finiteDuration),
		shouldPlay: videoTimeSec >= 0 && videoTimeSec < finiteDuration,
	};
}

export interface PreviewAudioGraph {
	context: AudioContext;
	gain: GainNode;
}

/**
 * The preview's ONLY audio processing is the output trim, and that is deliberate: it is
 * the same `10 ** (dB / 20)` scalar `finish_audio` applies natively, so what the editor
 * plays is what the export writes.
 *
 * Nothing with state belongs here. The export runs on the assembled timeline (trimmed,
 * speed-adjusted, concatenated); the preview runs on the untouched source file, seeked.
 * A filter or a compressor would see a different signal on each side and drift — and an
 * offline stage measured over the whole programme (a loudness normaliser) cannot exist
 * here at all, because the preview never holds that programme.
 */
export function applyPreviewAudioSettings(
	graph: PreviewAudioGraph | null,
	elements: Array<HTMLAudioElement | null>,
	gainDb: number,
): void {
	const outputGain = audioGainScalar(gainDb);
	if (!graph) {
		for (const element of elements) {
			if (element) element.volume = Math.min(1, outputGain);
		}
		return;
	}
	graph.gain.gain.value = outputGain;
}

/** First clip (by timeline order) starting strictly after `afterTimelineStartSec` —
 *  independent of the `clips` array's own order, which is never guaranteed to match
 *  timeline order (a clip can be inserted/reordered at any array index; only
 *  `timelineStartSec` is authoritative). Shared by every clip-boundary-advance path
 *  (rAF tick, the `<video>` `ended` event) so they all agree on "the next clip". */
function findNextClipByTimelineOrder(
	clips: AxcutClip[],
	afterTimelineStartSec: number,
): AxcutClip | undefined {
	return clips
		.filter((clip) => clip.timelineStartSec > afterTimelineStartSec + 0.001)
		.sort((a, b) => a.timelineStartSec - b.timelineStartSec)[0];
}

interface VirtualPreviewProps {
	videoSources: VideoSource[];
	clips: AxcutClip[];
	zoomRegions?: AxcutZoomRegion[];
	speedRegions?: SpeedRegion[];
	trimRanges?: AxcutTrimRange[];
	seekTarget?: { timeSec: number; isSource?: boolean; requestId: number } | null;
	onTimeChange?: (timeSec: number) => void;
	onLoadedMetadata?: (
		durationSec: number,
		assetId: string,
		videoWidth: number,
		videoHeight: number,
	) => void;
	onVideoElement?: (element: HTMLVideoElement | null) => void;
	videoStyle?: React.CSSProperties;
	/** Called with the id of the asset that failed, not as a bare "the preview is
	 *  broken" signal: only ONE source is mounted at a time (`activeSource`), so
	 *  the caller has no other way to tell which of its sources is dead.
	 *  Fires only once the retry budget below is spent — a transient decode or
	 *  network blip is reloaded here and never reaches the caller. `detail`
	 *  carries the MediaError code for the card and for bug reports. */
	onVideoError?: (assetId: string, detail: string) => void;
	/** The mounted source produced a frame again — after a reload, or simply
	 *  because the playhead moved onto a healthy asset. The caller needs this to
	 *  drop a failure it is showing; without it, a card outlives its failure and
	 *  we are back to a latch, only quieter. */
	onVideoRecovered?: (assetId: string) => void;
	/** Bumped by the caller's Retry button. A user-initiated reload always runs:
	 *  it cancels any pending backoff and starts the budget over, because the
	 *  user clicked knowing something changed (they put the file back). */
	retryToken?: number;
	/** Crop of the active clip, as fractions (0-1) of the source frame. Absent/
	 * identity ({x:0,y:0,width:1,height:1}) renders the full frame, unchanged
	 * from before crop support existed. */
	cropRegion?: CropRegion | null;
	/**
	 * Written every rAF tick with this video's live position/rate so other
	 * media elements (the webcam overlay) can read it directly instead of
	 * waiting for a React state round trip. See playback-clock.ts.
	 */
	clockRef?: PlaybackClockRef;
}

export function VirtualPreview({
	videoSources,
	clips,
	zoomRegions = [],
	speedRegions = [],
	trimRanges = [],
	seekTarget,
	onTimeChange,
	onLoadedMetadata,
	onVideoElement,
	videoStyle,
	onVideoError,
	onVideoRecovered,
	retryToken,
	cropRegion,
	clockRef,
}: VirtualPreviewProps) {
	const { settings } = useEditorSettings();
	// ponytail: an oversized, offset video inside .videoFrame's overflow:hidden
	// box — the same "scale + negative-position the full frame, let the
	// container clip the rest" technique the export renderer uses via a Pixi
	// sprite offset (frameRenderer.ts's updateLayout). Percentages here
	// resolve against .videoFrame's own (already crop-corrected, see
	// PreviewCanvas's screenSize) box, so this stays correct at any size
	// without measuring pixels. Identity crop reduces to 100%/100%/0/0 — the
	// exact same box the video rendered in before crop support existed.
	const region = cropRegion ?? DEFAULT_CROP_REGION;
	const isIdentityCrop =
		region.x === 0 && region.y === 0 && region.width === 1 && region.height === 1;
	const cropVideoStyle: React.CSSProperties = isIdentityCrop
		? {}
		: {
				position: "absolute",
				width: `${100 / region.width}%`,
				height: `${100 / region.height}%`,
				left: `${(-region.x * 100) / region.width}%`,
				top: `${(-region.y * 100) / region.height}%`,
			};
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const primaryAudioRef = useRef<HTMLAudioElement | null>(null);
	const supplementalAudioRef = useRef<HTMLAudioElement | null>(null);
	const [primaryAudioEl, setPrimaryAudioEl] = useState<HTMLAudioElement | null>(null);
	const [supplementalAudioEl, setSupplementalAudioEl] = useState<HTMLAudioElement | null>(null);
	const [supplementalAudioSrc, setSupplementalAudioSrc] = useState<string | null>(null);
	const [audioProbeComplete, setAudioProbeComplete] = useState(false);
	const audioGainDbRef = useRef(settings.audioGainDb);
	useEffect(() => {
		audioGainDbRef.current = settings.audioGainDb;
	}, [settings.audioGainDb]);
	const audioContextRef = useRef<AudioContext | null>(null);
	const audioContextCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const audioSourceNodesRef = useRef(new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>());
	const audioGraphRef = useRef<PreviewAudioGraph | null>(null);
	const videoFrameRef = useRef<HTMLDivElement | null>(null);

	const isProgrammaticSeekRef = useRef(false);
	// The seek that arrived while another was still running (see applySourceTime).
	const pendingScrubTargetRef = useRef<number | null>(null);
	const pendingSeekRef = useRef<{ sourceTimeSec: number; play: boolean } | null>(null);
	// When each AUTOMATIC reload happened. The budget is "reloads inside
	// RELOAD_WINDOW_MS", so it expires by itself: a dead file burns it in
	// seconds, while the occasional transient across a long editing session
	// never accumulates. A lifetime count could not tell those apart and would
	// eventually show a card on healthy media (see mediaError.ts).
	const reloadsRef = useRef<number[]>([]);
	// Set when we stop trying, so an expiring window cannot restart the cycle
	// behind the card. Cleared only by Retry or a media change.
	const gaveUpRef = useRef(false);
	const retryTimerRef = useRef<number | null>(null);
	// True from the moment a reload is scheduled until the element produces
	// metadata again. Read by the rAF tick, which must not steer a dead decoder.
	const recoveringRef = useRef(false);
	// The last position read off a healthy element. `video.currentTime` is 0
	// after load(), and 0 after a load that failed before decoding a frame, so
	// it cannot be the fallback resume point — that is a silent rewind.
	const lastGoodSourceTimeRef = useRef(0);
	// Which clip the rAF tick below believes is currently playing — set
	// whenever a seek unambiguously resolves one (via locateVirtualPosition,
	// timeline position → clip). Passed back into locateSourcePosition so
	// two clips that share the same source asset (and possibly the same
	// source range) don't get conflated: without this, resolving "current
	// clip" from (assetId, sourceTime) alone always picks the earliest
	// matching clip, even while a later one is the one actually playing.
	const activeClipIdRef = useRef<string | null>(null);
	const [virtualTimeSec, setVirtualTimeSec] = useState(0);
	const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [sourceIndex, setSourceIndex] = useState(0);

	const virtualDurationSec = useMemo(() => totalVirtualDuration(clips), [clips]);
	const activeSource = videoSources[sourceIndex] ?? null;

	useEffect(() => {
		let cancelled = false;
		setSupplementalAudioSrc(null);
		setAudioProbeComplete(false);
		if (!activeSource?.filePath || !window.electronAPI?.preparePreviewAudioTrack) {
			setAudioProbeComplete(true);
			return () => {
				cancelled = true;
			};
		}
		void window.electronAPI.preparePreviewAudioTrack(activeSource.filePath).then(
			(result) => {
				if (cancelled) return;
				setSupplementalAudioSrc(result.success ? (result.path ?? null) : null);
				setAudioProbeComplete(true);
			},
			() => {
				if (cancelled) return;
				setSupplementalAudioSrc(null);
				setAudioProbeComplete(true);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [activeSource?.filePath]);

	// Sum the audio elements into one gain node so the output trim can boost past 0 dB,
	// which `element.volume` cannot do. The primary media element carries track 1; on macOS
	// the existing IPC helper extracts track 2 (normally the microphone) so both are audible
	// instead of Chromium silently choosing one.
	useEffect(() => {
		if (!primaryAudioEl || !audioProbeComplete) return;
		if (supplementalAudioSrc && !supplementalAudioEl) return;
		const elements = [primaryAudioEl, supplementalAudioEl].filter(
			(value): value is HTMLAudioElement => Boolean(value),
		);
		const graph = ((): PreviewAudioGraph | null => {
			try {
				let context = audioContextRef.current;
				if (!context || context.state === "closed") {
					context = new AudioContext();
					audioContextRef.current = context;
					audioSourceNodesRef.current = new WeakMap();
				}
				const gain = context.createGain();
				gain.connect(context.destination);
				return { context, gain };
			} catch {
				return null;
			}
		})();
		if (!graph) {
			// WebAudio can be unavailable in unit tests or under a denied audio policy. No source
			// node was created, so `volume` still reaches the output — capped at 0 dB.
			applyPreviewAudioSettings(null, elements, audioGainDbRef.current);
			return;
		}

		const connectedSources: MediaElementAudioSourceNode[] = [];
		for (const element of elements) {
			try {
				let source = audioSourceNodesRef.current.get(element);
				if (!source) {
					source = graph.context.createMediaElementSource(element);
					audioSourceNodesRef.current.set(element, source);
				}
				source.disconnect();
				source.connect(graph.gain);
				connectedSources.push(source);
			} catch {
				// Routing THIS element failed; leave the others alone. Once
				// createMediaElementSource has run for an element its audio no longer reaches
				// the default output, so tearing the whole graph down here would mute the
				// preview outright rather than degrade it.
			}
		}
		audioGraphRef.current = graph;
		applyPreviewAudioSettings(graph, elements, audioGainDbRef.current);
		return () => {
			audioGraphRef.current = null;
			for (const source of connectedSources) source.disconnect();
			graph.gain.disconnect();
		};
	}, [primaryAudioEl, supplementalAudioEl, supplementalAudioSrc, audioProbeComplete]);

	// Keep one AudioContext for the component. Closing and recreating it on an effect rerun
	// permanently silences an HTMLAudioElement because createMediaElementSource may only be
	// called once for that element. Delay final cleanup by one task so React StrictMode's
	// intentional setup → cleanup → setup cycle can cancel the close and reuse the context.
	useEffect(() => {
		if (audioContextCloseTimerRef.current) {
			clearTimeout(audioContextCloseTimerRef.current);
			audioContextCloseTimerRef.current = null;
		}
		return () => {
			// Nothing to tear down means nothing to schedule. WebAudio is unavailable
			// under jsdom and under a denied audio policy, so this ref is often still
			// null — and an unmount that leaves a timer behind for a context that was
			// never created is both waste and a lie to anyone counting timers to prove
			// this component cleans up after itself (see VirtualPreview.mediaError).
			if (!audioContextRef.current) return;
			audioContextCloseTimerRef.current = setTimeout(() => {
				audioContextCloseTimerRef.current = null;
				const context = audioContextRef.current;
				audioContextRef.current = null;
				audioSourceNodesRef.current = new WeakMap();
				if (context) void context.close();
			}, 0);
		};
	}, []);

	useEffect(() => {
		applyPreviewAudioSettings(
			audioGraphRef.current,
			[primaryAudioRef.current, supplementalAudioRef.current],
			settings.audioGainDb,
		);
	}, [settings.audioGainDb]);

	const setPrimaryAudioElement = useCallback((element: HTMLAudioElement | null) => {
		primaryAudioRef.current = element;
		setPrimaryAudioEl(element);
	}, []);
	const setSupplementalAudioElement = useCallback((element: HTMLAudioElement | null) => {
		supplementalAudioRef.current = element;
		setSupplementalAudioEl(element);
	}, []);

	// ponytail: the cursor overlay wants source-media time (the recorded
	// cursor samples live on the original mp4 timeline, not the edited
	// virtual timeline). `setSourceTimeSec` is called from the 60 Hz rAF
	// below so the cursor follows the playhead even when the user scrubs.
	const [sourceTimeSec, setSourceTimeSec] = useState(0);

	// Drive the virtual-time preview clock at 60 Hz (the <video> timeupdate
	// event only fires ~4×/s, which is too slow to keep the webcam <video>
	// and any future audio element in sync — a 4 Hz sync lets the webcam
	// drift up to ~250 ms between corrections and produces a visible
	// audio/video desync). The virtual-time read here mirrors what
	// handleTimeUpdate does on every timeupdate; running it 60×/s keeps
	// the drift under a single frame (~16 ms). Inlined here so the rAF
	// can also handle clip-end advancement and the !position fall-back
	// without a separate <video onTimeUpdate> event firing at ~4 Hz.
	const sourceTimeSecRef = useRef(0);
	sourceTimeSecRef.current = sourceTimeSec;
	// ponytail: the rAF closure captured the props at mount time. The
	// auto-created clip arrives a tick after the source swaps, so reads
	// from the closure would forever see `clips: []` and the rAF would
	// bail at the `clips.length === 0` guard — leaving the scrub thumb
	// stuck at 0% and the drag range at `max=1`. The refs let the rAF
	// always see the latest values without re-creating on every clip
	// mutation.
	const clipsRef = useRef(clips);
	clipsRef.current = clips;
	// Trim-narrowed (`resolvePlaybackSegments`) — used ONLY to detect "has the <video>'s own
	// currentTime drifted into a trim" and where to jump it back out to. Everything ELSE in
	// this component (`clips`/`clipsRef` above, virtualTimeSec, zoom/speed region lookups,
	// what gets reported via `onTimeChange`) stays on the RAW/document timeline — the same
	// coordinate space the ruler, zoom/speed regions, and the trim marker itself use. Keeping
	// these two lists separate (rather than swapping `clips` itself to the trim-narrowed one)
	// is what makes the reported playhead jump OVER a trim marker instead of drifting out of
	// sync with it: `locateSourcePosition` below, fed RAW clips, maps the underlying video's
	// source time to a RAW virtual time that jumps discontinuously by exactly the trim's
	// width the moment the video itself jumps — matching the marker's own pixel span.
	const playbackClips = useMemo(
		() => resolvePlaybackSegments(clips, trimRanges),
		[clips, trimRanges],
	);
	const playbackClipsRef = useRef(playbackClips);
	playbackClipsRef.current = playbackClips;
	const videoSourcesRef = useRef(videoSources);
	videoSourcesRef.current = videoSources;
	const sourceIndexRef = useRef(sourceIndex);
	sourceIndexRef.current = sourceIndex;
	const virtualTimeSecRef = useRef(virtualTimeSec);
	virtualTimeSecRef.current = virtualTimeSec;
	const virtualDurationSecRef = useRef(virtualDurationSec);
	virtualDurationSecRef.current = virtualDurationSec;
	const speedRegionsRef = useRef(speedRegions);
	speedRegionsRef.current = speedRegions;
	// Same reasoning as `clipsRef` above, for the one thing the rAF calls rather than reads:
	// `seekToVirtualTime` is a `useCallback` whose deps include `clips`, so it takes a new
	// identity on every clip mutation — a REORDER included. The rAF below is deliberately
	// re-created only when the active source swaps, so calling that callback straight from
	// the closure pins it to the clip order current at the last asset swap. The tick would
	// then pick the RIGHT next clip (it reads `clipsRef.current`, always fresh) and hand its
	// timeline time to a `locateVirtualPosition` resolving against the STALE layout, landing
	// on whichever clip used to occupy that position — the one that just played. That is the
	// "playback stops at the junction and jumps back to the start of the clip it just
	// finished, but only after reordering" bug: with no reorder both arrays are identical, so
	// nothing shows. Assigned after the callback exists, below; read through the ref here so
	// the tick always invokes the latest closure.
	const seekToVirtualTimeRef = useRef<
		((nextVirtualTimeSec: number, preservePlayback?: boolean, forceResume?: boolean) => void) | null
	>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-create the rAF when the active source swaps.
	useEffect(() => {
		let raf = 0;
		const tick = () => {
			raf = window.requestAnimationFrame(tick);
			const v = videoRef.current;
			if (!v || !Number.isFinite(v.currentTime)) {
				return;
			}
			for (const audio of [primaryAudioRef.current, supplementalAudioRef.current]) {
				if (!audio) continue;
				const target = resolveAudioTrackPlayback(v.currentTime, audio.duration);
				if (audio.playbackRate !== v.playbackRate) audio.playbackRate = v.playbackRate;
				if (Math.abs(audio.currentTime - target.targetTimeSec) > 0.025) {
					try {
						audio.currentTime = target.targetTimeSec;
					} catch {
						// media metadata not ready yet
					}
				}
				if (!v.paused && target.shouldPlay && audio.paused) {
					if (audioGraphRef.current?.context.state === "suspended") {
						void audioGraphRef.current.context.resume();
					}
					const playback = audio.play();
					if (playback) void playback.catch(() => undefined);
				} else if ((v.paused || !target.shouldPlay) && !audio.paused) {
					audio.pause();
				}
			}
			// Publish this frame's live position/rate for other media elements
			// (webcam) to read directly — see playback-clock.ts for why this
			// bypasses React state entirely.
			if (clockRef) {
				clockRef.current.sourceTimeSec = v.currentTime;
				clockRef.current.isPlaying = !v.paused;
				clockRef.current.playbackRate = v.playbackRate;
				clockRef.current.virtualTimeSec = virtualTimeSecRef.current;
			}
			// A reload is in flight: the decoder is dead and `currentTime` is
			// frozen (or already reset to 0), so every decision below — trim
			// skipping, the clip-boundary advance, the unmapped-position
			// fallback — would be taken on a lie, and the seeks two of them fire
			// would clobber the resume queued for the reload. Deliberately BELOW
			// the clock publish: the webcam overlay freezes on the last good
			// position rather than jumping. Note this cannot ride on `v.paused`,
			// the gate the rest of the tick uses — an `error` does not fire
			// `pause`, so a failure mid-playback leaves `paused` false.
			if (recoveringRef.current) {
				return;
			}
			const activeSourceId = videoSourcesRef.current[sourceIndexRef.current]?.id;
			// Trims only trim ahead during actual playback — scrubbing/paused seeks are
			// intentionally NOT clamped, so the user can navigate freely into a trim while
			// editing; only Play/export treats it as a cut (mirrors the pre-existing intent
			// this replaces). Jump is on the SOURCE clock only: the RAW virtual-time report
			// below (locateSourcePosition against `clipsRef.current`, unchanged) naturally
			// jumps by the trim's exact width the instant `v.currentTime` does, so the ruler's
			// playhead visually skips the trim marker instead of drifting through it.
			if (!v.paused) {
				// Resolved against the segments of the clip we are ACTUALLY playing (see
				// `locateKeptSegment`). Asking the whole segment list — all this could do
				// before a trim named its clip — let a twin clip over the same recording
				// answer "yes, that stretch is kept" for a cut authored on this one, so the
				// cut was simply not skipped during playback.
				const inKeptSegment = locateKeptSegment(
					playbackClipsRef.current,
					clipsRef.current,
					v.currentTime,
					activeSourceId,
					activeClipIdRef.current ?? undefined,
				);
				if (!inKeptSegment) {
					const nextKeptSegment = findNextKeptSegment(
						playbackClipsRef.current,
						clipsRef.current,
						virtualTimeSecRef.current,
						activeSourceId,
						v.currentTime,
						activeClipIdRef.current ?? undefined,
					);
					if (nextKeptSegment) {
						// `findRawClipForSegment` is the ONE definition of the segment-id
						// convention `resolvePlaybackSegments` emits; this used to re-implement
						// it verbatim, which is precisely the second reader that definition
						// exists to prevent.
						const rawClip = findRawClipForSegment(nextKeptSegment, clipsRef.current);
						if (rawClip) {
							activeClipIdRef.current = rawClip.id;
						}
						const rawTargetTime = getRawVirtualStartTime(nextKeptSegment, clipsRef.current);
						seekToVirtualTimeRef.current?.(rawTargetTime, true);
						return;
					}
					v.pause();
					updateVirtualTime(virtualDurationSecRef.current);
					return;
				}
			}
			// ponytail: also push setSourceTimeSec every frame (was previously
			// in a separate rAF effect). Cheap; <video>.readyState >= 2 guards
			// against drawing a black frame into the cursor overlay.
			if (v.readyState >= 2) {
				// One read, three uses: `currentTime` is a live accessor into the
				// media pipeline and this block runs 60×/s.
				const sourceTime = v.currentTime;
				setSourceTimeSec(sourceTime);
				// Sampled here, where the decoder is known good, because this is
				// where a reload has to put the playhead back if it cannot
				// resolve one from the timeline.
				lastGoodSourceTimeRef.current = sourceTime;
			}
			// À L'ARRÊT, le `<video>` ne pilote PLUS la position de la timeline.
			//
			// Ce tick publie `updateVirtualTime(...)` dérivé de `v.currentTime`. Pendant la
			// lecture c'est la bonne source : le média avance, la tête le suit. À l'arrêt
			// c'est l'inverse — l'utilisateur possède la tête de lecture, et le `<video>`
			// doit la SUIVRE. Sans ce garde, un scrub était écrasé à chaque frame par la
			// position d'un élément encore en train de chercher ; et près d'une frontière de
			// clips, `locateSourcePosition` ne résolvait pas, si bien que le repli
			// `seekToVirtualTimeRef(nextClip.timelineStartSec)` plus bas renvoyait la tête au
			// DÉBUT du clip voisin — le tressaillement observé au passage d'un clip à l'autre.
			//
			// `clockRef` et `setSourceTimeSec` ci-dessus continuent d'être publiés : la webcam
			// et le calque curseur ont besoin du temps source même à l'arrêt. Seule la
			// position de la TIMELINE cesse d'être dictée par le média.
			if (v.paused) {
				return;
			}
			if (clipsRef.current.length === 0) {
				// ponytail: no clip yet (auto-create runs from
				// handleLoadedMetadata on the next tick). Push the raw
				// source time as the virtual time so the scrub thumb
				// advances and the timecode shows real progress during
				// playback. The proper timeline-aware mapping kicks in
				// when the auto-created clip arrives.
				updateVirtualTime(v.currentTime);
				return;
			}
			if (isProgrammaticSeekRef.current) {
				isProgrammaticSeekRef.current = false;
				const pos = locateSourcePosition(
					clipsRef.current,
					v.currentTime,
					activeSourceId,
					0.05,
					activeClipIdRef.current ?? undefined,
				);
				if (pos) {
					activeClipIdRef.current = pos.clip.id;
					updateVirtualTime(clampVirtualTime(clipsRef.current, pos.virtualTimeSec));
				}
				return;
			}
			const position = locateSourcePosition(
				clipsRef.current,
				v.currentTime,
				activeSourceId,
				0.05,
				activeClipIdRef.current ?? undefined,
			);
			if (!position) {
				// ponytail: fall back to timeline order so cross-asset / reordered
				// clips don't keep playing unmapped media.
				const nextClip = findNextClipByTimelineOrder(clipsRef.current, virtualTimeSecRef.current);
				if (nextClip) seekToVirtualTimeRef.current?.(nextClip.timelineStartSec, true);
				else {
					v.pause();
					updateVirtualTime(virtualDurationSecRef.current);
				}
				return;
			}
			activeClipIdRef.current = position.clip.id;
			const reachedClipEnd = v.currentTime >= (position.clip.sourceEndSec ?? Infinity) - 0.04;
			if (reachedClipEnd) {
				// BUG corrigé : `clipsRef.current[position.clipIndex + 1]` supposait que le
				// tableau brut (`document.timeline.clips`, jamais trié) était déjà dans l'ordre
				// temporel — s'il ne l'était pas (clip ajouté/splitté à un index qui ne reflète
				// pas son `timelineStartSec`), ce lookup retournait `undefined` même quand un
				// clip suivant existait bel et bien, ce qui déclenchait un arrêt de la lecture
				// au lieu d'enchaîner — le "ça se stoppe en fin de clip" observé. Recherche par
				// temps de timeline (comme le fallback juste au-dessus et
				// `NativeCompositorOverlay`), indépendante de l'ordre du tableau.
				const nextClip = findNextClipByTimelineOrder(
					clipsRef.current,
					position.clip.timelineStartSec,
				);
				if (!nextClip) {
					v.pause();
					updateVirtualTime(virtualDurationSecRef.current);
					return;
				}
				seekToVirtualTimeRef.current?.(nextClip.timelineStartSec, true);
				return;
			}
			updateVirtualTime(clampVirtualTime(clipsRef.current, position.virtualTimeSec));
		};
		raf = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(raf);
		// re-create the rAF when the active source swaps (by asset id, not src —
		// two clips can point at distinct assets that resolve to the same URL).
	}, [activeSource?.id]);

	// report the video element up; re-notify (and clear) whenever the active
	// source changes so the parent doesn't keep a stale node after the keyed
	// <video> is swapped for a new asset.
	const activeSourceKey = activeSource?.id ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run on source swap
	useEffect(() => {
		onVideoElement?.(videoRef.current);
		return () => onVideoElement?.(null);
	}, [onVideoElement, activeSourceKey]);

	const updateVirtualTime = useCallback(
		(nextTimeSec: number) => {
			setVirtualTimeSec(nextTimeSec);
			onTimeChange?.(nextTimeSec);
			// ponytail: mirrors main's per-frame `video.playbackRate = ...`
			// (videoEventHandlers.ts) — the browser does the actual time
			// warping, so this is the only thing speed regions need. No
			// virtual-timeline remap: a sped-up region still occupies its
			// original span on the ruler, it's just played through faster.
			const v = videoRef.current;
			if (v) {
				const activeRegion = findActiveSpeedRegion(
					speedRegionsRef.current,
					Math.round(nextTimeSec * 1000),
				);
				// Clamp to the browser's 16× playbackRate ceiling; >16× is rendered at
				// its true speed only on the offline export path, not the live preview.
				const rate = Math.min(activeRegion?.speed ?? 1, MAX_NATIVE_PLAYBACK_RATE);
				if (v.playbackRate !== rate) v.playbackRate = rate;
			}
		},
		[onTimeChange],
	);

	// Apply the zoom-region transform directly to the DOM (bypassing React
	// render) so it stays in lockstep with the 60 Hz virtual-time updates
	// above without adding a style-prop re-render on every frame.
	useEffect(() => {
		const frame = videoFrameRef.current;
		if (!frame) return;
		// ponytail: scale the zoom-in/out transition windows by the current
		// playback rate so the transition stays wall-clock constant inside
		// speed regions. The cursor still flies through (ruler + playhead
		// read source-time), only the easing duration is decoupled.
		const activeSpeedRegion = findActiveSpeedRegion(
			speedRegionsRef.current,
			Math.round(virtualTimeSec * 1000),
		);
		const playbackRate = activeSpeedRegion?.speed ?? 1;
		const transform =
			zoomRegions.length === 0
				? IDENTITY_ZOOM_TRANSFORM
				: computeZoomPreviewTransform(zoomRegions, virtualTimeSec * 1000, undefined, playbackRate);
		frame.style.transform = `translate(${transform.translateXPercent}%, ${transform.translateYPercent}%) scale(${transform.scale})`;
	}, [zoomRegions, virtualTimeSec]);

	/**
	 * Write a source position onto the element with AT MOST ONE demuxer seek in
	 * flight; a target that arrives while one is running replaces the queue and
	 * is applied on `seeked`. Latest wins — an intermediate scrub position is
	 * never a destination the user asked to see.
	 *
	 * This is the root cause of #395, not a mitigation of it. Dragging the
	 * playhead makes V4Timeline publish a new time every rAF (it already
	 * coalesces pointermove to that, "to avoid IPC flooding"), the shell mints a
	 * seekTarget per publish, and this component turned each one into a
	 * `currentTime` write: ~60 demuxer seeks a second on a 1080p H.264 file that
	 * the native compositor is decoding at the same time. Chromium eventually
	 * fails one — `PIPELINE_ERROR_READ: FFmpegDemuxer: demuxer seek failed`,
	 * reproduced on a file ffmpeg decodes end to end without a single defect —
	 * and before this branch, any media error emptied the editor.
	 */
	const applySourceTime = useCallback((video: HTMLVideoElement, sourceTimeSec: number) => {
		if (!Number.isFinite(sourceTimeSec)) return;
		if (Math.abs(video.currentTime - sourceTimeSec) <= 0.01) {
			pendingScrubTargetRef.current = null;
			return;
		}
		if (video.seeking) {
			pendingScrubTargetRef.current = sourceTimeSec;
			return;
		}
		pendingScrubTargetRef.current = null;
		// Flagged at the moment of the ACTUAL write: a deferred target must not
		// have its flag consumed by a frame on which no seek happened.
		isProgrammaticSeekRef.current = true;
		video.currentTime = sourceTimeSec;
	}, []);

	const seekToVirtualTime = useCallback(
		(nextVirtualTimeSec: number, preservePlayback = false, forceResume = false) => {
			const position = locateVirtualPosition(clips, nextVirtualTimeSec);
			if (!position) {
				videoRef.current?.pause();
				updateVirtualTime(0);
				return;
			}
			activeClipIdRef.current = position.clip.id;

			const targetIndex = videoSources.findIndex((vs) => vs.id === position.clip.assetId);
			const isAssetSwitch = targetIndex >= 0 && targetIndex !== sourceIndex;
			// Read the live paused state, not the captured `isPlaying` prop. The prop is the
			// parent's playback state as of the last render, and a boundary advance can fire
			// on the very frame playback starts or stops — before that state has round-tripped
			// back down. Only the DOM's own `paused` flag is guaranteed current at call time.
			// (This used to be strictly worse: the rAF invoked a closure captured when the rAF
			// was created, before playback started, so `isPlaying` was permanently stale-false
			// and the cross-asset resume never fired at all. The rAF now calls through
			// `seekToVirtualTimeRef`, so the closure itself is fresh — see its declaration.)
			//
			// `forceResume` bypasses that live check for the ONE caller where it's
			// actively wrong: the `<video>` `ended` handler. The browser sets
			// `.paused = true` synchronously before firing `ended`, so by the time
			// that handler runs and calls us, `!videoRef.current?.paused` is always
			// false — even though playback was genuinely still going and should
			// continue into the next clip. Without this, a non-trimmed clip (whose
			// file's real end coincides with its timeline window's end) would win a
			// race against the rAF tick's own boundary check: the native `ended`
			// event fires first, stops playback outright, and the multi-clip
			// timeline never advances — the "stops at clip end" bug.
			const shouldContinuePlayback = preservePlayback && (forceResume || !videoRef.current?.paused);

			if (isAssetSwitch) {
				setSourceIndex(targetIndex);
				setLoadState("loading");
				updateVirtualTime(position.virtualTimeSec);
				pendingSeekRef.current = {
					sourceTimeSec: position.sourceTimeSec,
					play: shouldContinuePlayback,
				};
				return;
			}

			const video = videoRef.current;
			if (!video) return;

			if (pendingSeekRef.current) {
				// A load is in flight (a reload, or a source that has just been
				// swapped in), so the seek below is a no-op — assigning
				// `currentTime` before metadata only sets the default playback
				// start position, and `onLoadedMetadata` is about to apply the
				// queued resume over the top of it. Re-aim that resume instead:
				// it is older intent than the gesture the user just made.
				pendingSeekRef.current = {
					sourceTimeSec: position.sourceTimeSec,
					play: shouldContinuePlayback,
				};
			}
			updateVirtualTime(position.virtualTimeSec);
			applySourceTime(video, position.sourceTimeSec);
			if (shouldContinuePlayback) {
				// A rejection here means playback never actually started, so the browser
				// never fired 'play' — nothing to reconcile, just avoid an unhandled
				// rejection warning.
				void video.play().catch(() => {
					// swallow: rejection just means playback never started
				});
			}
		},
		[applySourceTime, clips, videoSources, sourceIndex, updateVirtualTime],
	);

	const seekToSourceTime = useCallback(
		(sourceTimeSec: number) => {
			const video = videoRef.current;
			if (!video) return;
			// A load is in flight, so this write would be a no-op that
			// `onLoadedMetadata` then overwrites — re-aim the queued resume instead.
			if (pendingSeekRef.current) {
				pendingSeekRef.current = { sourceTimeSec, play: pendingSeekRef.current.play };
				return;
			}
			applySourceTime(video, sourceTimeSec);
		},
		[applySourceTime],
	);

	/**
	 * Re-run the media load algorithm on the mounted element after a delay, and
	 * queue the position to come back to. Everything is read through refs, so the
	 * callback is stable and the scheduled work always sees current state.
	 */
	const reloadActiveSource = useCallback((play: boolean, delayMs: number) => {
		if (retryTimerRef.current !== null) {
			window.clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
		recoveringRef.current = true;
		setLoadState("loading");
		retryTimerRef.current = window.setTimeout(() => {
			retryTimerRef.current = null;
			const video = videoRef.current;
			if (!video) return;
			// Resolved HERE rather than when the error fired: the user can scrub
			// during the backoff, and the position they left the playhead on is
			// the one that has to come back. An asset switch queued in the
			// meantime is newer intent still, so it wins outright.
			if (!pendingSeekRef.current) {
				const position = locateVirtualPosition(clipsRef.current, virtualTimeSecRef.current);
				// `locateVirtualPosition` answers for whatever clip the playhead
				// is on, which after a boundary advance can belong to a DIFFERENT
				// asset — its source time would be a meaningless offset into the
				// file we are about to reload. The mounted source is read from the
				// same two mirrors the rAF tick uses, rather than kept in a third.
				const clipIsOnThisSource =
					position?.clip.assetId === videoSourcesRef.current[sourceIndexRef.current]?.id;
				if (position && clipIsOnThisSource) {
					// The rAF resumes against this; leaving it stale would resolve
					// the next tick against the clip we were on before the failure.
					activeClipIdRef.current = position.clip.id;
				}
				const resumeSec =
					position && clipIsOnThisSource ? position.sourceTimeSec : lastGoodSourceTimeRef.current;
				pendingSeekRef.current = {
					sourceTimeSec: Number.isFinite(resumeSec) ? resumeSec : 0,
					play,
				};
			}
			// The restore itself rides the cross-asset path `onLoadedMetadata`
			// already implements — one resume path in this component, not two.
			//
			// load() and nothing else: per spec it unconditionally re-runs the
			// media load algorithm. Re-assigning `src` first (the obvious
			// alternative) starts a SECOND load that aborts the first, which
			// surfaces as a spurious MEDIA_ERR_ABORTED.
			video.load();
		}, delayMs);
	}, []);

	/** The element is loaded again, so the reload is over and any failure the
	 *  caller is showing can go. Note what this does NOT do: re-arm the retry
	 *  budget. `loadedmetadata`/`canplay` prove the container header parsed and
	 *  the decoder is willing — not that the bytes that killed us are readable.
	 *  A truncated recording (intact header, unreadable data — the case the error
	 *  card exists for) re-fires both on every reload, so re-arming here would
	 *  hand back the budget faster than failures could spend it: a 400 ms reload
	 *  loop, forever, with nothing ever shown to the user. Getting PAST the
	 *  failure point is the only honest evidence, and the rAF tick below owns it. */
	const markSourceLoaded = useCallback(() => {
		recoveringRef.current = false;
		const id = videoSourcesRef.current[sourceIndexRef.current]?.id;
		if (id) onVideoRecovered?.(id);
	}, [onVideoRecovered]);

	// Reload bookkeeping belongs to the MOUNTED MEDIA, so it is keyed on the URL
	// as well as the asset id — the element is keyed on the id alone (see the
	// <video> below), so re-pointing an asset at a different file re-runs the
	// load algorithm on the SAME element, and a budget spent on the old file
	// must not be charged to the new one. Nothing re-points an asset today; the
	// relink this card's copy invites would be the first, and it is the exact
	// case where a fresh budget is the whole point.
	// The cleanup matters for the swap that IS reachable: a reload scheduled for
	// the old element must never fire against its replacement. React runs it
	// before any queued macrotask can.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the mounted media changes
	useEffect(() => {
		reloadsRef.current = [];
		gaveUpRef.current = false;
		recoveringRef.current = false;
		return () => {
			if (retryTimerRef.current !== null) {
				window.clearTimeout(retryTimerRef.current);
				retryTimerRef.current = null;
			}
		};
	}, [activeSourceKey, activeSource?.src]);

	// The caller's Retry button. Same path as an automatic reload so the two
	// cannot drift, but with a fresh budget and no delay: the user clicked
	// because they know something changed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the token bump IS the request
	useEffect(() => {
		if (!retryToken) return;
		// Deliberately does NOT record a reload: the user's click must not spend
		// one of the recoveries it is meant to restore.
		reloadsRef.current = [];
		gaveUpRef.current = false;
		reloadActiveSource(false, 0);
	}, [retryToken]);

	// BUG corrigé : cet effet listait `seekToVirtualTime`/`seekToSourceTime` en dépendances
	// — mais `seekToVirtualTime` change d'identité (nouveau `useCallback`) à chaque fois que
	// `sourceIndex` change, y compris quand CE MÊME effet vient de le faire changer (switch
	// d'asset lors d'un enchaînement de clip). Résultat : l'effet se redéclenchait alors
	// qu'AUCUN nouveau seek n'avait été demandé, et réappliquait l'ANCIEN `seekTarget` (la
	// position du dernier scrub manuel) — rebasculant sur le clip d'origine et figeant la
	// lecture pile à cette position. D'où le "ça se fige à la fin du 1er clip, uniquement si
	// la tête de lecture avait été déplacée avant" : sans scrub préalable, `seekTarget` reste
	// `null` et l'effet est un no-op, masquant le bug. Seul `seekTarget` (son `requestId`)
	// doit déclencher un nouveau seek ; les fonctions elles-mêmes sont lues via des refs
	// tenues à jour à chaque rendu, pour ne jamais rejouer un ancien seek par accident.
	// (`seekToVirtualTimeRef` is declared above the rAF effect — see the comment there — so
	// the boundary-advance path reads the same always-fresh closure this effect does.)
	seekToVirtualTimeRef.current = seekToVirtualTime;
	const seekToSourceTimeRef = useRef(seekToSourceTime);
	seekToSourceTimeRef.current = seekToSourceTime;
	useEffect(() => {
		if (!seekTarget) return;
		if (seekTarget.isSource) {
			seekToSourceTimeRef.current(seekTarget.timeSec);
		} else {
			seekToVirtualTimeRef.current?.(seekTarget.timeSec);
		}
	}, [seekTarget]);

	return (
		// The load state no longer paints anything here (Preview owns failure UI
		// now), but it is still the honest read of what the decode clock is doing —
		// worth one attribute for tests and for a screenshot in a bug report.
		<div className={styles.container} data-load-state={loadState}>
			{activeSource ? (
				<>
					<div ref={videoFrameRef} className={styles.videoFrame}>
						<video
							// Key on the asset id, not the URL: distinct assets that resolve
							// to the same file URL must still remount the <video> on switch so
							// onLoadedMetadata refires and the pending cross-asset seek/resume
							// runs (otherwise playback stalls at the clip boundary).
							key={activeSource.id}
							ref={videoRef}
							src={activeSource.src}
							className={`${styles.video}${isIdentityCrop ? "" : ` ${styles.videoCropped}`}`}
							// When a synthetic cursor is being drawn on top (CursorPreviewLayer),
							// hide the real OS pointer here so it doesn't compete with it.
							style={{
								...cropVideoStyle,
								...videoStyle,
								cursor: settings.cursorShow ? "none" : undefined,
							}}
							preload="metadata"
							muted
							playsInline
							onLoadedMetadata={(e) => {
								setLoadState("ready");
								markSourceLoaded();
								// ponytail: forward the raw duration (possibly NaN for
								// MediaRecorder WebMs) to the parent. handleLoadedMetadata
								// falls back to a 60s seed when it isn't finite so the
								// timeline gets a populated clip even before the EBML fix
								// lands. Previously this gate skipped the callback for
								// non-finite durations and stranded the editor on
								// "No clips yet" until manual intervention. The assetId is
								// forwarded so the parent only ever corrects clips that
								// belong to the asset which actually fired this event —
								// without it, switching between clips of different assets
								// during multi-clip playback clobbered clip[0]'s duration
								// with whichever asset's video happened to load last.
								onLoadedMetadata?.(
									e.currentTarget.duration,
									activeSource.id,
									e.currentTarget.videoWidth,
									e.currentTarget.videoHeight,
								);
								if (pendingSeekRef.current) {
									const { sourceTimeSec, play } = pendingSeekRef.current;
									pendingSeekRef.current = null;
									e.currentTarget.currentTime = sourceTimeSec;
									if (play) {
										// See the other video.play() catch above: a rejection means
										// playback never started, so there's no state to reconcile.
										void e.currentTarget.play().catch(() => {
											// swallow: rejection just means playback never started
										});
									}
								} else if (clips.length > 0) {
									seekToVirtualTime(virtualTimeSec);
								}
							}}
							onSeeked={(e) => {
								// The demuxer is free again: apply the newest target that
								// arrived while it was busy, if the playhead has moved on.
								const queued = pendingScrubTargetRef.current;
								if (queued !== null) {
									pendingScrubTargetRef.current = null;
									applySourceTime(e.currentTarget, queued);
								}
							}}
							onWaiting={() => setLoadState("loading")}
							onCanPlay={() => {
								setLoadState("ready");
								markSourceLoaded();
							}}
							onError={(e) => {
								const el = e.currentTarget;
								const description = describeMediaError(el.error);
								// An element whose source was torn out from under it reports a
								// "load failure" that says nothing about the media (Chromium
								// calls it "Empty src attribute"). Never act on that.
								const hasSource = Boolean(el.getAttribute("src")) || Boolean(el.currentSrc);
								const nowMs = Date.now();
								reloadsRef.current = pruneReloads(reloadsRef.current, nowMs);
								const reloadsInWindow = reloadsRef.current.length;
								const disposition = hasSource
									? mediaErrorDisposition(description.code, reloadsInWindow, gaveUpRef.current)
									: "ignore";
								const detail = formatMediaError(description);
								// The code is the whole diagnosis, and it used to be thrown
								// away — which is why issue #395 could only ever be reported
								// as "the preview disappeared". Keep it, whatever we decide.
								const context = {
									assetId: activeSource.id,
									src: activeSource.src,
									detail,
									networkState: el.networkState,
									readyState: el.readyState,
									currentTime: el.currentTime,
									reloadsInWindow,
									gaveUp: gaveUpRef.current,
									disposition,
								};
								if (disposition === "ignore") {
									// Routine: every cross-asset clip boundary remounts this
									// element mid-load. `debug`, not `warn` — this fires during
									// ordinary playback and must not read as a problem.
									console.debug(
										"[preview] ignoring a <video> error from a cancelled load",
										context,
									);
									return;
								}
								if (disposition === "retry") {
									console.warn("[preview] <video> failed, reloading", context);
									reloadsRef.current.push(nowMs);
									// Deliberately no pause(): a 400 ms reload should be a blip
									// the user never sees, and pausing here would flip the
									// shell's transport for it. What keeps the rAF from
									// steering the dead decoder in the meantime is
									// `recoveringRef`, set by reloadActiveSource.
									reloadActiveSource(!el.paused, retryDelayMs(reloadsInWindow));
									return;
								}
								// ponytail: don't blindly advance to the next source — if
								// the failed source owns the current virtual clip, the
								// next sourceIndex will seekToVirtualTime right back into
								// the same failed asset, looping. Fail the preview.
								console.error("[preview] <video> failed for good", context);
								pendingSeekRef.current = null;
								recoveringRef.current = false;
								// Latched so an expiring window cannot restart the cycle behind
								// the card. Only Retry or a media change lifts it.
								gaveUpRef.current = true;
								setLoadState("error");
								// An 'error' doesn't itself fire 'pause', so make sure the shell's
								// transport state (single source of truth, see NewEditorShell's
								// own play/pause/ended listener) actually learns playback stopped.
								el.pause();
								onVideoError?.(activeSource.id, detail);
							}}
							onEnded={() => {
								// BUG corrigé : ce handler stoppait TOUJOURS la lecture dès que le
								// <video> brut atteignait SA PROPRE fin de fichier — une course
								// avec la boucle rAF (reachedClipEnd, plus haut) qui gère
								// l'enchaînement multi-clip. Pour un clip NON trimé, la fin réelle
								// du fichier coïncide avec la fin de sa fenêtre timeline, et
								// l'événement navigateur 'ended' gagnait quasi systématiquement
								// cette course (déclenché par le navigateur dès la dernière frame,
								// avant le prochain tick rAF) : la lecture s'arrêtait au lieu
								// d'enchaîner sur le clip suivant — le "ça s'arrête en fin de clip"
								// qui persistait malgré les fixes de la boucle rAF elle-même.
								// `forceResume` (voir seekToVirtualTime) est nécessaire ici : le
								// navigateur a déjà mis `.paused = true` avant de déclencher
								// 'ended', donc le check `!video.paused` habituel empêcherait
								// toujours la reprise de la lecture sur le clip suivant. Si aucun
								// clip suivant n'existe, on ne fait rien de plus ici : le navigateur
								// a déjà mis la vidéo en pause, et NewEditorShell (seule source de
								// vérité pour l'état de lecture) l'apprend via son propre listener
								// 'ended'/'pause' sur ce même élément.
								const current = clipsRef.current.find(
									(clip) => clip.id === activeClipIdRef.current,
								);
								const nextClip = current
									? findNextClipByTimelineOrder(clipsRef.current, current.timelineStartSec)
									: undefined;
								if (nextClip) {
									seekToVirtualTime(nextClip.timelineStartSec, true, true);
								}
							}}
							// ponytail: handleTimeUpdate is now driven by the rAF loop
							// above (60 Hz) instead of the <video> onTimeUpdate event
							// (~4 Hz) — the 4 Hz sync was too slow to keep the webcam
							// <video> and any audio in sync. The rAF tick also
							// handles clip-end advancement, so dropping the event
							// handler here is safe.
						/>
						<audio
							key={`${activeSource.id}:primary-audio`}
							ref={setPrimaryAudioElement}
							src={activeSource.src}
							preload="metadata"
							aria-hidden="true"
							data-testid="preview-audio-primary"
						/>
						{supplementalAudioSrc ? (
							<audio
								key={`${activeSource.id}:supplemental-audio`}
								ref={setSupplementalAudioElement}
								src={supplementalAudioSrc}
								preload="metadata"
								aria-hidden="true"
								data-testid="preview-audio-supplemental"
							/>
						) : null}
						{/* Plus d'overlay ici du tout. « Loading preview… » reflétait l'état du
						    <video> CACHÉ (source horloge/audio), pas la preview RÉELLE — le canvas
						    natif, qui montre déjà une image valide pendant que le <video> re-seek.
						    L'overlay d'erreur, lui, est parti chez Preview (#395) : il vivait dans
						    .videoFrame, sur lequel l'effet de zoom écrit `style.transform`, donc à
						    3× il partait hors cadre ; il n'était pas traduit ; et surtout il ne
						    proposait rien — l'échec est désormais une carte avec un bouton
						    Réessayer, rendue au-dessus de la dernière image composée. */}
					</div>
					{/* The native D3D canvas already draws the recorded-cursor sprite as part
					    of the composited frame (same cursor sidecar file, single source of
					    truth) — this CPU-rendered duplicate (CursorPreviewLayer) is removed. */}
				</>
			) : (
				<div className={styles.placeholder}>Attach a video to start previewing.</div>
			)}
		</div>
	);
}
