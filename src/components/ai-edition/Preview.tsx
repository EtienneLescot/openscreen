import { useCallback, useEffect, useMemo, useState } from "react";
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
import { PreviewErrorCard } from "./PreviewErrorCard";
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
	// and the whole preview collapsed to the empty state while every clip on the
	// timeline was perfectly playable. (A media error no longer collapses
	// anything — see below — but mounting an asset nothing references is still
	// the wrong source to put the decode clock on.)
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

	// ponytail: a media failure used to fall through to `EditorEmptyState`, and
	// that is issue #395: ONE `error` event on the hidden <video> — including the
	// MEDIA_ERR_ABORTED every cross-asset clip boundary produces by design —
	// latched an id into a list that nothing short of a remount could clear, and
	// the editor told a user whose project was perfectly intact to "add a video to
	// get started". Ctrl+R or a trip through the Rec/Media stage was the only way
	// back, because both unmount this component.
	//
	// Two things replace it. VirtualPreview now classifies the error and reloads
	// the source itself, so a transient decode/network blip never reaches here at
	// all. What does reach here is a source that gave up after those retries, and
	// it is shown as a card OVER the still-mounted canvas — which goes on painting
	// the last good frame, because the pixels come from the native compositor and
	// the <video> is only a decode clock (see PreviewCanvas's header comment). The
	// empty state is left answering exactly one question: is there anything in
	// this project to show?
	//
	// One failure slot rather than a set: only ever ONE source is mounted
	// (VirtualPreview indexes into `videoSources`), so the failure being reported
	// is always the one the playhead needs, and any source reporting healthy means
	// the mounted one is.
	const [failure, setFailure] = useState<{ assetId: string; detail: string } | null>(null);
	const [retryToken, setRetryToken] = useState(0);
	// Dropped only when the FAILED asset itself leaves the timeline — not
	// whenever the source list changes shape. Appending a replacement recording
	// (which is the advice the card gives) grows the list without touching the
	// dead <video>: it is not remounted, nothing re-fires `error`, and clearing
	// here would take the card and its Retry button away from a stage that is
	// still frozen. A same-id source whose URL changed does re-run the load
	// algorithm, and the resulting recovery clears the failure on its own.
	const sourceKey = previewSources.map((source) => `${source.id}::${source.src}`).join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the source list's identity, read through previewSources
	useEffect(() => {
		setFailure((prev) =>
			prev && !previewSources.some((source) => source.id === prev.assetId) ? null : prev,
		);
	}, [sourceKey]);
	const handleVideoError = useCallback((assetId: string, detail: string) => {
		setFailure({ assetId, detail });
	}, []);
	// The reported asset id is deliberately ignored. Exactly one source is mounted
	// at a time (`videoSources[sourceIndex]` in VirtualPreview), and it is always
	// the one the playhead needs — so ANY source reporting healthy means the stage
	// is showing a real picture, whichever asset it belongs to. Matching the id
	// against the failed one instead would keep "Preview stopped" pinned over a
	// clip that is playing perfectly, until the user happened to scrub back to the
	// dead one: a card outliving its failure, which is the latch of #395 again in
	// a quieter form. Moving back onto the dead asset remounts it and earns a
	// fresh retry cycle, so the card returns on its own if it should.
	// Fires on every canplay, so on every seek: `setFailure(null)` against an
	// already-null state is a React bail-out, and the healthy path costs nothing.
	const handleVideoRecovered = useCallback(() => {
		setFailure((prev) => (prev === null ? prev : null));
	}, []);
	const handleRetry = useCallback(() => {
		setFailure(null);
		setRetryToken((token) => token + 1);
	}, []);

	return (
		<section
			className={styles.previewWrap}
			aria-label={te("preview.videoPreview")}
			data-testid="preview"
			data-current-time-sec={currentTimeSec.toFixed(3)}
			data-is-playing={playing ? "true" : "false"}
		>
			{hasProject && hasAsset && previewSources.length > 0 ? (
				<>
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
						onVideoRecovered={handleVideoRecovered}
						retryToken={retryToken}
					/>
					{/* Sibling of the canvas, inside `.previewWrap` (already
					    position: relative) — NOT inside VirtualPreview's `.videoFrame`,
					    which carries the live zoom transform and would translate the
					    Retry button off the stage at high zoom. */}
					{failure ? <PreviewErrorCard detail={failure.detail} onRetry={handleRetry} /> : null}
				</>
			) : (
				<EditorEmptyState hasProject={hasProject} />
			)}
		</section>
	);
}
