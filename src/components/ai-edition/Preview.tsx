import { useEffect, useRef, useState } from "react";
import type { CameraFullscreenRegion, ZoomFocus } from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import type {
	AxcutAnnotationRegion,
	AxcutClip,
	AxcutTrimRange,
	AxcutZoomRegion,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
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
	cameraFullscreenRegions?: CameraFullscreenRegion[];
	trimRanges?: AxcutTrimRange[];
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
	// ponytail: the transport bar (play/pause, prev/next, loop, scrub) moved
	// into the timeline header (Bottombar), so playback state now lives in
	// the parent shell — Preview only needs `playing` to report it on the
	// data-is-playing test attribute.
	playing: boolean;
}

export function Preview({
	hasProject,
	hasAsset,
	videoSources,
	clips,
	zoomRegions,
	speedRegions,
	cameraFullscreenRegions,
	trimRanges,
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
	playing,
}: PreviewProps) {
	const te = useScopedT("editor");
	// Subscribed HERE rather than passed down from NewEditorShell: the playhead is
	// rewritten every animation frame during playback, and reading it in the shell
	// re-rendered the whole editor (timeline included) once per frame — see
	// NativePlaybackSync in NewEditorShell.tsx. The preview subtree genuinely has to
	// re-render at that rate (annotations, captions, crop, Full Camera all animate
	// against it); the timeline does not.
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);
	// ponytail: when the <video> fails to load (e.g. a truncated recording
	// from a bad MediaRecorder capture), swap to the empty state so the user
	// can import a different file instead of staring at a broken preview.
	// Resets when the active source changes (asset path).
	const [videoError, setVideoError] = useState(false);
	const activeSourceKey = videoSources[0]?.src ?? null;
	const previousSourceKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (previousSourceKeyRef.current !== activeSourceKey) {
			previousSourceKeyRef.current = activeSourceKey;
			setVideoError(false);
		}
	}, [activeSourceKey]);

	return (
		<section
			className={styles.previewWrap}
			aria-label={te("preview.videoPreview")}
			data-testid="preview"
			data-current-time-sec={currentTimeSec.toFixed(3)}
			data-is-playing={playing ? "true" : "false"}
		>
			{hasProject && hasAsset && !videoError ? (
				<PreviewCanvas
					videoSources={videoSources}
					clips={clips}
					zoomRegions={zoomRegions}
					speedRegions={speedRegions}
					cameraFullscreenRegions={cameraFullscreenRegions}
					trimRanges={trimRanges}
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
					onVideoElement={onVideoElement}
					currentTimeSec={currentTimeSec}
					onVideoError={() => setVideoError(true)}
				/>
			) : (
				<EditorEmptyState hasProject={hasProject} />
			)}
		</section>
	);
}
