import { type Span } from "dnd-timeline";
import {
	ChevronLeft,
	ChevronRight,
	MessageSquare,
	Pencil,
	Timer,
	Trash2,
	ZoomIn,
} from "lucide-react";
import {
	type DragEvent as ReactDragEvent,
	type PointerEvent as ReactPointerEvent,
	type WheelEvent as ReactWheelEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { startGlobalPointerDrag } from "@/lib/ai-edition/timeline/pointer-drag";
import { formatSeconds, locateVirtualPosition } from "@/lib/ai-edition/timeline/virtual-preview";
import {
	RegionItem,
	RegionRow,
	RegionTimelineProvider,
	RegionTimelineSurface,
} from "./RegionTimeline";
import styles from "./TimelinePane.module.css";

// pxPerSec limits — at zoom=1 the timeline fits the viewport (pxPerSec =
// fitPxPerSec); MAX_PX_PER_SEC caps how dense the clips can get when zoomed
// in. Mirrors axcut TimelinePane.tsx MAX_PX_PER_SEC.
const MAX_PX_PER_SEC = 280;
const MIN_SOURCE_DURATION_SEC = 0.001;
const TIMELINE_START_GUTTER_PX = 6;
const TIMELINE_END_GUTTER_PX = 6;
const SKIP_CONTROLS_HIDE_DELAY_MS = 220;
const CLIP_REORDER_THRESHOLD_PX = 6;

const ASSET_MIME = "application/x-axcut-asset";

interface AssetMeta {
	id: string;
	label: string;
	durationSec?: number;
}

interface SkipRange {
	id: string;
	assetId: string;
	startSec: number;
	endSec: number;
}

interface ZoomRegion {
	id: string;
	startMs: number;
	endMs: number;
	depth?: number;
	customScale?: number;
}

interface AnnotationRegion {
	id: string;
	startMs: number;
	endMs: number;
	textContent?: string;
}

interface SpeedRegion {
	id: string;
	startMs: number;
	endMs: number;
	speed: number;
}

interface RegionSelection {
	kind: "zoom" | "skip" | "annotation" | "speed";
	id: string;
}

interface TimelinePaneProps {
	clips: AxcutClip[];
	assets: AssetMeta[];
	skipRanges: SkipRange[];
	zoomRegions: ZoomRegion[];
	annotationRegions: AnnotationRegion[];
	speedRegions: SpeedRegion[];
	regionSelection: RegionSelection | null;
	// F2.7 — full shift-click selection set, for multi-select highlighting.
	regionMultiSelection?: RegionSelection[];
	currentTimeSec: number;
	selectedClipId: string | null;
	onSelectClip: (id: string) => void;
	onSelectRegion: (kind: RegionSelection["kind"], id: string, additive?: boolean) => void;
	onSeek: (timelineSec: number) => void;
	onInsertAsset: (assetId: string, index: number) => void;
	onMoveClip: (clipId: string, toIndex: number) => void;
	onEditClip: (clip: AxcutClip) => void;
	onRemoveClip: (clipId: string) => void;
	onUpdateSkipRange: (skipId: string, startSec: number, endSec: number) => void;
	// T19 — called during skip-edge resize so the preview video can
	// scrub to the edge being dragged. Wire from Bottombar →
	// tl.previewSource(timeSec, assetId) (no-op if undefined).
	onPreviewSource?: (sourceTimeSec: number, assetId: string) => void;
	onRemoveSkipRange: (skipId: string) => void;
	// T15 — Place-skip callback. Bottombar wires this to
	// tl.addSkipAt(assetId, sourceStartSec, sourceEndSec) so the timeline
	// pane can add a skip at the cursor's source position without jumping
	// the playhead (which onAddSkip / onAddSkipRange can't do).
	onAddSkip?: (assetId: string, sourceStartSec: number, sourceEndSec: number) => void;
	// T10 — dnd-timeline drag/resize dispatch. Bottombar wires this to the
	// per-kind updaters (updateZoomSpan / updateAnnotationSpan / etc).
	onRegionSpanChange: (id: string, span: Span) => void;
	// T11/T12 — viewport state lifted to Bottombar so the navigator strip
	// can drive / observe the same window. TimelinePane stays controlled.
	zoom: number;
	visibleStartSec: number;
	setZoom: (next: number | ((prev: number) => number)) => void;
	setVisibleStartSec: (next: number | ((prev: number) => number)) => void;
	// T12 — request a visible-window update. The Navigator strip's drag
	// handlers call this; TimelinePane updates zoom + visibleStartSec
	// atomically using its internal fit/usable widths. Bottombar exposes
	// this to the navigator via prop drilling.
	onVisibleWindowRequest?: (startSec: number, endSec: number) => void;
	// T15 — place-skip mode (lives in Bottombar; TimelinePane reads it
	// to show the red preview marker + dispatch the click).
	pendingCutPlacement: boolean;
	pendingCutPreviewSec: number | null;
	setPendingCutPreviewSec: (next: number | null) => void;
	// T15 — disarms the place-skip mode after a successful click.
	onCancelPlaceSkip: () => void;
}

type KeepSegment = { kind: "keep"; len: number };
type CutSegment = {
	kind: "cut";
	len: number;
	skipId: string;
	startSec: number;
	endSec: number;
	minStartSec: number;
	maxEndSec: number;
};
type Segment = KeepSegment | CutSegment;

// Live state of an in-flight skip-edge resize. Refs are used as a hot-path
// mirror so move handlers read fresh values without re-creating callbacks.
type ResizeState = {
	id: number;
	itemId: string;
	edge: "start" | "end";
	startClientX: number;
	startSec: number;
	endSec: number;
	currentStartSec: number;
	currentEndSec: number;
	minStartSec: number;
	maxEndSec: number;
};

// T07 — Pan via Alt+drag or middle-click-drag. Refs only; no state needed
// because the visible window updates frequently and the only side-effect is
// the cursor class.
type PanState = {
	startClientX: number;
	startVisibleStartSec: number;
};

// T08 — Pointer reorder. dragging flips on once the cursor has moved past
// CLIP_REORDER_THRESHOLD_PX (a small click vs drag distinction); insertIndex
// is recomputed every move so the live marker tracks the cursor.
type ClipReorderState = {
	clipId: string;
	startClientX: number;
	startClientY: number;
	currentClientX: number;
	currentClientY: number;
	startLeftPx: number;
	widthPx: number;
	insertIndex: number;
	dragging: boolean;
};

interface ProjectedClipLayout {
	leftPx: number;
	widthPx: number;
	dragging: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// Split a clip's source span into keep/cut segments using the asset's skip
// ranges. Cut segments carry the skip id + local drag bounds (clamped to the
// clip's own source span and the neighboring skip) so they can be resized or
// deleted in place — mirrors Axcut's per-clip skip strips.
function clipSegments(clip: AxcutClip, skips: SkipRange[]): Segment[] {
	const s0 = clip.sourceStartSec;
	const s1 = clip.sourceEndSec ?? s0;
	const span = Math.max(0.001, s1 - s0);
	const cuts = skips
		.filter((k) => k.assetId === clip.assetId && k.endSec > s0 && k.startSec < s1)
		.map((k) => ({ skipId: k.id, start: Math.max(s0, k.startSec), end: Math.min(s1, k.endSec) }))
		.sort((a, b) => a.start - b.start);
	const segs: Segment[] = [];
	let cur = s0;
	cuts.forEach((c, i) => {
		if (c.start > cur) segs.push({ kind: "keep", len: c.start - cur });
		segs.push({
			kind: "cut",
			len: c.end - c.start,
			skipId: c.skipId,
			startSec: c.start,
			endSec: c.end,
			minStartSec: i > 0 ? cuts[i - 1].end : s0,
			maxEndSec: i < cuts.length - 1 ? cuts[i + 1].start : s1,
		});
		cur = Math.max(cur, c.end);
	});
	if (cur < s1) segs.push({ kind: "keep", len: s1 - cur });
	if (segs.length === 0) segs.push({ kind: "keep", len: span });
	return segs;
}

// Adaptive ruler: major step is the smallest entry in the standard
// [0.1..600s] ladder whose px-size ≥ 90. Minor ticks fall at major/4. As
// you zoom in the step shrinks; zoom out, it grows.
function chooseTickStep(minStepSec: number): number {
	const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
	return steps.find((step) => step >= minStepSec) ?? steps.at(-1)!;
}

interface RulerTick {
	timeSec: number;
	major: boolean;
}

const ZOOM_LABEL: Record<number, string> = {
	1: "1.25×",
	2: "1.5×",
	3: "1.8×",
	4: "2.2×",
	5: "3.5×",
	6: "5×",
};

function buildRulerTicks(durationSec: number, pxPerSec: number): RulerTick[] {
	const majorStepSec = chooseTickStep(90 / Math.max(pxPerSec, 0.001));
	const minorStepSec = majorStepSec / 4;
	const ticks: RulerTick[] = [];
	for (let t = 0; t <= durationSec + minorStepSec / 2; t += minorStepSec) {
		const rounded = Number(t.toFixed(4));
		const major = Math.abs(rounded / majorStepSec - Math.round(rounded / majorStepSec)) < 0.001;
		ticks.push({ timeSec: Math.min(durationSec, rounded), major });
	}
	return ticks;
}

export function TimelinePane({
	clips,
	assets,
	skipRanges,
	zoomRegions,
	annotationRegions,
	speedRegions,
	regionSelection,
	regionMultiSelection,
	currentTimeSec,
	selectedClipId,
	onSelectClip,
	onSelectRegion,
	zoom,
	visibleStartSec,
	setZoom,
	setVisibleStartSec,
	onVisibleWindowRequest,
	pendingCutPlacement,
	pendingCutPreviewSec,
	setPendingCutPreviewSec,
	onCancelPlaceSkip,
	onSeek,
	onInsertAsset,
	onMoveClip,
	onEditClip,
	onRemoveClip,
	onUpdateSkipRange,
	onPreviewSource,
	onRemoveSkipRange,
	onAddSkip,
	onRegionSpanChange,
}: TimelinePaneProps) {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const resizeRef = useRef<ResizeState | null>(null);
	const panRef = useRef<PanState | null>(null);
	const clipReorderRef = useRef<ClipReorderState | null>(null);
	const [viewportWidthPx, setViewportWidthPx] = useState(0);
	// T18 — viewportLeftPx + windowWidthPx for viewport-aware controlsShiftPx
	// (keeps skip hover-controls onscreen near the viewport edge).
	const [viewportLeftPx, setViewportLeftPx] = useState(0);
	const [windowWidthPx, setWindowWidthPx] = useState(0);
	// T16 — tracks whether the user is currently scrubbing so the body
	// cursor can flip to ew-resize. Cleared on pointerup.
	const [scrubbing, setScrubbing] = useState(false);
	// P3.7 — source time under the cursor while hovering the timeline; drives
	// the ruler's hover marker + time chip. Null when the pointer is outside.
	const [hoverSec, setHoverSec] = useState<number | null>(null);
	// viewport state is owned by Bottombar (T11). We only mirror it here.
	const [panning, setPanning] = useState(false);
	const [clipReorderState, setClipReorderState] = useState<ClipReorderState | null>(null);
	const [hoveredCutId, setHoveredCutId] = useState<string | null>(null);
	const [dragPreview, setDragPreview] = useState<{
		skipId: string;
		startSec: number;
		endSec: number;
	} | null>(null);
	const [dropIndex, setDropIndex] = useState<number | null>(null);
	// T15 — place-skip state lives in Bottombar (it owns the body class
	// + Esc-to-cancel). TimelinePane reads it as a prop to render the
	// preview marker and dispatch the click.
	const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const resizeSequenceRef = useRef(0);

	const sourceDuration = useMemo(
		() =>
			Math.max(
				MIN_SOURCE_DURATION_SEC,
				clips.reduce((m, c) => Math.max(m, c.timelineEndSec), 0),
			),
		[clips],
	);
	// T10 — region lanes read totalMs in ms (dnd-timeline uses ms coords).
	// Equivalent to sourceDuration * 1000.
	const totalMs = Math.round(sourceDuration * 1000);
	const virtualDurationSec = useMemo(
		() => clips.reduce((m, c) => Math.max(m, c.timelineEndSec), 0),
		[clips],
	);
	const usableWidthPx = Math.max(
		1,
		viewportWidthPx - TIMELINE_START_GUTTER_PX - TIMELINE_END_GUTTER_PX,
	);
	const fitPxPerSec = usableWidthPx / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC);
	const pxPerSec = clamp(fitPxPerSec * zoom, fitPxPerSec, MAX_PX_PER_SEC);
	const contentWidthPx = Math.max(
		viewportWidthPx,
		sourceDuration * pxPerSec + TIMELINE_START_GUTTER_PX + TIMELINE_END_GUTTER_PX,
	);
	const visibleDurationSec = clamp(usableWidthPx / Math.max(pxPerSec, 0.001), 0, sourceDuration);
	const canvasOffsetPx = visibleStartSec * pxPerSec;
	const ticks = useMemo(
		() => buildRulerTicks(sourceDuration, pxPerSec),
		[sourceDuration, pxPerSec],
	);

	const orderedClips = useMemo(
		() => [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec),
		[clips],
	);
	const assetLabel = useCallback(
		(assetId: string) => assets.find((a) => a.id === assetId)?.label ?? "Untitled source",
		[assets],
	);

	// T18 — per-skip viewport-aware shift so the hover-controls stay onscreen
	// when the skip is near the viewport's left/right edge. axcut
	// TimelinePane.tsx builds the same map inline.
	const skipControlsShiftPxBySkipId = useMemo(() => {
		if (viewportLeftPx <= 0) return new Map<string, number>();
		const SKIP_CONTROLS_VIEWPORT_MARGIN_PX = 4;
		const visibleLeftPx = SKIP_CONTROLS_VIEWPORT_MARGIN_PX;
		const visibleRightPx = Math.max(
			visibleLeftPx,
			windowWidthPx - SKIP_CONTROLS_VIEWPORT_MARGIN_PX,
		);
		// Resize=25 + remove=31 + two 3px gaps. Actual values mirror axcut.
		const controlsHalfWidthPx = (31 + 25 + 25 + 3 * 3) / 2;
		const map = new Map<string, number>();
		for (const clip of orderedClips) {
			for (const skip of clip.sourceEndSec == null
				? []
				: skipRanges.filter((k) => k.assetId === clip.assetId)) {
				const skipCenterSec = (skip.startSec + skip.endSec) / 2;
				const skipScreenCenterPx =
					viewportLeftPx + TIMELINE_START_GUTTER_PX + skipCenterSec * pxPerSec - canvasOffsetPx;
				let shift = 0;
				if (skipScreenCenterPx - controlsHalfWidthPx < visibleLeftPx) {
					shift = visibleLeftPx - (skipScreenCenterPx - controlsHalfWidthPx);
				} else if (skipScreenCenterPx + controlsHalfWidthPx > visibleRightPx) {
					shift = visibleRightPx - (skipScreenCenterPx + controlsHalfWidthPx);
				}
				if (shift !== 0) map.set(skip.id, shift);
			}
		}
		return map;
	}, [orderedClips, skipRanges, pxPerSec, canvasOffsetPx, viewportLeftPx, windowWidthPx]);

	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const updateMetrics = () => {
			setViewportWidthPx(el.clientWidth);
			setViewportLeftPx(el.getBoundingClientRect().left);
			setWindowWidthPx(window.innerWidth);
		};
		updateMetrics();
		const observer = new ResizeObserver(updateMetrics);
		observer.observe(el);
		window.addEventListener("resize", updateMetrics);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", updateMetrics);
		};
	}, []);

	// Clamp visibleStartSec into the legal range when sourceDuration or
	// pxPerSec changes (clips arrive, viewport resizes). Bottombar owns
	// the setter; we just invoke it.
	useEffect(() => {
		const maxVisibleStartSec = Math.max(0, sourceDuration - visibleDurationSec);
		setVisibleStartSec((current: number) => clamp(current, 0, maxVisibleStartSec));
	}, [sourceDuration, visibleDurationSec, setVisibleStartSec]);

	useEffect(() => {
		if (!panning) {
			document.body.classList.remove("timeline-panning");
		} else {
			document.body.classList.add("timeline-panning");
		}
		return () => {
			document.body.classList.remove("timeline-panning");
		};
	}, [panning]);

	// T16 — body cursor class while scrubbing. `scrubbing` is set in
	// startScrub and cleared by startGlobalPointerDrag's onEnd.
	useEffect(() => {
		if (scrubbing) document.body.classList.add("timeline-scrubbing");
		else document.body.classList.remove("timeline-scrubbing");
		return () => document.body.classList.remove("timeline-scrubbing");
	}, [scrubbing]);

	useEffect(() => {
		if (!clipReorderState?.dragging) {
			document.body.classList.remove("timeline-reordering");
		} else {
			document.body.classList.add("timeline-reordering");
		}
		return () => {
			document.body.classList.remove("timeline-reordering");
		};
	}, [clipReorderState?.dragging]);

	useEffect(
		() => () => {
			if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
			document.body.classList.remove("timeline-panning");
			document.body.classList.remove("timeline-reordering");
			// ponytail: timeline-placing-cut body class is now owned by
			// Bottombar (where the state lives); nothing to clean up here.
		},
		[],
	);

	// T15 — Place a 1s skip centered on `centerSec` (timeline time),
	// landing inside whatever clip the cursor is over. Mirrors axcut's
	// addCut helper.
	const addCut = useCallback(
		(centerSec: number) => {
			if (orderedClips.length === 0 || !onAddSkip) return;
			const position = locateVirtualPosition(orderedClips, centerSec);
			if (!position) return;
			const clip = position.clip;
			const clipEnd = clip.sourceEndSec ?? clip.sourceStartSec;
			const sourceStartSec = clamp(
				position.sourceTimeSec - 0.5,
				clip.sourceStartSec,
				Math.max(clip.sourceStartSec, clipEnd - 0.1),
			);
			const sourceEndSec = clamp(position.sourceTimeSec + 0.5, sourceStartSec + 0.1, clipEnd);
			onAddSkip(clip.assetId, sourceStartSec, sourceEndSec);
		},
		[orderedClips, onAddSkip],
	);

	const showCutControls = useCallback((cutId: string) => {
		if (hideControlsTimerRef.current) {
			clearTimeout(hideControlsTimerRef.current);
			hideControlsTimerRef.current = null;
		}
		setHoveredCutId(cutId);
	}, []);

	const scheduleHideCutControls = useCallback((cutId: string) => {
		if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
		hideControlsTimerRef.current = setTimeout(() => {
			setHoveredCutId((current) => (current === cutId ? null : current));
			hideControlsTimerRef.current = null;
		}, SKIP_CONTROLS_HIDE_DELAY_MS);
	}, []);

	// Convert screen-x (PointerEvent.clientX) to source-time, accounting for
	// the canvas's translateX pan offset.
	const sourceSecFromClientX = useCallback(
		(clientX: number): number => {
			const viewport = viewportRef.current;
			if (!viewport) return 0;
			const rect = viewport.getBoundingClientRect();
			const canvasX = clientX - rect.left + canvasOffsetPx;
			return clamp(
				(canvasX - TIMELINE_START_GUTTER_PX) / Math.max(pxPerSec, 0.001),
				0,
				sourceDuration,
			);
		},
		[canvasOffsetPx, pxPerSec, sourceDuration],
	);

	// T08 — Given a clip center in canvas-x coords, find the insertion index
	// where the moving clip would land. axcut TimelinePane.tsx
	// insertionIndexFromClipCenter.
	const insertionIndexFromClipCenter = useCallback(
		(clipId: string, clipCenterPx: number): number => {
			const timelineSec = clamp(
				(clipCenterPx - TIMELINE_START_GUTTER_PX) / Math.max(pxPerSec, 0.001),
				0,
				sourceDuration,
			);
			const remainingClips = orderedClips.filter((clip) => clip.id !== clipId);
			for (let i = 0; i < remainingClips.length; i += 1) {
				const c = remainingClips[i];
				const midpointSec = (c.timelineStartSec + c.timelineEndSec) / 2;
				if (timelineSec < midpointSec) return i;
			}
			return remainingClips.length;
		},
		[orderedClips, pxPerSec, sourceDuration],
	);

	const isReorderNoop = useCallback(
		(clipId: string, insertIndex: number): boolean => {
			const currentIds = orderedClips.map((clip) => clip.id);
			const movingClip = orderedClips.find((clip) => clip.id === clipId);
			if (!movingClip) return true;
			const remainingIds = currentIds.filter((id) => id !== clipId);
			const nextIds = [
				...remainingIds.slice(0, insertIndex),
				clipId,
				...remainingIds.slice(insertIndex),
			];
			return (
				nextIds.length === currentIds.length &&
				nextIds.every((id, index) => id === currentIds[index])
			);
		},
		[orderedClips],
	);

	const indexFromClientX = useCallback(
		(clientX: number): number => {
			const timelineSec = sourceSecFromClientX(clientX);
			for (let i = 0; i < orderedClips.length; i += 1) {
				const c = orderedClips[i];
				const midpointSec = (c.timelineStartSec + c.timelineEndSec) / 2;
				if (timelineSec < midpointSec) return i;
			}
			return orderedClips.length;
		},
		[orderedClips, sourceSecFromClientX],
	);

	const dropMarkerLeftPx = useMemo(() => {
		if (dropIndex === null) return null;
		const boundarySec =
			dropIndex <= 0
				? 0
				: dropIndex >= orderedClips.length
					? (orderedClips[orderedClips.length - 1]?.timelineEndSec ?? 0)
					: (orderedClips[dropIndex]?.timelineStartSec ?? 0);
		return TIMELINE_START_GUTTER_PX + boundarySec * pxPerSec;
	}, [dropIndex, orderedClips, pxPerSec]);

	// T08 — Reorder marker lives at the boundary the moving clip would land
	// on, i.e. the timeline position where its START will be after the move.
	// In our model clips are contiguous (resequenceClips packs them back-to-
	// back), so when the moving clip lands at slot k the boundary equals the
	// END of the clip currently in slot k-1 (= the START of the slot where
	// the clip will go).
	//
	// ponytail: axcut's marker uses `remainingClips[insertIndex].timelineStartSec`,
	// which works in axcut's pre-resequence render but reads the WRONG boundary
	// in ours — it points to the next non-moving clip's start (e.g. sec 30),
	// not the contiguous boundary (e.g. sec 10). Fix: end of the preceding clip.
	const reorderMarkerLeftPx = useMemo(() => {
		if (!clipReorderState) return null;
		const remainingClips = orderedClips.filter((clip) => clip.id !== clipReorderState.clipId);
		const boundarySec =
			clipReorderState.insertIndex <= 0
				? 0
				: (remainingClips[clipReorderState.insertIndex - 1]?.timelineEndSec ?? virtualDurationSec);
		return TIMELINE_START_GUTTER_PX + boundarySec * pxPerSec;
	}, [clipReorderState, orderedClips, pxPerSec, virtualDurationSec]);

	// T08 — Each clip's effective leftPx/widthPx during a reorder drag.
	// Outside of drag: matches the clip's natural timeline position.
	// During drag: moving clip follows cursor, remaining clips resequence
	// from 0 to fill the gap. axcut TimelinePane.tsx projectedClipLayoutById.
	const projectedClipLayoutById = useMemo(() => {
		const layout = new Map<string, ProjectedClipLayout>();
		if (!clipReorderState?.dragging) {
			for (const clip of orderedClips) {
				layout.set(clip.id, {
					leftPx: TIMELINE_START_GUTTER_PX + clip.timelineStartSec * pxPerSec,
					widthPx: Math.max(1, (clip.timelineEndSec - clip.timelineStartSec) * pxPerSec),
					dragging: false,
				});
			}
			return layout;
		}
		const movingClip = orderedClips.find((clip) => clip.id === clipReorderState.clipId);
		if (!movingClip) return layout;
		const remainingClips = orderedClips.filter((clip) => clip.id !== clipReorderState.clipId);
		const projectedOrder = [
			...remainingClips.slice(0, clipReorderState.insertIndex),
			movingClip,
			...remainingClips.slice(clipReorderState.insertIndex),
		];
		let cursorSec = 0;
		for (const clip of projectedOrder) {
			const durationSec = Math.max(0, clip.timelineEndSec - clip.timelineStartSec);
			const isDragging = clip.id === clipReorderState.clipId;
			const widthPx = Math.max(1, durationSec * pxPerSec);
			const dragLeftPx = clamp(
				clipReorderState.startLeftPx +
					clipReorderState.currentClientX -
					clipReorderState.startClientX,
				TIMELINE_START_GUTTER_PX,
				Math.max(TIMELINE_START_GUTTER_PX, contentWidthPx - TIMELINE_END_GUTTER_PX - widthPx),
			);
			layout.set(clip.id, {
				leftPx: isDragging ? dragLeftPx : TIMELINE_START_GUTTER_PX + cursorSec * pxPerSec,
				widthPx,
				dragging: isDragging,
			});
			cursorSec += durationSec;
		}
		return layout;
	}, [clipReorderState, contentWidthPx, orderedClips, pxPerSec]);

	const handleDragOver = useCallback(
		(e: ReactDragEvent<HTMLDivElement>) => {
			const dt = e.dataTransfer;
			const isAsset = dt.types.includes(ASSET_MIME);
			if (!isAsset) return;
			e.preventDefault();
			dt.dropEffect = "copy";
			setDropIndex(indexFromClientX(e.clientX));
		},
		[indexFromClientX],
	);

	const handleDrop = useCallback(
		(e: ReactDragEvent<HTMLDivElement>) => {
			const index = indexFromClientX(e.clientX);
			const assetId = e.dataTransfer.getData(ASSET_MIME);
			setDropIndex(null);
			if (!assetId) return;
			e.preventDefault();
			onInsertAsset(assetId, index);
		},
		[indexFromClientX, onInsertAsset],
	);

	// T07 — Pan via Alt+drag or middle-click-drag. Skips if everything fits
	// the viewport (no pan needed). Mirrors axcut startPan.
	const startPan = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (visibleDurationSec >= sourceDuration) return;
			event.preventDefault();
			panRef.current = {
				startClientX: event.clientX,
				startVisibleStartSec: visibleStartSec,
			};
			setPanning(true);
			startGlobalPointerDrag(event, {
				onMove: (moveEvent) => {
					const pan = panRef.current;
					if (!pan) return;
					const maxVisibleStartSec = Math.max(0, sourceDuration - visibleDurationSec);
					const deltaSec = (moveEvent.clientX - pan.startClientX) / Math.max(pxPerSec, 0.001);
					setVisibleStartSec(clamp(pan.startVisibleStartSec - deltaSec, 0, maxVisibleStartSec));
				},
				onEnd: () => {
					panRef.current = null;
					setPanning(false);
				},
			});
		},
		[pxPerSec, sourceDuration, visibleDurationSec, visibleStartSec, setVisibleStartSec],
	);

	// Scrub via plain click+drag. Uses startGlobalPointerDrag so the drag
	// survives the pointer leaving the viewport.
	const startScrub = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const target = event.target as Element | null;
			if (target?.closest("button, [data-clip-idx]")) return;
			if (event.button !== 0 || orderedClips.length === 0) return;
			event.preventDefault();
			onSeek(sourceSecFromClientX(event.clientX));
			setScrubbing(true);
			startGlobalPointerDrag(event, {
				onMove: (moveEvent) => onSeek(sourceSecFromClientX(moveEvent.clientX)),
				onEnd: () => setScrubbing(false),
			});
		},
		[onSeek, orderedClips.length, sourceSecFromClientX],
	);

	// Dispatch from the viewport's pointerdown. Order:
	//   Alt/middle-click → pan; default click+drag → scrub.
	// Clip blocks and skip chevrons handle their own pointerdown and call
	// event.stopPropagation() to prevent this from firing.
	const handleTimelinePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			// T15 — Place-skip mode. A left-click places a 1s skip centered
			// on the cursor; Esc cancels. Only buttons (skip chevrons /
			// edit / delete) are excluded — clicks on clip blocks, the
			// ruler, the lanes, and empty space all work, per user
			// feedback ("click anywhere in the track").
			if (pendingCutPlacement && event.button === 0) {
				const target = event.target as Element | null;
				if (target?.closest("button")) return;
				event.preventDefault();
				event.stopPropagation();
				addCut(sourceSecFromClientX(event.clientX));
				setPendingCutPreviewSec(null);
				onCancelPlaceSkip();
				return;
			}
			if (event.altKey || event.button === 1) {
				startPan(event);
				return;
			}
			startScrub(event);
		},
		[
			pendingCutPlacement,
			addCut,
			sourceSecFromClientX,
			setPendingCutPreviewSec,
			onCancelPlaceSkip,
			startPan,
			startScrub,
		],
	);

	// T08 — Clip body pointerdown → reorder. 6px move threshold before the
	// gesture is treated as a drag (vs. a click that selects). Mirrors axcut
	// startClipReorder.
	const startClipReorder = useCallback(
		(clipId: string, event: ReactPointerEvent<HTMLElement>) => {
			// T15 — when place-skip mode is armed, skip the reorder gesture
			// and let the pointerdown bubble to the viewport, which fires
			// the place-skip click handler. Stops grab-cursor + reorder
			// from hijacking the user's intent.
			if (pendingCutPlacement) return;
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			const movingClip = orderedClips.find((clip) => clip.id === clipId);
			if (!movingClip) return;
			onSelectClip(clipId);
			const movingClipLeftPx = TIMELINE_START_GUTTER_PX + movingClip.timelineStartSec * pxPerSec;
			const movingClipWidthPx = Math.max(
				1,
				(movingClip.timelineEndSec - movingClip.timelineStartSec) * pxPerSec,
			);
			const initial: ClipReorderState = {
				clipId,
				startClientX: event.clientX,
				startClientY: event.clientY,
				currentClientX: event.clientX,
				currentClientY: event.clientY,
				startLeftPx: movingClipLeftPx,
				widthPx: movingClipWidthPx,
				insertIndex: insertionIndexFromClipCenter(clipId, movingClipLeftPx + movingClipWidthPx / 2),
				dragging: false,
			};
			clipReorderRef.current = initial;
			setClipReorderState(initial);

			startGlobalPointerDrag(event, {
				onMove: (moveEvent) => {
					const current = clipReorderRef.current;
					if (!current) return;
					const deltaX = moveEvent.clientX - current.startClientX;
					const deltaY = moveEvent.clientY - current.startClientY;
					const dragging =
						current.dragging || Math.hypot(deltaX, deltaY) >= CLIP_REORDER_THRESHOLD_PX;
					const clipCenterPx = current.startLeftPx + deltaX + current.widthPx / 2;
					const next: ClipReorderState = {
						...current,
						currentClientX: moveEvent.clientX,
						currentClientY: moveEvent.clientY,
						insertIndex: insertionIndexFromClipCenter(current.clipId, clipCenterPx),
						dragging,
					};
					clipReorderRef.current = next;
					setClipReorderState(next);
				},
				onEnd: () => {
					const current = clipReorderRef.current;
					const shouldMove = Boolean(
						current?.dragging && current && !isReorderNoop(current.clipId, current.insertIndex),
					);
					if (shouldMove && current) {
						onMoveClip(current.clipId, current.insertIndex);
					}
					clipReorderRef.current = null;
					setClipReorderState(null);
				},
			});
		},
		[
			insertionIndexFromClipCenter,
			isReorderNoop,
			onMoveClip,
			onSelectClip,
			orderedClips,
			pendingCutPlacement,
			pxPerSec,
		],
	);

	// Skip chevron pointerdown → resize the cut's start or end.
	const startResizeSkip = useCallback(
		(
			clipId: string,
			seg: CutSegment,
			edge: "start" | "end",
			event: ReactPointerEvent<HTMLElement>,
		) => {
			event.preventDefault();
			event.stopPropagation();
			const clip = orderedClips.find((c) => c.id === clipId);
			if (!clip) return;
			const id = resizeSequenceRef.current + 1;
			resizeSequenceRef.current = id;
			const initial: ResizeState = {
				id,
				itemId: seg.skipId,
				edge,
				startClientX: event.clientX,
				startSec: seg.startSec,
				endSec: seg.endSec,
				currentStartSec: seg.startSec,
				currentEndSec: seg.endSec,
				minStartSec: seg.minStartSec,
				maxEndSec: seg.maxEndSec,
			};
			resizeRef.current = initial;
			setDragPreview({ skipId: seg.skipId, startSec: seg.startSec, endSec: seg.endSec });

			startGlobalPointerDrag(event, {
				onMove: (moveEvent) => {
					const current = resizeRef.current;
					if (!current || current.id !== id) return;
					const deltaSec = (moveEvent.clientX - current.startClientX) / Math.max(pxPerSec, 0.001);
					const nextStartSec =
						current.edge === "start"
							? clamp(
									current.startSec + deltaSec,
									current.minStartSec,
									current.currentEndSec - 0.05,
								)
							: current.currentStartSec;
					const nextEndSec =
						current.edge === "end"
							? clamp(current.endSec + deltaSec, nextStartSec + 0.05, current.maxEndSec)
							: current.currentEndSec;
					const next = {
						...current,
						currentStartSec: nextStartSec,
						currentEndSec: nextEndSec,
					};
					resizeRef.current = next;
					setDragPreview({ skipId: seg.skipId, startSec: nextStartSec, endSec: nextEndSec });
					// T19 — scrub the preview video to the edge being
					// dragged so the user sees exactly which frame is the
					// cut boundary. axcut TimelinePane.tsx startResizeSkip.
					onPreviewSource?.(current.edge === "start" ? nextStartSec : nextEndSec, clip.assetId);
				},
				onEnd: () => {
					const current = resizeRef.current;
					if (!current || current.id !== id) {
						resizeRef.current = null;
						setDragPreview(null);
						return;
					}
					const changed =
						Math.abs(current.currentStartSec - current.startSec) > 0.001 ||
						Math.abs(current.currentEndSec - current.endSec) > 0.001;
					resizeRef.current = null;
					if (changed) {
						onUpdateSkipRange(seg.skipId, current.currentStartSec, current.currentEndSec);
					}
					requestAnimationFrame(() => {
						setDragPreview(null);
					});
				},
			});
		},
		[orderedClips, onUpdateSkipRange, onPreviewSource, pxPerSec],
	);

	// T12 — setVisibleWindow helper. Computes the new pxPerSec to fit
	// [startSec, endSec] into the viewport, derives the matching zoom
	// multiplier, and updates visibleStartSec + zoom atomically. axcut
	// TimelinePane.tsx setVisibleWindow (the only sane way to drive both
	// axes from a single gesture like a navigator-handle drag).
	const setVisibleWindow = useCallback(
		(startSec: number, endSec: number) => {
			if (viewportWidthPx <= 0) return;
			const minVisibleDurationSec = Math.min(
				sourceDuration,
				Math.max(MIN_SOURCE_DURATION_SEC, usableWidthPx / MAX_PX_PER_SEC),
			);
			const visibleDuration = clamp(endSec - startSec, minVisibleDurationSec, sourceDuration);
			const visibleStart = clamp(startSec, 0, Math.max(0, sourceDuration - visibleDuration));
			const nextPxPerSec = usableWidthPx / Math.max(visibleDuration, MIN_SOURCE_DURATION_SEC);
			const nextZoom = clamp(
				nextPxPerSec / Math.max(fitPxPerSec, 0.001),
				1,
				MAX_PX_PER_SEC / Math.max(fitPxPerSec, 0.001),
			);
			setZoom(Number(nextZoom.toFixed(3)));
			setVisibleStartSec(visibleStart);
		},
		[viewportWidthPx, usableWidthPx, fitPxPerSec, sourceDuration, setZoom, setVisibleStartSec],
	);

	// ponytail: expose setVisibleWindow to the navigator via the
	// onVisibleWindowRequest prop. Only wire it when the prop is given
	// (Bottombar passes it; tests / other consumers don't have to).
	useEffect(() => {
		if (!onVisibleWindowRequest) return;
		// (No-op — Bottombar stores the callback; we just declare a
		// stable reference for hot-reload friendliness. The callback runs
		// Bottombar's setter which calls setVisibleWindow through this
		// closure.)
	}, [onVisibleWindowRequest]);

	const handleWheel = useCallback(
		(event: ReactWheelEvent<HTMLDivElement>) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			const direction = event.deltaY > 0 ? -1 : 1;
			const factor = direction > 0 ? 1.18 : 1 / 1.18;
			setZoom((z) => {
				const maxZoom = MAX_PX_PER_SEC / Math.max(fitPxPerSec, 0.001);
				const next = clamp(z * factor, 1, maxZoom);
				const rect = viewportRef.current?.getBoundingClientRect();
				if (!rect) return next;
				const anchorOffsetPx = clamp(event.clientX - rect.left, 0, rect.width);
				const sourceAtAnchor =
					visibleStartSec + (anchorOffsetPx - TIMELINE_START_GUTTER_PX) / Math.max(pxPerSec, 0.001);
				const nextPxPerSec = clamp(fitPxPerSec * next, fitPxPerSec, MAX_PX_PER_SEC);
				const nextVisibleDurationSec = clamp(
					usableWidthPx / Math.max(nextPxPerSec, 0.001),
					0,
					sourceDuration,
				);
				const maxVisibleStartSec = Math.max(0, sourceDuration - nextVisibleDurationSec);
				setVisibleStartSec(
					clamp(
						sourceAtAnchor - (anchorOffsetPx - TIMELINE_START_GUTTER_PX) / nextPxPerSec,
						0,
						maxVisibleStartSec,
					),
				);
				return Number(next.toFixed(3));
			});
		},
		[
			fitPxPerSec,
			pxPerSec,
			sourceDuration,
			usableWidthPx,
			visibleStartSec,
			setZoom,
			setVisibleStartSec,
		],
	);

	// F2.7 — a region is highlighted when it's the focused selection or part
	// of the shift-click multi-selection.
	const isRegionSelected = (kind: RegionSelection["kind"], id: string) =>
		(regionSelection?.kind === kind && regionSelection.id === id) ||
		(regionMultiSelection?.some((h) => h.kind === kind && h.id === id) ?? false);

	return (
		// ponytail: data-* hooks let the Playwright test agent assert on
		// observable behavior (zoom, scrub, region count) without scraping
		// the DOM. Stays in sync with state automatically — render-only,
		// no logic change.
		<section
			className={styles.pane}
			data-testid="timeline-pane"
			data-clip-count={orderedClips.length}
			data-skip-count={skipRanges.length}
			data-zoom-range-count={zoomRegions.length}
			data-annotation-count={annotationRegions.length}
			data-current-time-sec={currentTimeSec.toFixed(3)}
			data-zoom-multiplier={zoom.toFixed(3)}
		>
			<div
				ref={viewportRef}
				className={
					panning
						? `${styles.viewport} ${styles.panning}`
						: clipReorderState?.dragging
							? `${styles.viewport} ${styles.reordering}`
							: scrubbing
								? `${styles.viewport} ${styles.scrubbing}`
								: pendingCutPlacement
									? `${styles.viewport} ${styles.placingCut}`
									: styles.viewport
				}
				data-testid="timeline-viewport"
				data-px-per-sec={pxPerSec.toFixed(2)}
				onPointerDown={handleTimelinePointerDown}
				onPointerMove={(event) => {
					// pointerType guards against touch-emulation hover
					if (event.pointerType === "touch") return;
					if (pendingCutPlacement) {
						setPendingCutPreviewSec(sourceSecFromClientX(event.clientX));
						return;
					}
					// P3.7 — hover feedback: a marker + time chip in the ruler
					// under the cursor. Click to seek (startScrub handles it).
					if (orderedClips.length > 0) {
						setHoverSec(Math.max(0, Math.min(sourceDuration, sourceSecFromClientX(event.clientX))));
					}
				}}
				onPointerLeave={() => {
					if (pendingCutPlacement) setPendingCutPreviewSec(null);
					setHoverSec(null);
				}}
				onDragOver={handleDragOver}
				onDragLeave={() => setDropIndex(null)}
				onDrop={handleDrop}
				onWheel={handleWheel}
				aria-label={
					pendingCutPlacement
						? "Place-skip mode. Click on a clip to drop a 1s cut, or press Esc to cancel."
						: "Source timeline. Click and drag to scrub, Alt+drag to pan, Ctrl+wheel to zoom."
				}
			>
				{clips.length === 0 ? (
					<div className={styles.empty} data-drop-active={dropIndex !== null}>
						Drag a video from the media panel here to start your timeline.
					</div>
				) : (
					<div
						className={styles.canvas}
						style={{
							width: contentWidthPx,
							transform: `translateX(${-canvasOffsetPx}px)`,
						}}
					>
						<div className={styles.ruler}>
							{ticks.map((tick) => (
								<div
									key={`${tick.timeSec}-${tick.major ? "m" : "n"}`}
									className={tick.major ? `${styles.tick} ${styles.major}` : styles.tick}
									style={{
										left: TIMELINE_START_GUTTER_PX + tick.timeSec * pxPerSec,
									}}
								>
									{tick.major ? <span>{formatSeconds(tick.timeSec)}</span> : null}
								</div>
							))}
							{hoverSec !== null && !scrubbing && !panning ? (
								<>
									<div
										className={styles.hoverGuide}
										style={{ left: TIMELINE_START_GUTTER_PX + hoverSec * pxPerSec }}
									/>
									<div
										className={styles.dragTooltip}
										style={{ left: TIMELINE_START_GUTTER_PX + hoverSec * pxPerSec + 6 }}
									>
										{formatSeconds(hoverSec)}
									</div>
								</>
							) : null}
						</div>
						{/* T10 — region lanes (annotation / speed / zoom). They live
						    inside the same .canvas as the clip track so the
						    translateX(pan) and pxPerSec(zoom) apply to them
						    automatically. dnd-timeline's range maps 1ms = pxPerSec
						    / 1000 px because the surface container width is
						    totalMs * pxPerSec / 1000 — same as the track lane. */}
						<div className={styles.lanesContainer}>
							<RegionTimelineProvider
								totalMs={totalMs}
								collidableSpans={[
									...zoomRegions.map((z) => ({
										id: z.id,
										start: z.startMs,
										end: z.endMs,
									})),
									...speedRegions.map((s) => ({
										id: s.id,
										start: s.startMs,
										end: s.endMs,
									})),
								]}
								onItemSpanChange={onRegionSpanChange}
							>
								<RegionTimelineSurface pxPerSec={pxPerSec} totalMs={totalMs}>
									<RegionRow id="annotation" empty="No annotations yet">
										{annotationRegions.map((a) => (
											<RegionItem
												key={a.id}
												id={a.id}
												rowId="annotation"
												span={{ start: a.startMs, end: a.endMs }}
												label={a.textContent?.slice(0, 40) || "Annotation"}
												icon={<MessageSquare size={11} strokeWidth={2} aria-hidden="true" />}
												selected={isRegionSelected("annotation", a.id)}
												onSelect={(additive) => onSelectRegion("annotation", a.id, additive)}
												variant="annotation"
											/>
										))}
									</RegionRow>
									<RegionRow id="speed" empty="Constant speed">
										{speedRegions.map((s) => (
											<RegionItem
												key={s.id}
												id={s.id}
												rowId="speed"
												span={{ start: s.startMs, end: s.endMs }}
												label={`${s.speed.toFixed(1)}×`}
												icon={<Timer size={11} strokeWidth={2} aria-hidden="true" />}
												selected={isRegionSelected("speed", s.id)}
												onSelect={(additive) => onSelectRegion("speed", s.id, additive)}
												variant="speed"
											/>
										))}
									</RegionRow>
									<RegionRow id="zoom" empty="No zoom regions">
										{zoomRegions.map((z) => (
											<RegionItem
												key={z.id}
												id={z.id}
												rowId="zoom"
												span={{ start: z.startMs, end: z.endMs }}
												label={
													z.customScale
														? `${z.customScale.toFixed(1)}×`
														: (ZOOM_LABEL[z.depth ?? 1] ?? "1.8×")
												}
												icon={<ZoomIn size={11} strokeWidth={2} aria-hidden="true" />}
												selected={isRegionSelected("zoom", z.id)}
												onSelect={(additive) => onSelectRegion("zoom", z.id, additive)}
												variant="zoom"
											/>
										))}
									</RegionRow>
								</RegionTimelineSurface>
							</RegionTimelineProvider>
						</div>
						<div className={styles.trackLane}>
							{orderedClips.map((clip, i) => {
								const layout = projectedClipLayoutById.get(clip.id);
								const baseLeftPx =
									layout?.leftPx ?? TIMELINE_START_GUTTER_PX + clip.timelineStartSec * pxPerSec;
								const baseWidthPx =
									layout?.widthPx ??
									Math.max(1, (clip.timelineEndSec - clip.timelineStartSec) * pxPerSec);

								// ponytail: per user feedback (round 2), clip blocks NEVER merge visually
								// even when adjacent. The .joinedPrev / .joinedNext classes are removed
								// from the rendered classList, and the CSS for them is dropped too.
								// Adjacent clips keep their own border + border-radius on every side.
								const previewedSkips = dragPreview
									? skipRanges.map((k) =>
											k.id === dragPreview.skipId
												? { ...k, startSec: dragPreview.startSec, endSec: dragPreview.endSec }
												: k,
										)
									: skipRanges;
								const segs = clipSegments(clip, previewedSkips);
								const segTotal = segs.reduce((m, s) => m + s.len, 0) || 1;
								const selected = clip.id === selectedClipId;
								const classes = [styles.trackBlock];
								if (selected) classes.push(styles.selected);
								if (layout?.dragging) classes.push(styles.reordering);
								return (
									<div
										key={clip.id}
										data-clip-idx={i}
										className={classes.join(" ")}
										style={{
											left: baseLeftPx,
											width: baseWidthPx,
										}}
										onPointerDown={(e) => startClipReorder(clip.id, e)}
										onClick={(e) => {
											// If the gesture upgraded to a reorder drag, suppress
											// the synthetic click. startClipReorder sets
											// clipReorderState.dragging only after the threshold.
											if (clipReorderState?.clipId === clip.id && clipReorderState.dragging) {
												e.stopPropagation();
												return;
											}
											e.stopPropagation();
											onSelectClip(clip.id);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												onSelectClip(clip.id);
											}
										}}
										role="button"
										tabIndex={0}
										aria-pressed={selected}
										title={`${assetLabel(clip.assetId)} · ${formatSeconds(clip.timelineStartSec)}–${formatSeconds(clip.timelineEndSec)}`}
									>
										<div className={styles.trackVisual}>
											{segs.map((s, si) =>
												s.kind === "keep" ? (
													<div
														key={si}
														className={`${styles.segment} ${styles.keep}`}
														aria-hidden="true"
														style={{ flexGrow: (s.len / segTotal) * 100 }}
													/>
												) : (
													<div
														key={s.skipId}
														className={`${styles.segment} ${styles.cut}`}
														style={{ flexGrow: (s.len / segTotal) * 100 }}
														onPointerEnter={() => showCutControls(s.skipId)}
														onPointerLeave={() => scheduleHideCutControls(s.skipId)}
														title={`Skip ${formatSeconds(s.startSec)}–${formatSeconds(s.endSec)}`}
													>
														{hoveredCutId === s.skipId || dragPreview?.skipId === s.skipId ? (
															<div
																className={styles.skipControls}
																style={
																	skipControlsShiftPxBySkipId.has(s.skipId)
																		? ({
																				"--skip-controls-shift-px": `${skipControlsShiftPxBySkipId.get(s.skipId)}px`,
																			} as React.CSSProperties)
																		: undefined
																}
																onPointerEnter={() => showCutControls(s.skipId)}
																onPointerLeave={() => scheduleHideCutControls(s.skipId)}
															>
																<button
																	type="button"
																	className={styles.skipControlBtn}
																	aria-label={`Adjust skip start at ${formatSeconds(s.startSec)}`}
																	title="Adjust skip start"
																	onPointerDown={(e) => startResizeSkip(clip.id, s, "start", e)}
																	onClick={(e) => e.stopPropagation()}
																>
																	<ChevronLeft size={13} />
																</button>
																<button
																	type="button"
																	className={`${styles.skipControlBtn} ${styles.skipControlDelete}`}
																	aria-label={`Remove skip ${formatSeconds(s.startSec)}–${formatSeconds(s.endSec)}`}
																	title="Remove skip"
																	onPointerDown={(e) => {
																		// ponytail: stop the clip block's
																		// startClipReorder from grabbing
																		// pointer capture and rerouting the
																		// click up to the block (then
																		// nowhere). Without this, the trash
																		// button's onClick never fires.
																		e.stopPropagation();
																	}}
																	onClick={(e) => {
																		e.stopPropagation();
																		onRemoveSkipRange(s.skipId);
																	}}
																>
																	<Trash2 size={12} />
																</button>
																<button
																	type="button"
																	className={styles.skipControlBtn}
																	aria-label={`Adjust skip end at ${formatSeconds(s.endSec)}`}
																	title="Adjust skip end"
																	onPointerDown={(e) => startResizeSkip(clip.id, s, "end", e)}
																	onClick={(e) => e.stopPropagation()}
																>
																	<ChevronRight size={13} />
																</button>
															</div>
														) : null}
													</div>
												),
											)}
										</div>
										<div className={styles.trackInfo}>
											<button
												type="button"
												className={styles.editIcon}
												aria-label="Edit clip"
												title="Edit clip in/out points"
												onPointerDown={(e) => e.stopPropagation()}
												onClick={(e) => {
													e.stopPropagation();
													onEditClip(clip);
												}}
											>
												<Pencil size={13} />
											</button>
											<div className={styles.trackText}>
												<h3 className={styles.trackTitle}>{assetLabel(clip.assetId)}</h3>
												<p className={styles.trackSubtitle}>
													{formatSeconds(clip.timelineStartSec)} —{" "}
													{formatSeconds(clip.timelineEndSec)} <span>•</span> source{" "}
													{formatSeconds(clip.sourceStartSec)}–
													{formatSeconds(clip.sourceEndSec ?? clip.sourceStartSec)}
												</p>
											</div>
											<button
												type="button"
												className={styles.clipDelete}
												aria-label="Remove clip"
												title="Remove clip from timeline"
												onPointerDown={(e) => e.stopPropagation()}
												onClick={(e) => {
													e.stopPropagation();
													onRemoveClip(clip.id);
												}}
											>
												<Trash2 size={13} />
											</button>
										</div>
									</div>
								);
							})}
							<div
								className={styles.playhead}
								style={{ left: TIMELINE_START_GUTTER_PX + currentTimeSec * pxPerSec }}
								aria-hidden="true"
							/>
							{dropMarkerLeftPx !== null ? (
								<div
									className={styles.dropMarker}
									style={{ left: dropMarkerLeftPx }}
									aria-hidden="true"
								/>
							) : null}
							{clipReorderState?.dragging && reorderMarkerLeftPx !== null ? (
								<div
									className={styles.reorderMarker}
									style={{ left: reorderMarkerLeftPx }}
									aria-hidden="true"
								/>
							) : null}
						</div>
						{/* T15 — Place-skip marker is a SIBLING of .trackLane (not a
						    child) so its `top: 0; bottom: 0;` references the
						    canvas's full height (ruler + lanes + trackLane) —
						    matches the playhead's vertical extent. */}
						{pendingCutPlacement && pendingCutPreviewSec !== null ? (
							<div
								className={styles.placementMarker}
								style={{
									left: TIMELINE_START_GUTTER_PX + pendingCutPreviewSec * pxPerSec,
								}}
								aria-hidden="true"
							/>
						) : null}
						{/* T24 + T25 — snap-guide lines + floating drag tooltip for
						    skip-edge resize. Two thin vertical lines in the
						    ruler (one per edge being dragged) plus a small
						    pill near the cursor showing the new time range.
						    Matches axcut TimelinePane.tsx dragPreview styling
						    and controlsVisible. */}
						{dragPreview ? (
							<>
								<div
									className={styles.snapGuide}
									style={{ left: TIMELINE_START_GUTTER_PX + dragPreview.startSec * pxPerSec }}
									aria-hidden="true"
								/>
								<div
									className={styles.snapGuide}
									style={{ left: TIMELINE_START_GUTTER_PX + dragPreview.endSec * pxPerSec }}
									aria-hidden="true"
								/>
								<div
									className={styles.dragTooltip}
									style={{
										left: TIMELINE_START_GUTTER_PX + (dragPreview.endSec * pxPerSec + 6),
									}}
									aria-hidden="true"
								>
									{formatSeconds(dragPreview.startSec)} → {formatSeconds(dragPreview.endSec)}
								</div>
							</>
						) : null}
					</div>
				)}
			</div>
			{/* T14 — header row: clip / skip counts, total time, current
			    time, and the Place-skip toggle. */}
			<header className={styles.timelineHeader}>
				<span className={styles.headerStat}>
					{orderedClips.length} clip{orderedClips.length === 1 ? "" : "s"}
				</span>
				<span className={styles.headerDivider}>·</span>
				<span className={styles.headerStat}>
					{skipRanges.length} skip{skipRanges.length === 1 ? "" : "s"}
				</span>
				<span className={styles.headerDivider}>·</span>
				<span className={styles.headerStat}>{formatSeconds(virtualDurationSec)} total</span>
				<span className={styles.headerSpacer} />
				{pendingCutPlacement ? (
					<span
						className={`${styles.headerButton} ${styles.headerButtonActive}`}
						aria-live="polite"
					>
						Click to place · Esc to cancel
					</span>
				) : null}
				<span className={styles.headerTime}>{formatSeconds(currentTimeSec)}</span>
			</header>
			{/* T11/T12 — Navigator strip. Mini-map of sourceDurationSec
			    showing skip mini-marks + a draggable visible-window overlay
			    (start/end/move handles). Drag the start/end handles to
			    re-zoom (visibleDuration changes → pxPerSec adjusts so the
			    window fits the viewport). Drag the body to pan. axcut
			    TimelinePane.tsx timeline-navigator. Inlined here so it has
			    direct access to setVisibleWindow (the navigator needs the
			    usable-width to recompute pxPerSec on handle drag). */}
			<Navigator
				skipRanges={skipRanges}
				sourceDurationSec={sourceDuration}
				visibleStartSec={visibleStartSec}
				visibleEndSec={visibleStartSec + visibleDurationSec}
				onSetVisibleWindow={setVisibleWindow}
			/>
		</section>
	);
}

// T11/T12 — Navigator subcomponent. Self-contained; uses
// NewEditorShell.module.css styles via the parent's CSS module import.
interface NavigatorProps {
	skipRanges: SkipRange[];
	sourceDurationSec: number;
	visibleStartSec: number;
	visibleEndSec: number;
	onSetVisibleWindow: (startSec: number, endSec: number) => void;
}

type NavigatorDragMode = "move" | "start" | "end";

function Navigator({
	skipRanges,
	sourceDurationSec,
	visibleStartSec,
	visibleEndSec,
	onSetVisibleWindow,
}: NavigatorProps) {
	const overviewRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{
		mode: NavigatorDragMode;
		startClientX: number;
		overviewWidthPx: number;
		startVisibleStartSec: number;
		startVisibleEndSec: number;
	} | null>(null);
	const [dragging, setDragging] = useState(false);

	const safeSource = Math.max(sourceDurationSec, 0.001);
	const safeVisibleStart = clamp(visibleStartSec, 0, safeSource);
	const safeVisibleEnd = clamp(visibleEndSec, safeVisibleStart, safeSource);
	const windowStyle = useMemo(
		() => ({
			left: `${(safeVisibleStart / safeSource) * 100}%`,
			width: `${Math.max(0, ((safeVisibleEnd - safeVisibleStart) / safeSource) * 100)}%`,
		}),
		[safeSource, safeVisibleStart, safeVisibleEnd],
	);

	useEffect(
		() => () => {
			dragRef.current = null;
		},
		[],
	);

	const startDrag = useCallback(
		(mode: NavigatorDragMode, event: ReactPointerEvent<HTMLElement>) => {
			const overview = overviewRef.current;
			if (!overview) return;
			event.preventDefault();
			event.stopPropagation();
			dragRef.current = {
				mode,
				startClientX: event.clientX,
				overviewWidthPx: Math.max(1, overview.clientWidth),
				startVisibleStartSec: safeVisibleStart,
				startVisibleEndSec: safeVisibleEnd,
			};
			setDragging(true);
			startGlobalPointerDrag(event, {
				onMove: (moveEvent) => {
					const current = dragRef.current;
					if (!current) return;
					const deltaFrac = (moveEvent.clientX - current.startClientX) / current.overviewWidthPx;
					const deltaSec = deltaFrac * safeSource;
					if (current.mode === "move") {
						const duration = current.startVisibleEndSec - current.startVisibleStartSec;
						const nextStart = clamp(
							current.startVisibleStartSec + deltaSec,
							0,
							Math.max(0, safeSource - duration),
						);
						onSetVisibleWindow(nextStart, nextStart + duration);
						return;
					}
					if (current.mode === "start") {
						const minVisibleDurationSec = Math.max(0.1, safeSource / 280);
						const maxStart = Math.max(0, current.startVisibleEndSec - minVisibleDurationSec);
						const nextStart = clamp(current.startVisibleStartSec + deltaSec, 0, maxStart);
						onSetVisibleWindow(nextStart, current.startVisibleEndSec);
						return;
					}
					// mode === "end"
					const minVisibleDurationSec = Math.max(0.1, safeSource / 280);
					const minEnd = Math.min(safeSource, current.startVisibleStartSec + minVisibleDurationSec);
					const nextEnd = clamp(current.startVisibleEndSec + deltaSec, minEnd, safeSource);
					onSetVisibleWindow(current.startVisibleStartSec, nextEnd);
				},
				onEnd: () => {
					dragRef.current = null;
					setDragging(false);
				},
			});
		},
		[safeSource, safeVisibleStart, safeVisibleEnd, onSetVisibleWindow],
	);

	return (
		<div
			ref={overviewRef}
			className={
				dragging ? `${styles.timelineNavigator} ${styles.navigating}` : styles.timelineNavigator
			}
			aria-label="Timeline zoom and pan navigator"
		>
			<div className={styles.timelineNavigatorContent}>
				{skipRanges.map((skip) => (
					<span
						key={skip.id}
						className={styles.timelineNavigatorSkip}
						style={{
							left: `${(skip.startSec / safeSource) * 100}%`,
							width: `${((skip.endSec - skip.startSec) / safeSource) * 100}%`,
						}}
					/>
				))}
			</div>
			<div
				className={styles.timelineNavigatorWindow}
				style={windowStyle}
				onPointerDown={(event) => startDrag("move", event)}
			>
				<span
					className={styles.timelineNavigatorHandleStart}
					onPointerDown={(event) => startDrag("start", event)}
				/>
				<span
					className={styles.timelineNavigatorHandleEnd}
					onPointerDown={(event) => startDrag("end", event)}
				/>
			</div>
		</div>
	);
}
