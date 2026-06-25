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
	// virtual timeline). Read `video.currentTime` every animation frame so
	// the cursor follows the playhead even when the user scrubs.
	const [sourceTimeSec, setSourceTimeSec] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the active source swaps so the rAF reads from the new <video>.
	useEffect(() => {
		let raf = 0;
		const tick = () => {
			const v = videoRef.current;
			if (v && Number.isFinite(v.currentTime)) {
				setSourceTimeSec(v.currentTime);
			}
			raf = window.requestAnimationFrame(tick);
		};
		raf = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(raf);
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

	const handleTimeUpdate = useCallback(() => {
		const video = videoRef.current;
		if (!video || clips.length === 0) return;
		const activeSourceId = videoSources[sourceIndex]?.id;
		if (isProgrammaticSeekRef.current) {
			isProgrammaticSeekRef.current = false;
			const position = locateSourcePosition(clips, video.currentTime, activeSourceId);
			if (position) {
				updateVirtualTime(clampVirtualTime(clips, position.virtualTimeSec));
			}
			return;
		}
		const position = locateSourcePosition(clips, video.currentTime, activeSourceId);
		if (!position) {
			// ponytail: fall back to timeline order, not same-asset order, so
			// cross-asset / reordered clips don't keep playing unmapped media.
			const nextClip = clips.find((clip) => clip.timelineStartSec > virtualTimeSec + 0.001);
			if (nextClip) {
				seekToVirtualTime(nextClip.timelineStartSec, true);
			} else {
				video.pause();
				updateVirtualTime(virtualDurationSec);
				setIsPlaying(false);
			}
			return;
		}
		const currentClip = position.clip;
		const reachedClipEnd = video.currentTime >= (currentClip.sourceEndSec ?? Infinity) - 0.04;
		if (reachedClipEnd) {
			const nextClip = clips[position.clipIndex + 1];
			if (!nextClip) {
				video.pause();
				updateVirtualTime(virtualDurationSec);
				setIsPlaying(false);
				return;
			}
			seekToVirtualTime(nextClip.timelineStartSec, true);
			return;
		}
		updateVirtualTime(clampVirtualTime(clips, position.virtualTimeSec));
	}, [
		clips,
		seekToVirtualTime,
		updateVirtualTime,
		virtualDurationSec,
		videoSources,
		sourceIndex,
		virtualTimeSec,
	]);

	useEffect(() => {
		const video = videoRef.current;
		setIsPlaying(false);
		updateVirtualTime(0);
		setSourceIndex(0);
		setLoadState(videoSources.length > 0 ? "loading" : "idle");
		if (!video) return;
		video.pause();
		if (clips.length > 0) {
			const start = locateVirtualPosition(clips, 0);
			if (start) video.currentTime = start.sourceTimeSec;
		}
	}, [updateVirtualTime, videoSources, clips.length, clips]);

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
						onTimeUpdate={handleTimeUpdate}
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
