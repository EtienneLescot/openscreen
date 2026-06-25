import { Plus, Trash2 } from "lucide-react";
import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type WheelEvent as ReactWheelEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Interval } from "@/lib/ai-edition/document/timeline";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import {
	formatSeconds,
	locateVirtualPosition,
	totalVirtualDuration,
} from "@/lib/ai-edition/timeline/virtual-preview";
import styles from "./TimelinePane.module.css";

// ponytail: ported from axcut/apps/web/src/components/TimelinePane.tsx, adapted
// to CSS modules + OpenScreen imports. Single-source trim view: clips are kept
// intervals, cuts are removed ranges. Multi-asset drag-drop lands in a follow-up.

interface TimelinePaneProps {
	clips: AxcutClip[];
	currentTimeSec: number;
	sourceDurationSec: number;
	busy?: boolean;
	onPreviewSource: (sourceTimeSec: number) => void;
	onReplaceTimeline: (intervals: Interval[], reason: string) => void;
}

interface SourceRange {
	id: string;
	startSec: number;
	endSec: number;
}

type TimelineItem = SourceRange & { kind: "kept" | "cut" };

interface ResizeState {
	id: number;
	cutId: string;
	edge: "start" | "end";
	startClientX: number;
	startSec: number;
	endSec: number;
	currentStartSec: number;
	currentEndSec: number;
	baseCuts: SourceRange[];
	pxPerSec: number;
}

interface PanState {
	startClientX: number;
	startScrollLeft: number;
}

interface NavigatorDragState {
	mode: "move" | "start" | "end";
	startClientX: number;
	overviewWidthPx: number;
	startVisibleStartSec: number;
	startVisibleEndSec: number;
}

const MIN_CUT_DURATION_SEC = 0.1;
const MIN_SOURCE_DURATION_SEC = 0.001;
const MAX_PX_PER_SEC = 280;
const MIN_SEGMENT_WIDTH_PX = 1;
const RULER_HEIGHT_PX = 28;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function normalizeRanges(
	durationSec: number,
	ranges: Array<{ id?: string; startSec: number; endSec: number }>,
	idPrefix: string,
): SourceRange[] {
	const normalized = ranges
		.map((range, index) => ({
			id: range.id ?? `${idPrefix}_${index + 1}`,
			startSec: clamp(range.startSec, 0, durationSec),
			endSec: clamp(range.endSec, 0, durationSec),
		}))
		.filter((range) => range.endSec > range.startSec)
		.sort((a, b) => a.startSec - b.startSec);
	const merged: SourceRange[] = [];
	for (const range of normalized) {
		const previous = merged.at(-1);
		if (!previous || range.startSec > previous.endSec) {
			merged.push({ ...range, id: `${idPrefix}_${merged.length + 1}` });
			continue;
		}
		previous.endSec = Math.max(previous.endSec, range.endSec);
	}
	return merged;
}

function deriveCutRanges(keptIntervals: SourceRange[], durationSec: number): SourceRange[] {
	if (durationSec <= MIN_SOURCE_DURATION_SEC || keptIntervals.length === 0) return [];
	const cuts: SourceRange[] = [];
	let cursor = 0;
	for (const interval of keptIntervals) {
		if (interval.startSec > cursor) {
			cuts.push({ id: `cut_${cuts.length + 1}`, startSec: cursor, endSec: interval.startSec });
		}
		cursor = Math.max(cursor, interval.endSec);
	}
	if (cursor < durationSec) {
		cuts.push({ id: `cut_${cuts.length + 1}`, startSec: cursor, endSec: durationSec });
	}
	return cuts;
}

function invertCutRanges(cuts: SourceRange[], durationSec: number): SourceRange[] {
	const intervals: SourceRange[] = [];
	let cursor = 0;
	for (const cut of normalizeRanges(durationSec, cuts, "cut")) {
		if (cut.startSec > cursor) {
			intervals.push({
				id: `clip_${intervals.length + 1}`,
				startSec: cursor,
				endSec: cut.startSec,
			});
		}
		cursor = Math.max(cursor, cut.endSec);
	}
	if (cursor < durationSec) {
		intervals.push({ id: `clip_${intervals.length + 1}`, startSec: cursor, endSec: durationSec });
	}
	return intervals;
}

function buildTimelineItems(kept: SourceRange[], cuts: SourceRange[]): TimelineItem[] {
	return [
		...kept.map((r) => ({ ...r, kind: "kept" as const })),
		...cuts.map((r) => ({ ...r, kind: "cut" as const })),
	].sort((a, b) => a.startSec - b.startSec || (a.kind === "kept" ? -1 : 1));
}

function timelineItemStyle(item: TimelineItem, pxPerSec: number): CSSProperties {
	return {
		left: `${item.startSec * pxPerSec}px`,
		width: `${Math.max(MIN_SEGMENT_WIDTH_PX, (item.endSec - item.startSec) * pxPerSec)}px`,
		minWidth: `${MIN_SEGMENT_WIDTH_PX}px`,
	};
}

function buildRulerTicks(
	durationSec: number,
	pxPerSec: number,
): Array<{ timeSec: number; major: boolean }> {
	const majorStepSec = chooseTickStep(90 / Math.max(pxPerSec, 0.001));
	const minorStepSec = majorStepSec / 5;
	const ticks: Array<{ timeSec: number; major: boolean }> = [];
	for (let timeSec = 0; timeSec <= durationSec + minorStepSec / 2; timeSec += minorStepSec) {
		const rounded = Number(timeSec.toFixed(4));
		const major = Math.abs(rounded / majorStepSec - Math.round(rounded / majorStepSec)) < 0.001;
		ticks.push({ timeSec: Math.min(durationSec, rounded), major });
	}
	return ticks;
}

function chooseTickStep(minStepSec: number): number {
	const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
	return steps.find((step) => step >= minStepSec) ?? steps.at(-1) ?? 600;
}

export function TimelinePane({
	clips,
	currentTimeSec,
	sourceDurationSec,
	busy = false,
	onPreviewSource,
	onReplaceTimeline,
}: TimelinePaneProps) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const overviewRef = useRef<HTMLDivElement | null>(null);
	const resizeRef = useRef<ResizeState | null>(null);
	const panRef = useRef<PanState | null>(null);
	const navigatorDragRef = useRef<NavigatorDragState | null>(null);
	const resizeSequenceRef = useRef(0);
	const [viewportWidthPx, setViewportWidthPx] = useState(0);
	const [scrollLeftPx, setScrollLeftPx] = useState(0);
	const [zoom, setZoom] = useState(1);
	const [resizeState, setResizeState] = useState<ResizeState | null>(null);
	const [panning, setPanning] = useState(false);
	const [scrubbing, setScrubbing] = useState(false);
	const [navigatorDragging, setNavigatorDragging] = useState(false);

	const virtualDurationSec = totalVirtualDuration(clips);
	const activePosition = locateVirtualPosition(clips, currentTimeSec);
	const sourceDuration = useMemo(
		() =>
			Math.max(
				sourceDurationSec,
				...clips.map((clip) => clip.sourceEndSec ?? 0),
				MIN_SOURCE_DURATION_SEC,
			),
		[clips, sourceDurationSec],
	);
	const fitPxPerSec = useMemo(
		() => Math.max(0.001, viewportWidthPx / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC)),
		[sourceDuration, viewportWidthPx],
	);
	const pxPerSec = clamp(fitPxPerSec * zoom, fitPxPerSec, MAX_PX_PER_SEC);
	const contentWidthPx = Math.max(viewportWidthPx, Math.ceil(sourceDuration * pxPerSec));
	const visibleStartSec = clamp(scrollLeftPx / Math.max(pxPerSec, 0.001), 0, sourceDuration);
	const visibleDurationSec = clamp(viewportWidthPx / Math.max(pxPerSec, 0.001), 0, sourceDuration);
	const visibleEndSec = clamp(visibleStartSec + visibleDurationSec, 0, sourceDuration);
	const navigatorWindowStyle = useMemo(
		() =>
			({
				left: `${(visibleStartSec / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC)) * 100}%`,
				width: `${Math.max(0, ((visibleEndSec - visibleStartSec) / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC)) * 100)}%`,
			}) as CSSProperties,
		[sourceDuration, visibleEndSec, visibleStartSec],
	);

	const keptIntervals = useMemo(
		() =>
			normalizeRanges(
				sourceDuration,
				clips.map((clip) => ({ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec ?? 0 })),
				"clip",
			),
		[clips, sourceDuration],
	);
	const committedCutRanges = useMemo(
		() => deriveCutRanges(keptIntervals, sourceDuration),
		[keptIntervals, sourceDuration],
	);
	const visibleCutRanges = useMemo(() => {
		if (!resizeState) return committedCutRanges;
		return normalizeRanges(
			sourceDuration,
			committedCutRanges.map((cut) =>
				cut.id === resizeState.cutId
					? { id: cut.id, startSec: resizeState.currentStartSec, endSec: resizeState.currentEndSec }
					: cut,
			),
			"cut",
		);
	}, [committedCutRanges, resizeState, sourceDuration]);
	const visibleKeptIntervals = useMemo(
		() => invertCutRanges(visibleCutRanges, sourceDuration),
		[sourceDuration, visibleCutRanges],
	);
	const timelineItems = useMemo(
		() => buildTimelineItems(visibleKeptIntervals, visibleCutRanges),
		[visibleKeptIntervals, visibleCutRanges],
	);
	const rulerTicks = useMemo(
		() => buildRulerTicks(sourceDuration, pxPerSec),
		[pxPerSec, sourceDuration],
	);
	const playheadSourceSec = activePosition?.sourceTimeSec ?? null;

	useEffect(() => {
		const scrollElement = scrollRef.current;
		if (!scrollElement) return;
		const updateWidth = () => setViewportWidthPx(scrollElement.clientWidth);
		updateWidth();
		const observer = new ResizeObserver(updateWidth);
		observer.observe(scrollElement);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		resizeRef.current = resizeState;
	}, [resizeState]);

	const replaceTimelineFromCuts = useCallback(
		(cuts: SourceRange[], reason: string) => {
			onReplaceTimeline(
				invertCutRanges(normalizeRanges(sourceDuration, cuts, "cut"), sourceDuration),
				reason,
			);
		},
		[onReplaceTimeline, sourceDuration],
	);

	const seekSource = useCallback(
		(sourceSec: number) => {
			const bounded = clamp(sourceSec, 0, sourceDuration);
			onPreviewSource(bounded);
		},
		[onPreviewSource, sourceDuration],
	);

	const seekClientX = useCallback(
		(clientX: number) => {
			const scrollElement = scrollRef.current;
			if (!scrollElement) return;
			const rect = scrollElement.getBoundingClientRect();
			const sourceSec =
				(scrollElement.scrollLeft + clientX - rect.left) / Math.max(pxPerSec, 0.001);
			seekSource(sourceSec);
		},
		[pxPerSec, seekSource],
	);

	const zoomAt = useCallback(
		(nextZoom: number, anchorClientX?: number) => {
			const scrollElement = scrollRef.current;
			const boundedZoom = clamp(nextZoom, 1, MAX_PX_PER_SEC / Math.max(fitPxPerSec, 0.001));
			if (!scrollElement) {
				setZoom(boundedZoom);
				return;
			}
			const rect = scrollElement.getBoundingClientRect();
			const anchorX = anchorClientX === undefined ? rect.left + rect.width / 2 : anchorClientX;
			const sourceAtAnchor = (scrollElement.scrollLeft + anchorX - rect.left) / pxPerSec;
			const nextPxPerSec = clamp(fitPxPerSec * boundedZoom, fitPxPerSec, MAX_PX_PER_SEC);
			setZoom(boundedZoom);
			requestAnimationFrame(() => {
				const nextScrollLeft = Math.max(0, sourceAtAnchor * nextPxPerSec - (anchorX - rect.left));
				scrollElement.scrollLeft = nextScrollLeft;
				setScrollLeftPx(scrollElement.scrollLeft);
			});
		},
		[fitPxPerSec, pxPerSec],
	);

	const setVisibleWindow = useCallback(
		(startSec: number, endSec: number) => {
			const scrollElement = scrollRef.current;
			if (!scrollElement || viewportWidthPx <= 0) return;
			const minVisibleDurationSec = Math.max(
				MIN_CUT_DURATION_SEC,
				viewportWidthPx / MAX_PX_PER_SEC,
			);
			const visibleDuration = clamp(endSec - startSec, minVisibleDurationSec, sourceDuration);
			const visibleStart = clamp(startSec, 0, Math.max(0, sourceDuration - visibleDuration));
			const nextPxPerSec = viewportWidthPx / Math.max(visibleDuration, MIN_SOURCE_DURATION_SEC);
			const nextZoom = clamp(
				nextPxPerSec / Math.max(fitPxPerSec, 0.001),
				1,
				MAX_PX_PER_SEC / Math.max(fitPxPerSec, 0.001),
			);
			setZoom(nextZoom);
			requestAnimationFrame(() => {
				const currentPxPerSec = clamp(fitPxPerSec * nextZoom, fitPxPerSec, MAX_PX_PER_SEC);
				scrollElement.scrollLeft = visibleStart * currentPxPerSec;
				setScrollLeftPx(scrollElement.scrollLeft);
			});
		},
		[fitPxPerSec, sourceDuration, viewportWidthPx],
	);

	const fitTimeline = useCallback(() => {
		setZoom(1);
		requestAnimationFrame(() => {
			if (scrollRef.current) {
				scrollRef.current.scrollLeft = 0;
				setScrollLeftPx(0);
			}
		});
	}, []);

	const addCut = useCallback(() => {
		if (busy || sourceDuration <= MIN_SOURCE_DURATION_SEC) return;
		const centerSec = activePosition?.sourceTimeSec ?? clips[0]?.sourceStartSec ?? 0;
		const startSec = clamp(centerSec - 0.5, 0, Math.max(0, sourceDuration - MIN_CUT_DURATION_SEC));
		const endSec = clamp(centerSec + 0.5, startSec + MIN_CUT_DURATION_SEC, sourceDuration);
		replaceTimelineFromCuts(
			[...committedCutRanges, { id: `cut_${committedCutRanges.length + 1}`, startSec, endSec }],
			`Added cut ${formatSeconds(startSec)}-${formatSeconds(endSec)}`,
		);
	}, [
		activePosition?.sourceTimeSec,
		busy,
		clips,
		committedCutRanges,
		replaceTimelineFromCuts,
		sourceDuration,
	]);

	const deleteCut = useCallback(
		(cut: SourceRange) => {
			if (busy) return;
			replaceTimelineFromCuts(
				committedCutRanges.filter((item) => item.id !== cut.id),
				`Deleted cut ${formatSeconds(cut.startSec)}-${formatSeconds(cut.endSec)}`,
			);
		},
		[busy, committedCutRanges, replaceTimelineFromCuts],
	);

	const startResize = useCallback(
		(cut: SourceRange, edge: ResizeState["edge"], event: ReactPointerEvent<HTMLElement>) => {
			if (busy) return;
			event.preventDefault();
			event.stopPropagation();
			const nextState: ResizeState = {
				id: resizeSequenceRef.current + 1,
				cutId: cut.id,
				edge,
				startClientX: event.clientX,
				startSec: cut.startSec,
				endSec: cut.endSec,
				currentStartSec: cut.startSec,
				currentEndSec: cut.endSec,
				baseCuts: committedCutRanges,
				pxPerSec,
			};
			resizeSequenceRef.current = nextState.id;
			resizeRef.current = nextState;
			setResizeState(nextState);
			seekSource(edge === "start" ? cut.startSec : cut.endSec);

			const move = (moveEvent: PointerEvent) => {
				const current = resizeRef.current;
				if (!current) return;
				const deltaSec =
					(moveEvent.clientX - current.startClientX) / Math.max(current.pxPerSec, 0.001);
				const currentIndex = current.baseCuts.findIndex((item) => item.id === current.cutId);
				const previousCut = currentIndex > 0 ? current.baseCuts[currentIndex - 1] : null;
				const nextCut =
					currentIndex >= 0 && currentIndex < current.baseCuts.length - 1
						? current.baseCuts[currentIndex + 1]
						: null;
				const nextStartSec =
					current.edge === "start"
						? clamp(
								current.startSec + deltaSec,
								previousCut?.endSec ?? 0,
								current.currentEndSec - MIN_CUT_DURATION_SEC,
							)
						: current.currentStartSec;
				const nextEndSec =
					current.edge === "end"
						? clamp(
								current.endSec + deltaSec,
								current.currentStartSec + MIN_CUT_DURATION_SEC,
								nextCut?.startSec ?? sourceDuration,
							)
						: current.currentEndSec;
				const updated = { ...current, currentStartSec: nextStartSec, currentEndSec: nextEndSec };
				resizeRef.current = updated;
				setResizeState(updated);
				seekSource(current.edge === "start" ? nextStartSec : nextEndSec);
			};

			const end = () => {
				const current = resizeRef.current;
				resizeRef.current = null;
				setResizeState(null);
				globalThis.document.body.classList.remove("timeline-resizing-cut");
				globalThis.window.removeEventListener("pointermove", move);
				globalThis.window.removeEventListener("pointerup", end);
				globalThis.window.removeEventListener("pointercancel", end);
				if (!current) return;
				if (
					Math.abs(current.currentStartSec - current.startSec) < 0.01 &&
					Math.abs(current.currentEndSec - current.endSec) < 0.01
				)
					return;
				replaceTimelineFromCuts(
					current.baseCuts.map((item) =>
						item.id === current.cutId
							? { ...item, startSec: current.currentStartSec, endSec: current.currentEndSec }
							: item,
					),
					`Resized cut ${formatSeconds(current.startSec)}-${formatSeconds(current.endSec)} → ${formatSeconds(current.currentStartSec)}-${formatSeconds(current.currentEndSec)}`,
				);
			};

			globalThis.document.body.classList.add("timeline-resizing-cut");
			globalThis.window.addEventListener("pointermove", move);
			globalThis.window.addEventListener("pointerup", end, { once: true });
			globalThis.window.addEventListener("pointercancel", end, { once: true });
		},
		[busy, committedCutRanges, replaceTimelineFromCuts, pxPerSec, seekSource, sourceDuration],
	);

	const startScrub = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest(`.${styles.cutHandle}, .${styles.cutDelete}`)) return;
			if (event.button !== 0 || clips.length === 0) return;
			event.preventDefault();
			seekClientX(event.clientX);
			setScrubbing(true);
			globalThis.document.body.classList.add("timeline-scrubbing");
			const move = (moveEvent: PointerEvent) => seekClientX(moveEvent.clientX);
			const end = () => {
				setScrubbing(false);
				globalThis.document.body.classList.remove("timeline-scrubbing");
				globalThis.window.removeEventListener("pointermove", move);
				globalThis.window.removeEventListener("pointerup", end);
				globalThis.window.removeEventListener("pointercancel", end);
			};
			globalThis.window.addEventListener("pointermove", move);
			globalThis.window.addEventListener("pointerup", end, { once: true });
			globalThis.window.addEventListener("pointercancel", end, { once: true });
		},
		[clips.length, seekClientX],
	);

	const startPan = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const target = event.target instanceof Element ? event.target : null;
			if (busy || target?.closest(`button, .${styles.cutHandle}, .${styles.cutDelete}`)) return;
			const scrollElement = scrollRef.current;
			if (!scrollElement || scrollElement.scrollWidth <= scrollElement.clientWidth) return;
			event.preventDefault();
			panRef.current = { startClientX: event.clientX, startScrollLeft: scrollElement.scrollLeft };
			setPanning(true);
			globalThis.document.body.classList.add("timeline-panning");
			const move = (moveEvent: PointerEvent) => {
				const pan = panRef.current;
				if (!pan || !scrollRef.current) return;
				scrollRef.current.scrollLeft = pan.startScrollLeft - (moveEvent.clientX - pan.startClientX);
			};
			const end = () => {
				panRef.current = null;
				setPanning(false);
				globalThis.document.body.classList.remove("timeline-panning");
				globalThis.window.removeEventListener("pointermove", move);
				globalThis.window.removeEventListener("pointerup", end);
				globalThis.window.removeEventListener("pointercancel", end);
			};
			globalThis.window.addEventListener("pointermove", move);
			globalThis.window.addEventListener("pointerup", end, { once: true });
			globalThis.window.addEventListener("pointercancel", end, { once: true });
		},
		[busy],
	);

	const handleTimelinePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (event.altKey || event.button === 1) {
				startPan(event);
				return;
			}
			startScrub(event);
		},
		[startPan, startScrub],
	);

	const handleWheel = useCallback(
		(event: ReactWheelEvent<HTMLDivElement>) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			const direction = event.deltaY > 0 ? -1 : 1;
			zoomAt(zoom * (direction > 0 ? 1.18 : 1 / 1.18), event.clientX);
		},
		[zoom, zoomAt],
	);

	const handleTimelineScroll = useCallback(() => {
		setScrollLeftPx(scrollRef.current?.scrollLeft ?? 0);
	}, []);

	const startNavigatorDrag = useCallback(
		(mode: NavigatorDragState["mode"], event: ReactPointerEvent<HTMLElement>) => {
			if (busy || clips.length === 0) return;
			const overview = overviewRef.current;
			if (!overview) return;
			event.preventDefault();
			event.stopPropagation();
			const nextState: NavigatorDragState = {
				mode,
				startClientX: event.clientX,
				overviewWidthPx: Math.max(1, overview.clientWidth),
				startVisibleStartSec: visibleStartSec,
				startVisibleEndSec: visibleEndSec,
			};
			navigatorDragRef.current = nextState;
			setNavigatorDragging(true);
			globalThis.document.body.classList.add("timeline-navigating");
			const move = (moveEvent: PointerEvent) => {
				const current = navigatorDragRef.current;
				if (!current) return;
				const deltaSec =
					((moveEvent.clientX - current.startClientX) / current.overviewWidthPx) * sourceDuration;
				const currentDuration = current.startVisibleEndSec - current.startVisibleStartSec;
				if (current.mode === "move") {
					const nextStartSec = clamp(
						current.startVisibleStartSec + deltaSec,
						0,
						Math.max(0, sourceDuration - currentDuration),
					);
					setVisibleWindow(nextStartSec, nextStartSec + currentDuration);
					return;
				}
				if (current.mode === "start") {
					const nextStartSec = clamp(
						current.startVisibleStartSec + deltaSec,
						0,
						current.startVisibleEndSec - MIN_CUT_DURATION_SEC,
					);
					setVisibleWindow(nextStartSec, current.startVisibleEndSec);
					return;
				}
				const nextEndSec = clamp(
					current.startVisibleEndSec + deltaSec,
					current.startVisibleStartSec + MIN_CUT_DURATION_SEC,
					sourceDuration,
				);
				setVisibleWindow(current.startVisibleStartSec, nextEndSec);
			};
			const end = () => {
				navigatorDragRef.current = null;
				setNavigatorDragging(false);
				globalThis.document.body.classList.remove("timeline-navigating");
				globalThis.window.removeEventListener("pointermove", move);
				globalThis.window.removeEventListener("pointerup", end);
				globalThis.window.removeEventListener("pointercancel", end);
			};
			globalThis.window.addEventListener("pointermove", move);
			globalThis.window.addEventListener("pointerup", end, { once: true });
			globalThis.window.addEventListener("pointercancel", end, { once: true });
		},
		[busy, clips.length, setVisibleWindow, sourceDuration, visibleEndSec, visibleStartSec],
	);

	return (
		<section className={styles.pane}>
			<div className={styles.header}>
				<div>
					<h2 className={styles.heading}>Timeline</h2>
					<p className={styles.meta}>
						{clips.length} clip{clips.length === 1 ? "" : "s"} · {committedCutRanges.length} cut
						{committedCutRanges.length === 1 ? "" : "s"} · {formatSeconds(virtualDurationSec)} total
					</p>
				</div>
				<div className={styles.readout}>
					<button
						type="button"
						className={styles.tool}
						onClick={addCut}
						disabled={busy || clips.length === 0}
						title="Add cut at playhead"
					>
						<Plus size={14} />
						<span>Add cut</span>
					</button>
					<strong>{formatSeconds(currentTimeSec)}</strong>
					<span className={styles.muted}>
						{activePosition
							? `Clip ${activePosition.clipIndex + 1}/${clips.length}`
							: "No active clip"}
					</span>
				</div>
			</div>

			<div className={styles.navigatorRow}>
				<button
					type="button"
					className={styles.fitButton}
					onClick={fitTimeline}
					disabled={zoom <= 1.01}
					title="Fit full timeline"
				>
					Fit
				</button>
				<div
					ref={overviewRef}
					className={
						navigatorDragging ? `${styles.navigator} ${styles.navigating}` : styles.navigator
					}
					aria-label="Timeline zoom and pan navigator"
				>
					<div className={styles.navigatorContent}>
						{committedCutRanges.map((cut) => (
							<span
								key={cut.id}
								className={styles.navigatorCut}
								style={{
									left: `${(cut.startSec / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC)) * 100}%`,
									width: `${((cut.endSec - cut.startSec) / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC)) * 100}%`,
								}}
							/>
						))}
					</div>
					<div
						className={styles.navigatorWindow}
						style={navigatorWindowStyle}
						onPointerDown={(e) => startNavigatorDrag("move", e)}
					>
						<span
							className={`${styles.navigatorHandle} ${styles.start}`}
							onPointerDown={(e) => startNavigatorDrag("start", e)}
						/>
						<span
							className={`${styles.navigatorHandle} ${styles.end}`}
							onPointerDown={(e) => startNavigatorDrag("end", e)}
						/>
					</div>
				</div>
			</div>

			<div
				ref={scrollRef}
				className={[
					styles.viewport,
					panning ? styles.panning : "",
					scrubbing ? styles.scrubbing : "",
				]
					.filter(Boolean)
					.join(" ")}
				onPointerDown={handleTimelinePointerDown}
				onWheel={handleWheel}
				onScroll={handleTimelineScroll}
				aria-label="Source timeline. Click or drag to scrub, Alt+drag to pan, Ctrl+wheel to zoom."
			>
				{clips.length > 0 ? (
					<div className={styles.canvas} style={{ width: `${contentWidthPx}px` }}>
						<div className={styles.ruler} style={{ height: `${RULER_HEIGHT_PX}px` }}>
							{rulerTicks.map((tick) => (
								<div
									key={`${tick.timeSec}-${tick.major ? "major" : "minor"}`}
									className={tick.major ? `${styles.tick} ${styles.tickMajor}` : styles.tick}
									style={{ left: `${tick.timeSec * pxPerSec}px` }}
								>
									{tick.major ? <span>{formatSeconds(tick.timeSec)}</span> : null}
								</div>
							))}
						</div>
						<div className={styles.trackLane}>
							{timelineItems.map((item) => {
								const itemStyle = timelineItemStyle(item, pxPerSec);
								if (item.kind === "cut") {
									const active = resizeState?.cutId === item.id;
									return (
										<div
											key={item.id}
											className={
												active
													? `${styles.segment} ${styles.cut} ${styles.active}`
													: `${styles.segment} ${styles.cut}`
											}
											style={itemStyle}
											title={`Cut ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
										>
											<button
												type="button"
												className={`${styles.cutHandle} ${styles.handleStart}`}
												onPointerDown={(e) => startResize(item, "start", e)}
												disabled={busy}
												aria-label={`Adjust cut start at ${formatSeconds(item.startSec)}`}
											/>
											<div className={styles.segmentLabel}>
												<span>Cut</span>
												<small>
													{formatSeconds(item.startSec)}–{formatSeconds(item.endSec)}
												</small>
											</div>
											<button
												type="button"
												className={styles.cutDelete}
												onClick={(e) => {
													e.stopPropagation();
													deleteCut(item);
												}}
												disabled={busy}
												aria-label={`Delete cut ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
											>
												<Trash2 size={12} />
											</button>
											<button
												type="button"
												className={`${styles.cutHandle} ${styles.handleEnd}`}
												onPointerDown={(e) => startResize(item, "end", e)}
												disabled={busy}
												aria-label={`Adjust cut end at ${formatSeconds(item.endSec)}`}
											/>
										</div>
									);
								}
								const active =
									playheadSourceSec !== null &&
									playheadSourceSec >= item.startSec &&
									playheadSourceSec <= item.endSec;
								return (
									<div
										key={item.id}
										className={
											active
												? `${styles.segment} ${styles.kept} ${styles.active}`
												: `${styles.segment} ${styles.kept}`
										}
										style={itemStyle}
										title={`Kept ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
									>
										<div className={styles.segmentLabel}>
											<span>{formatSeconds(item.startSec)}</span>
										</div>
									</div>
								);
							})}
							{playheadSourceSec !== null && (
								<div
									className={styles.playhead}
									style={{ left: `${playheadSourceSec * pxPerSec}px` }}
									aria-hidden="true"
								/>
							)}
						</div>
					</div>
				) : (
					<div className={styles.empty}>No clips yet. Add a video asset to start.</div>
				)}
			</div>
		</section>
	);
}
