import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fromFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import {
	clampVirtualTime,
	locateSourcePosition,
	locateVirtualPosition,
	totalVirtualDuration,
} from "@/lib/ai-edition/timeline/virtual-preview";
import { CursorPreviewLayer } from "./CursorPreviewLayer";
import styles from "./VirtualPreview.module.css";

export interface VideoSource {
	id: string;
	src: string;
	label: string;
}

interface VirtualPreviewProps {
	videoSources: VideoSource[];
	clips: AxcutClip[];
	seekTarget?: { timeSec: number; isSource?: boolean; requestId: number } | null;
	onTimeChange?: (timeSec: number) => void;
	onLoadedMetadata?: (durationSec: number) => void;
	onVideoElement?: (element: HTMLVideoElement | null) => void;
	videoStyle?: React.CSSProperties;
	onVideoError?: () => void;
}

export function VirtualPreview({
	videoSources,
	clips,
	seekTarget,
	onTimeChange,
	onLoadedMetadata,
	onVideoElement,
	videoStyle,
	onVideoError,
}: VirtualPreviewProps) {
	const videoRef = useRef<HTMLVideoElement | null>(null);

	const isProgrammaticSeekRef = useRef(false);
	const pendingSeekRef = useRef<{ sourceTimeSec: number; play: boolean } | null>(null);
	const [virtualTimeSec, setVirtualTimeSec] = useState(0);
	const [isPlaying, setIsPlaying] = useState(false);
	const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [sourceIndex, setSourceIndex] = useState(0);

	const virtualDurationSec = useMemo(() => totalVirtualDuration(clips), [clips]);
	const activeSource = videoSources[sourceIndex] ?? null;

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
	const videoSourcesRef = useRef(videoSources);
	videoSourcesRef.current = videoSources;
	const sourceIndexRef = useRef(sourceIndex);
	sourceIndexRef.current = sourceIndex;
	const virtualTimeSecRef = useRef(virtualTimeSec);
	virtualTimeSecRef.current = virtualTimeSec;
	const virtualDurationSecRef = useRef(virtualDurationSec);
	virtualDurationSecRef.current = virtualDurationSec;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-create the rAF when the active source swaps.
	useEffect(() => {
		let raf = 0;
		const tick = () => {
			raf = window.requestAnimationFrame(tick);
			const v = videoRef.current;
			if (!v || !Number.isFinite(v.currentTime)) {
				return;
			}
			const activeSourceId = videoSourcesRef.current[sourceIndexRef.current]?.id;
			// ponytail: also push setSourceTimeSec every frame (was previously
			// in a separate rAF effect). Cheap; <video>.readyState >= 2 guards
			// against drawing a black frame into the cursor overlay.
			if (v.readyState >= 2) {
				setSourceTimeSec(v.currentTime);
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
				const pos = locateSourcePosition(clipsRef.current, v.currentTime, activeSourceId);
				if (pos) updateVirtualTime(clampVirtualTime(clipsRef.current, pos.virtualTimeSec));
				return;
			}
			const position = locateSourcePosition(clipsRef.current, v.currentTime, activeSourceId);
			if (!position) {
				// ponytail: fall back to timeline order so cross-asset / reordered
				// clips don't keep playing unmapped media.
				const nextClip = clipsRef.current.find(
					(clip) => clip.timelineStartSec > virtualTimeSecRef.current + 0.001,
				);
				if (nextClip) seekToVirtualTime(nextClip.timelineStartSec, true);
				else {
					v.pause();
					updateVirtualTime(virtualDurationSecRef.current);
					setIsPlaying(false);
				}
				return;
			}
			const reachedClipEnd = v.currentTime >= (position.clip.sourceEndSec ?? Infinity) - 0.04;
			if (reachedClipEnd) {
				const nextClip = clipsRef.current[position.clipIndex + 1];
				if (!nextClip) {
					v.pause();
					updateVirtualTime(virtualDurationSecRef.current);
					setIsPlaying(false);
					return;
				}
				seekToVirtualTime(nextClip.timelineStartSec, true);
				return;
			}
			updateVirtualTime(clampVirtualTime(clipsRef.current, position.virtualTimeSec));
		};
		raf = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(raf);
		// re-create the rAF when the active source swaps
	}, [activeSource?.src]);

	// report the video element up; re-notify (and clear) whenever the active
	// source changes so the parent doesn't keep a stale node after the keyed
	// <video> is swapped for a new asset.
	const activeSourceKey = activeSource?.src ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run on source swap
	useEffect(() => {
		onVideoElement?.(videoRef.current);
		return () => onVideoElement?.(null);
	}, [onVideoElement, activeSourceKey]);

	const updateVirtualTime = useCallback(
		(nextTimeSec: number) => {
			setVirtualTimeSec(nextTimeSec);
			onTimeChange?.(nextTimeSec);
		},
		[onTimeChange],
	);

	const seekToVirtualTime = useCallback(
		(nextVirtualTimeSec: number, preservePlayback = false) => {
			const position = locateVirtualPosition(clips, nextVirtualTimeSec);
			if (!position) {
				updateVirtualTime(0);
				setIsPlaying(false);
				return;
			}

			const targetIndex = videoSources.findIndex((vs) => vs.id === position.clip.assetId);
			const isAssetSwitch = targetIndex >= 0 && targetIndex !== sourceIndex;
			const shouldContinuePlayback = preservePlayback && isPlaying;

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

			isProgrammaticSeekRef.current = true;
			updateVirtualTime(position.virtualTimeSec);
			if (Math.abs(video.currentTime - position.sourceTimeSec) > 0.01) {
				video.currentTime = position.sourceTimeSec;
			}
			if (shouldContinuePlayback) {
				void video.play().catch(() => setIsPlaying(false));
			}
		},
		[clips, videoSources, sourceIndex, isPlaying, updateVirtualTime],
	);

	const seekToSourceTime = useCallback((sourceTimeSec: number) => {
		const video = videoRef.current;
		if (!video) return;
		isProgrammaticSeekRef.current = true;
		if (Math.abs(video.currentTime - sourceTimeSec) > 0.01) {
			video.currentTime = sourceTimeSec;
		}
	}, []);

	useEffect(() => {
		if (!seekTarget) return;
		if (seekTarget.isSource) {
			seekToSourceTime(seekTarget.timeSec);
		} else {
			seekToVirtualTime(seekTarget.timeSec);
		}
	}, [seekTarget, seekToVirtualTime, seekToSourceTime]);

	return (
		<div className={styles.container}>
			{activeSource ? (
				<div className={styles.videoFrame}>
					<video
						key={activeSource.src}
						ref={videoRef}
						src={activeSource.src}
						className={styles.video}
						style={videoStyle}
						preload="metadata"
						playsInline
						onLoadedMetadata={(e) => {
							setLoadState("ready");
							const duration = e.currentTarget.duration;
							if (Number.isFinite(duration) && duration > 0) {
								onLoadedMetadata?.(duration);
							}
							if (pendingSeekRef.current) {
								const { sourceTimeSec, play } = pendingSeekRef.current;
								pendingSeekRef.current = null;
								e.currentTarget.currentTime = sourceTimeSec;
								if (play) {
									void e.currentTarget.play().catch(() => setIsPlaying(false));
								}
							} else if (clips.length > 0) {
								seekToVirtualTime(virtualTimeSec);
							}
						}}
						onWaiting={() => setLoadState("loading")}
						onCanPlay={() => setLoadState("ready")}
						onError={() => {
							// ponytail: don't blindly advance to the next source — if
							// the failed source owns the current virtual clip, the
							// next sourceIndex will seekToVirtualTime right back into
							// the same failed asset, looping. Fail the preview.
							pendingSeekRef.current = null;
							setLoadState("error");
							setIsPlaying(false);
							onVideoError?.();
						}}
						onPause={() => setIsPlaying(false)}
						onPlay={() => setIsPlaying(true)}
						onEnded={() => setIsPlaying(false)}
						// ponytail: handleTimeUpdate is now driven by the rAF loop
						// above (60 Hz) instead of the <video> onTimeUpdate event
						// (~4 Hz) — the 4 Hz sync was too slow to keep the webcam
						// <video> and any audio in sync. The rAF tick also
						// handles clip-end advancement, so dropping the event
						// handler here is safe.
					/>
					{loadState !== "ready" && (
						<div className={styles.overlay}>
							{loadState === "error" ? "Video preview could not be loaded." : "Loading preview…"}
						</div>
					)}
					<CursorPreviewLayer
						videoPath={activeSource ? fromFileUrl(activeSource.src) : null}
						currentTimeSec={sourceTimeSec}
						isPlaying={isPlaying}
					/>
				</div>
			) : (
				<div className={styles.placeholder}>Attach a video to start previewing.</div>
			)}
		</div>
	);
}
