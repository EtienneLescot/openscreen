import { Maximize2, Pause, Play, Repeat, SkipBack, SkipForward } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ZoomFocus } from "@/components/video-editor/types";
import type {
	AxcutAnnotationRegion,
	AxcutClip,
	AxcutSkipRange,
	AxcutZoomRegion,
} from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import type { SpeedRegion } from "@/lib/ai-edition/timeline/speed";
import { EditorEmptyState } from "./EditorEmptyState";
import styles from "./NewEditorShell.module.css";
import { PreviewCanvas } from "./PreviewCanvas";

type BlurData = NonNullable<AxcutAnnotationRegion["blurData"]>;

interface PreviewProps {
	hasProject: boolean;
	hasAsset: boolean;
	videoSources: import("./VirtualPreview").VideoSource[];
	clips: AxcutClip[];
	zoomRegions?: AxcutZoomRegion[];
	speedRegions?: SpeedRegion[];
	skipRanges?: AxcutSkipRange[];
	selectedZoomRegionId?: string | null;
	onZoomFocusChange?: (id: string, focus: ZoomFocus) => void;
	onZoomFocusCommit?: () => void;
	annotationRegions?: AxcutAnnotationRegion[];
	selectedAnnotationId?: string | null;
	onSelectAnnotation?: (id: string) => void;
	onAnnotationPositionChange?: (id: string, position: { x: number; y: number }) => void;
	onAnnotationSizeChange?: (id: string, size: { width: number; height: number }) => void;
	onAnnotationBlurDataChange?: (id: string, blurData: BlurData) => void;
	onAnnotationCommit?: () => void;
	seekTarget: { timeSec: number; requestId: number } | null;
	onTimeChange: (sec: number) => void;
	onSeek: (sec: number) => void;
	onLoadedMetadata: (sec: number, assetId: string) => void;
	onVideoElement: (el: HTMLVideoElement | null) => void;
	currentTimeSec: number;
}

function formatTC(sec: number): string {
	if (!sec || !Number.isFinite(sec) || sec < 0) sec = 0;
	const m = Math.floor(sec / 60);
	const s = (sec % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

export function Preview({
	hasProject,
	hasAsset,
	videoSources,
	clips,
	zoomRegions,
	speedRegions,
	skipRanges,
	selectedZoomRegionId,
	onZoomFocusChange,
	onZoomFocusCommit,
	annotationRegions,
	selectedAnnotationId,
	onSelectAnnotation,
	onAnnotationPositionChange,
	onAnnotationSizeChange,
	onAnnotationBlurDataChange,
	onAnnotationCommit,
	seekTarget,
	onTimeChange,
	onSeek,
	onLoadedMetadata,
	onVideoElement,
	currentTimeSec,
}: PreviewProps) {
	const [playing, setPlaying] = useState(false);
	const [loop, setLoop] = useState(false);
	const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
	// ponytail: when the <video> fails to load (e.g. truncated recording
	// from a bad MediaRecorder capture), swap to the empty state so the
	// user can import a different file instead of staring at a broken
	// preview. Resets when the active source changes (asset path).
	const [videoError, setVideoError] = useState(false);
	const activeSourceKey = videoSources[0]?.src ?? null;
	const previousSourceKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (previousSourceKeyRef.current !== activeSourceKey) {
			previousSourceKeyRef.current = activeSourceKey;
			setVideoError(false);
		}
	}, [activeSourceKey]);

	const handleVideoElement = useCallback(
		(el: HTMLVideoElement | null) => {
			setVideoEl(el);
			onVideoElement(el);
		},
		[onVideoElement],
	);

	const togglePlay = useCallback(() => {
		if (!videoEl) return;
		if (videoEl.paused) {
			void videoEl.play();
		} else {
			videoEl.pause();
		}
	}, [videoEl]);

	// ponytail: mirror the real video element's play state instead of
	// maintaining an optimistic local flag that drifts after play() rejects
	// or when VirtualPreview pauses/ends.
	useEffect(() => {
		const el = videoEl;
		if (!el) return;
		const onPlay = () => setPlaying(true);
		const onPause = () => setPlaying(false);
		const onEnded = () => setPlaying(false);
		el.addEventListener("play", onPlay);
		el.addEventListener("pause", onPause);
		el.addEventListener("ended", onEnded);
		setPlaying(!el.paused);
		return () => {
			el.removeEventListener("play", onPlay);
			el.removeEventListener("pause", onPause);
			el.removeEventListener("ended", onEnded);
		};
	}, [videoEl]);

	const handlePrevClip = useCallback(() => {
		if (clips.length === 0) return;
		// ponytail: navigate in virtual timeline space, not source-media time.
		let prevStart = 0;
		for (let i = clips.length - 1; i >= 0; i--) {
			const c = clips[i];
			if (c.timelineEndSec <= currentTimeSec - 0.1) {
				prevStart = c.timelineStartSec;
				break;
			}
		}
		onSeek(prevStart);
		onTimeChange(prevStart);
	}, [clips, currentTimeSec, onSeek, onTimeChange]);

	const handleNextClip = useCallback(() => {
		if (clips.length === 0) return;
		const next = clips.find((c) => c.timelineStartSec > currentTimeSec + 0.1);
		if (!next) return;
		onSeek(next.timelineStartSec);
		onTimeChange(next.timelineStartSec);
	}, [clips, currentTimeSec, onSeek, onTimeChange]);

	const handleLoop = useCallback(() => {
		setLoop((v) => {
			const next = !v;
			if (videoEl) videoEl.loop = next;
			return next;
		});
	}, [videoEl]);

	const expand = useCallback(() => {
		const el = videoEl?.parentElement;
		if (!el) return;
		if (document.fullscreenElement) {
			void document.exitFullscreen();
		} else {
			void el.requestFullscreen?.();
		}
	}, [videoEl]);

	const { settings: editorSettings } = useEditorSettings();
	const aspectRatioLabel = editorSettings.aspectRatio;

	return (
		<section
			className={styles.previewWrap}
			aria-label="Video preview"
			data-testid="preview"
			data-current-time-sec={currentTimeSec.toFixed(3)}
			data-is-playing={playing ? "true" : "false"}
		>
			<div className={styles.previewCanvas}>
				{hasProject && hasAsset && !videoError ? (
					<PreviewCanvas
						videoSources={videoSources}
						clips={clips}
						zoomRegions={zoomRegions}
						speedRegions={speedRegions}
						skipRanges={skipRanges}
						selectedZoomRegionId={selectedZoomRegionId}
						onZoomFocusChange={onZoomFocusChange}
						onZoomFocusCommit={onZoomFocusCommit}
						annotationRegions={annotationRegions}
						selectedAnnotationId={selectedAnnotationId}
						onSelectAnnotation={onSelectAnnotation}
						onAnnotationPositionChange={onAnnotationPositionChange}
						onAnnotationSizeChange={onAnnotationSizeChange}
						onAnnotationBlurDataChange={onAnnotationBlurDataChange}
						onAnnotationCommit={onAnnotationCommit}
						seekTarget={seekTarget}
						onTimeChange={onTimeChange}
						onSeek={onSeek}
						onLoadedMetadata={onLoadedMetadata}
						onVideoElement={handleVideoElement}
						currentTimeSec={currentTimeSec}
						onVideoError={() => setVideoError(true)}
					/>
				) : (
					<EditorEmptyState hasProject={hasProject} />
				)}
				{hasProject && hasAsset ? (
					<span className={styles.previewTimecode}>{formatTC(currentTimeSec)}</span>
				) : null}
				{hasProject && hasAsset ? (
					<span className={styles.previewBadge}>
						{editorSettings.cursorShow ? "Cursor on" : "Cursor off"} · {aspectRatioLabel} · 60 fps
					</span>
				) : null}
			</div>
			<div className={styles.transport} role="toolbar" aria-label="Playback controls">
				<button
					type="button"
					className={`${styles.tbtn} ${styles.play}`}
					title="Play / Pause (Space)"
					aria-label="Play / Pause"
					data-playing={playing}
					onClick={togglePlay}
				>
					{playing ? (
						<Pause size={14} fill="currentColor" />
					) : (
						<Play size={14} fill="currentColor" />
					)}
				</button>
				<button
					type="button"
					className={styles.tbtn}
					title="Previous clip"
					aria-label="Previous clip"
					onClick={handlePrevClip}
				>
					<SkipBack size={14} />
				</button>
				<button
					type="button"
					className={styles.tbtn}
					title="Next clip"
					aria-label="Next clip"
					onClick={handleNextClip}
				>
					<SkipForward size={14} />
				</button>
				<button
					type="button"
					className={styles.tbtn}
					title="Loop"
					aria-label="Loop"
					aria-pressed={loop}
					onClick={handleLoop}
				>
					<Repeat size={14} />
				</button>
				<button
					type="button"
					className={styles.tbtn}
					title="Fullscreen"
					aria-label="Fullscreen"
					onClick={expand}
				>
					<Maximize2 size={14} />
				</button>
				{(() => {
					const virtualDurationSec = clips.reduce(
						(acc, c) => acc + (c.timelineEndSec - c.timelineStartSec),
						0,
					);
					// ponytail: the input clamps value to [0, virtualDurationSec || 1]
					// so the drag range is meaningful when no clip exists. Use the
					// same clamp for the visual thumb's `left` so the CSS thumb
					// and the native range thumb stay in sync (otherwise the CSS
					// thumb is stuck at 0% when virtualDurationSec is 0, while the
					// native thumb follows the input).
					const inputMax = virtualDurationSec || 1;
					const inputValue = Math.min(Math.max(currentTimeSec, 0), inputMax);
					const progress = (inputValue / inputMax) * 100;
					return (
						<>
							<span className={styles.time}>
								<span>{formatTC(currentTimeSec)}</span>
								<span className={styles.sep}>/</span>
								<span className={styles.total}>{formatTC(virtualDurationSec)}</span>
							</span>
							<div className={styles.scrubBar}>
								<div className={styles.scrubTrack}>
									<div className={styles.scrubProgress} style={{ width: `${progress}%` }} />
								</div>
								<input
									type="range"
									min={0}
									max={inputMax}
									step={0.01}
									value={inputValue}
									onChange={(e) => {
										onSeek(Number(e.target.value));
									}}
									className={styles.scrubInput}
									aria-label="Seek video"
								/>
								<div
									className={styles.scrubThumb}
									style={{
										left: `${progress}%`,
									}}
								/>
							</div>
						</>
					);
				})()}
			</div>
		</section>
	);
}
