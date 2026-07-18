import { useEffect, useRef, useState } from "react";
import type { CameraFullscreenRegion, ZoomFocus } from "@/components/video-editor/types";
import type {
	AxcutAnnotationRegion,
	AxcutClip,
	AxcutTrimRange,
	AxcutZoomRegion,
} from "@/lib/ai-edition/schema";
import type { SpeedRegion } from "@/lib/ai-edition/timeline/speed";
import { EditorEmptyState } from "./EditorEmptyState";
import { NativeCompositorOverlay } from "./NativeCompositorOverlay";
import styles from "./NewEditorShell.module.css";
import { PreviewCanvas } from "./PreviewCanvas";

type BlurData = NonNullable<AxcutAnnotationRegion["blurData"]>;

// POC Option A : preview rendue par la fenêtre D3D native embarquée (opt-in via flag Vite).
export const NATIVE_COMPOSITOR_ENABLED =
	(import.meta.env as Record<string, string | undefined>).VITE_NATIVE_COMPOSITOR === "1";

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
	currentTimeSec: number;
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
	currentTimeSec,
	playing,
}: PreviewProps) {
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
			aria-label="Video preview"
			data-testid="preview"
			data-current-time-sec={currentTimeSec.toFixed(3)}
			data-is-playing={playing ? "true" : "false"}
		>
			<NativeCompositorOverlay enabled={NATIVE_COMPOSITOR_ENABLED} />
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
