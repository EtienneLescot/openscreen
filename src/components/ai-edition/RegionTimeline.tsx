import {
	type DragEndEvent,
	type DragMoveEvent,
	type ResizeEndEvent,
	type ResizeMoveEvent,
	type Span,
	TimelineContext,
	useItem,
	useRow,
	useTimelineContext,
} from "dnd-timeline";

export type { Span };

import { createContext, useCallback, useContext, useState } from "react";
import { formatMs } from "@/lib/ai-edition/timeline/format";
import styles from "./NewEditorShell.module.css";

// Zoom/annotation/speed lanes, made draggable + resizable via dnd-timeline
// (already a dependency — see OpenScreen's old TimelineWrapper.tsx/Item.tsx/
// Row.tsx on `main` for the reference this ports): clamp-to-bounds +
// collision-clamp against sibling spans, plus the F2.6 snap-guide and
// floating drag tooltip during live drag/resize (parity with the clip
// timeline's T24/T25).

// F2.6 — the span currently being dragged/resized, resolved through the same
// clamp pipeline as the final drop. The surface renders guides + tooltip.
const LiveSpanContext = createContext<{ id: string; span: Span } | null>(null);

const MIN_ITEM_DURATION_MS = 100;

interface RegionSpanRef {
	id: string;
	// ponytail: scopes collision to the same lane — zoom and speed rows are
	// independent tracks, so a zoom over a speed range (or vice versa) is fine.
	rowId: string;
	start: number;
	end: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

interface RegionTimelineProviderProps {
	totalMs: number;
	// Spans that must not overlap each other (zoom, speed). Annotation spans
	// are intentionally excluded — multiple annotations may overlap.
	collidableSpans: RegionSpanRef[];
	onItemSpanChange: (id: string, span: Span) => void;
	children: React.ReactNode;
}

export function RegionTimelineProvider({
	totalMs,
	collidableSpans,
	onItemSpanChange,
	children,
}: RegionTimelineProviderProps) {
	const safeTotalMs = Math.max(totalMs, 1);

	const clampSpanToBounds = useCallback(
		(span: Span): Span => {
			const rawDuration = Math.max(span.end - span.start, 0);
			const duration = Math.min(Math.max(rawDuration, MIN_ITEM_DURATION_MS), safeTotalMs);
			const start = clamp(span.start, 0, safeTotalMs - duration);
			return { start, end: start + duration };
		},
		[safeTotalMs],
	);

	const hasOverlap = useCallback(
		(span: Span, excludeId: string, rowId: string) =>
			collidableSpans.some(
				(r) => r.id !== excludeId && r.rowId === rowId && span.end > r.start && span.start < r.end,
			),
		[collidableSpans],
	);

	const clampToNeighbours = useCallback(
		(span: Span, activeItemId: string, rowId: string): Span => {
			const siblings = collidableSpans.filter((r) => r.id !== activeItemId && r.rowId === rowId);
			let { start, end } = span;
			for (const r of siblings) {
				if (end > r.start && start < r.start) end = r.start;
				if (start < r.end && end > r.end) start = r.end;
			}
			if (end - start < MIN_ITEM_DURATION_MS) {
				if (end + MIN_ITEM_DURATION_MS - (end - start) <= safeTotalMs) {
					end = start + MIN_ITEM_DURATION_MS;
				} else {
					start = end - MIN_ITEM_DURATION_MS;
				}
			}
			return { start: Math.max(0, start), end: Math.min(end, safeTotalMs) };
		},
		[collidableSpans, safeTotalMs],
	);

	const resolveSpan = useCallback(
		(rawSpan: Span, activeItemId: string): Span | null => {
			// Resolve the active item's row from the collidable set. Annotations
			// are intentionally not in it, so missing here means "no collision
			// rules apply" (annotations may freely overlap).
			const activeRow = collidableSpans.find((r) => r.id === activeItemId)?.rowId;
			if (!activeRow) return clampSpanToBounds(rawSpan);
			let span = clampSpanToBounds(rawSpan);
			if (hasOverlap(span, activeItemId, activeRow)) {
				span = clampToNeighbours(span, activeItemId, activeRow);
				if (hasOverlap(span, activeItemId, activeRow)) return null;
			}
			return span;
		},
		[clampSpanToBounds, clampToNeighbours, hasOverlap, collidableSpans],
	);

	const [liveSpan, setLiveSpan] = useState<{ id: string; span: Span } | null>(null);

	const onResizeEnd = useCallback(
		(event: ResizeEndEvent) => {
			setLiveSpan(null);
			const updatedSpan = event.active.data.current.getSpanFromResizeEvent?.(event);
			if (!updatedSpan) return;
			const activeItemId = event.active.id as string;
			const span = resolveSpan(updatedSpan, activeItemId);
			if (span) onItemSpanChange(activeItemId, span);
		},
		[onItemSpanChange, resolveSpan],
	);

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			setLiveSpan(null);
			if (!event.over) return;
			const updatedSpan = event.active.data.current.getSpanFromDragEvent?.(event);
			if (!updatedSpan) return;
			const activeItemId = event.active.id as string;
			const span = resolveSpan(updatedSpan, activeItemId);
			if (span) onItemSpanChange(activeItemId, span);
		},
		[onItemSpanChange, resolveSpan],
	);

	// F2.6 — live feedback while the pointer is still down. The resolved span
	// is what would be committed on release, so the guide/tooltip show the
	// clamped values (not the raw pointer position).
	const onResizeMove = useCallback(
		(event: ResizeMoveEvent) => {
			const updatedSpan = event.active.data.current.getSpanFromResizeEvent?.(event);
			if (!updatedSpan) return;
			const activeItemId = event.active.id as string;
			const span = resolveSpan(updatedSpan, activeItemId);
			if (span) setLiveSpan({ id: activeItemId, span });
		},
		[resolveSpan],
	);

	const onDragMove = useCallback(
		(event: DragMoveEvent) => {
			const updatedSpan = event.active.data.current.getSpanFromDragEvent?.(event);
			if (!updatedSpan) return;
			const activeItemId = event.active.id as string;
			const span = resolveSpan(updatedSpan, activeItemId);
			if (span) setLiveSpan({ id: activeItemId, span });
		},
		[resolveSpan],
	);

	return (
		<TimelineContext
			range={{ start: 0, end: safeTotalMs }}
			// Range is read-only for the regions surface (zoom/pan live on the clip track).
			onRangeChanged={() => {
				// intentionally empty
			}}
			onResizeMove={onResizeMove}
			onResizeEnd={onResizeEnd}
			onDragMove={onDragMove}
			onDragEnd={onDragEnd}
			onDragCancel={() => setLiveSpan(null)}
		>
			<LiveSpanContext.Provider value={liveSpan}>{children}</LiveSpanContext.Provider>
		</TimelineContext>
	);
}

export function RegionTimelineSurface({
	pxPerSec,
	totalMs,
	children,
}: {
	// Lane pill positions come from dnd-timeline in ms, and the library maps
	// 1 px = range / timelineWidth. We set the surface width to totalMs*pxPerSec
	// so dnd-timeline naturally maps 1 ms = pxPerSec/1000 px — same as the
	// timeline ruler ticks — keeping pills aligned with the clip track at any
	// zoom. Lanes do not share the clip track's horizontal-scroll container;
	// at very long timelines (>30s) they sit fully visible while the clip
	// track scrolls. See roadmap P3 for the full shared-scroll follow-up.
	pxPerSec: number;
	totalMs: number;
	children: React.ReactNode;
}) {
	const { setTimelineRef, style } = useTimelineContext();
	const liveSpan = useContext(LiveSpanContext);
	const msToPx = pxPerSec / 1000;
	return (
		<div
			ref={setTimelineRef}
			style={{
				...style,
				position: "relative",
				width: (Math.max(totalMs, 1) * pxPerSec) / 1000,
			}}
			className={styles.laneSurface}
		>
			{children}
			{liveSpan ? (
				<>
					<div className={styles.laneSnapGuide} style={{ left: liveSpan.span.start * msToPx }} />
					<div className={styles.laneSnapGuide} style={{ left: liveSpan.span.end * msToPx }} />
					<div className={styles.laneDragTooltip} style={{ left: liveSpan.span.end * msToPx + 6 }}>
						{formatMs(liveSpan.span.start)} – {formatMs(liveSpan.span.end)}
					</div>
				</>
			) : null}
		</div>
	);
}

export function RegionRow({
	id,
	empty,
	children,
}: {
	id: string;
	empty?: string;
	children: React.ReactNode;
}) {
	const { setNodeRef, rowStyle, rowWrapperStyle } = useRow({ id });
	return (
		<div style={rowWrapperStyle} className={styles.laneTrackRow}>
			{empty ? <span className={styles.laneEmpty}>{empty}</span> : null}
			<div ref={setNodeRef} style={rowStyle}>
				{children}
			</div>
		</div>
	);
}

interface RegionItemProps {
	id: string;
	rowId: string;
	span: Span;
	label: string;
	icon: React.ReactNode;
	selected: boolean;
	/** F2.7 — `additive` is true on shift-click (adds to the multi-selection). */
	onSelect: (additive: boolean) => void;
	variant: "zoom" | "annotation" | "speed" | "skip";
}

export function RegionItem({
	id,
	rowId,
	span,
	label,
	icon,
	selected,
	onSelect,
	variant,
}: RegionItemProps) {
	const { setNodeRef, listeners, attributes, itemStyle, itemContentStyle } = useItem({
		id,
		span,
		data: { rowId },
	});
	const pillClass =
		variant === "zoom"
			? styles.zoomPill
			: variant === "speed"
				? styles.speedPill
				: variant === "skip"
					? styles.skipPill
					: styles.annotationPill;
	return (
		<div
			ref={setNodeRef}
			style={{ ...itemStyle, height: "100%", minWidth: 12 }}
			{...listeners}
			{...attributes}
			onPointerDownCapture={(event) => onSelect(event.shiftKey)}
		>
			<div style={{ ...itemContentStyle, height: "100%", minWidth: 24 }}>
				<div
					className={selected ? `${pillClass} ${styles.lanePillSelected}` : pillClass}
					// The pill's own CSS is written for absolute left/top-50% placement
					// inside the old static `.laneTrack`; here dnd-timeline's outer
					// divs already own absolute positioning + width, so the pill just
					// fills that box.
					style={{ position: "relative", top: 0, transform: "none", width: "100%", height: "100%" }}
					title={label}
				>
					{icon}
					<span className={styles.pillValue}>{label}</span>
				</div>
			</div>
		</div>
	);
}
