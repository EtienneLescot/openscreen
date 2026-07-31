import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { VideoSource } from "./VirtualPreview";

type BlurData = NonNullable<AxcutAnnotationRegion["blurData"]>;

interface PreviewProps {
	hasProject: boolean;
	hasAsset: boolean;
	videoSources: VideoSource[];
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
	// ponytail: the preview follows the TIMELINE, not the raw asset list. A
	// document can hold an asset no clip references — an import whose file was
	// later moved or deleted, or one left behind when its clip was removed — and
	// handing the asset list straight to the canvas made `videoSources[0]` (the
	// source VirtualPreview mounts first) that dead asset: its <video> errored,
	// latched the failure flag below, and collapsed the WHOLE preview to the
	// empty state while every clip on the timeline was perfectly playable.
	// Ordered by timeline position, so the first source mounted is the one the
	// playhead actually needs at 0:00.
	// The fallback is load-bearing: the first clip of a fresh import is minted
	// from the <video>'s own loadedmetadata (NewEditorShell.handleLoadedMetadata),
	// so with a still-empty timeline the asset has to be mounted before anything
	// references it.
	const previewSources = useMemo(() => {
		const referenced: VideoSource[] = [];
		for (const clip of [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec)) {
			if (referenced.some((source) => source.id === clip.assetId)) continue;
			const source = videoSources.find((s) => s.id === clip.assetId);
			if (source) referenced.push(source);
		}
		return referenced.length > 0 ? referenced : videoSources;
	}, [clips, videoSources]);

	// ponytail: when the <video> fails to load (e.g. a truncated recording
	// from a bad MediaRecorder capture), swap to the empty state so the user
	// can import a different file instead of staring at a broken preview.
	// Tracked PER SOURCE rather than as one global latch: with several clips on
	// the timeline, a single dead asset must not blank a preview the other clips
	// can still render — VirtualPreview already shows its own "could not be
	// loaded" overlay for whichever source failed. Only when every source the
	// timeline uses is dead is there nothing left to show.
	// Resets when the set of preview sources changes (asset paths).
	const [failedSourceIds, setFailedSourceIds] = useState<string[]>([]);
	const sourceKey = previewSources.map((source) => `${source.id}::${source.src}`).join("|");
	const previousSourceKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (previousSourceKeyRef.current !== sourceKey) {
			previousSourceKeyRef.current = sourceKey;
			setFailedSourceIds([]);
		}
	}, [sourceKey]);
	const handleVideoError = useCallback((assetId: string) => {
		setFailedSourceIds((prev) => (prev.includes(assetId) ? prev : [...prev, assetId]));
	}, []);
	const allSourcesFailed =
		previewSources.length > 0 &&
		previewSources.every((source) => failedSourceIds.includes(source.id));

	return (
		<section
			className={styles.previewWrap}
			aria-label={te("preview.videoPreview")}
			data-testid="preview"
			data-current-time-sec={currentTimeSec.toFixed(3)}
			data-is-playing={playing ? "true" : "false"}
		>
			{hasProject && hasAsset && previewSources.length > 0 && !allSourcesFailed ? (
				<PreviewCanvas
					videoSources={previewSources}
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
					onVideoError={handleVideoError}
				/>
			) : (
				<EditorEmptyState hasProject={hasProject} />
			)}
		</section>
	);
}
