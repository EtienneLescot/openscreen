// The edited cursor path drawn over the preview, with the one handle that shapes
// it. Sibling of `ZoomFocusOverlay` and built the same way — a plain CSS/SVG layer
// over the screen stage, not a Pixi one; #116's version was built on Pixi, which
// `main` dropped when the preview moved to the native compositor.
//
// Two paths are drawn, and the pair is the point: the recorded trajectory says
// where the cursor actually went, the edited one says where it will go. A single
// path would leave "is this better than what I recorded" unanswerable without
// scrubbing back and forth.
//
// Coordinates are normalised (0..1) against the SCREEN RECT, which is what the
// motion model stores and what the compositor samples, so nothing here converts
// between spaces. The viewBox is 0..100 with `preserveAspectRatio="none"`: the
// overlay stretches with the stage, and every stroke carries
// `vector-effect="non-scaling-stroke"` so that stretch never thickens a line.

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useMemo, useRef } from "react";
import type { AxcutCursorMotionRegion } from "@/lib/ai-edition/schema";
import { toModelCursorMotionRegion } from "@/lib/ai-edition/timeline/cursorMotionRegions";
import type { CursorMotionPoint } from "@/lib/cursor/cursorMotion";
import { sampleCursorMotionRegion } from "@/lib/cursor/cursorMotion";
import { clamp01 } from "@/utils/math";

/** Enough segments that an arc reads as a curve at any stage size, few enough that
 *  re-sampling on every drag frame stays free. The compositor re-samples the same
 *  curve at 240 Hz; this is only what the eye needs. */
const PATH_STEPS = 64;

interface CursorMotionPathOverlayProps {
	region: AxcutCursorMotionRegion;
	/** Recorded cursor positions for the owning asset, in SOURCE ms. Only the ones
	 *  inside the region's span are drawn. Absent when the recording carries no
	 *  telemetry, which just means the comparison line is absent.
	 *
	 *  Nullable, not just optional: `useCursorTelemetry` declares an array but hands
	 *  through whatever the bridge returns, and a bridge with no cursor endpoint —
	 *  the browser-mode shim, a platform without the sampler helper — returns null.
	 *  It reached here as a crash on `.filter`, so the null is handled where it
	 *  arrives rather than assumed away. */
	telemetry?: readonly { timeMs: number; cx: number; cy: number }[] | null;
	onControlPointChange: (id: string, point: CursorMotionPoint) => void;
	onControlPointCommit?: () => void;
}

function toPolyline(points: readonly CursorMotionPoint[]): string {
	return points.map((p) => `${(p.cx * 100).toFixed(3)},${(p.cy * 100).toFixed(3)}`).join(" ");
}

function AnchorMarker({
	point,
	kind,
}: {
	point: CursorMotionPoint;
	kind: AxcutCursorMotionRegion["startAnchor"];
}) {
	const x = point.cx * 100;
	const y = point.cy * 100;
	// A rest is a square, a click is a ringed dot, a manual cut is a plain dot.
	// Three shapes rather than three colours: the anchors sit on footage, and a
	// colour-only distinction disappears over the wrong frame.
	if (kind === "rest") {
		return (
			<rect
				x={x}
				y={y}
				width={10}
				height={10}
				rx={2}
				transform={`translate(-5,-5)`}
				fill="#f59e0b"
				stroke="#ffffff"
				strokeWidth={2}
				vectorEffect="non-scaling-stroke"
			/>
		);
	}
	return (
		<>
			<circle
				cx={x}
				cy={y}
				r={kind === "click" ? 6 : 4}
				fill={kind === "click" ? "#22d3ee" : "#0f172a"}
				stroke="#ffffff"
				strokeWidth={2}
				vectorEffect="non-scaling-stroke"
			/>
			{kind === "click" ? <circle cx={x} cy={y} r={2} fill="#0f172a" /> : null}
		</>
	);
}

export function CursorMotionPathOverlay({
	region,
	telemetry,
	onControlPointChange,
	onControlPointCommit,
}: CursorMotionPathOverlayProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const draggingRef = useRef(false);

	const model = useMemo(() => toModelCursorMotionRegion(region), [region]);

	const editedPath = useMemo(() => {
		// A hold has no path — its two anchors are the same point, and drawing a
		// zero-length line there would put a stray dot on the frame.
		if (region.segmentKind === "hold") return [];
		const span = model.sourceEndMs - model.sourceStartMs;
		return Array.from({ length: PATH_STEPS + 1 }, (_, i) =>
			sampleCursorMotionRegion(model, model.sourceStartMs + (span * i) / PATH_STEPS),
		);
	}, [model, region.segmentKind]);

	const recordedPath = useMemo(
		() =>
			(telemetry ?? [])
				.filter((s) => s.timeMs >= model.sourceStartMs && s.timeMs <= model.sourceEndMs)
				.map((s) => ({ cx: s.cx, cy: s.cy })),
		[telemetry, model.sourceStartMs, model.sourceEndMs],
	);

	const updateFromClientPoint = useCallback(
		(clientX: number, clientY: number) => {
			const el = hostRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			if (!rect.width || !rect.height) return;
			onControlPointChange(region.id, {
				cx: clamp01((clientX - rect.left) / rect.width),
				cy: clamp01((clientY - rect.top) / rect.height),
			});
		},
		[onControlPointChange, region.id],
	);

	const onPointerDown = useCallback(
		(e: ReactPointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			draggingRef.current = true;
			(e.target as Element).setPointerCapture?.(e.pointerId);
			updateFromClientPoint(e.clientX, e.clientY);
		},
		[updateFromClientPoint],
	);

	const onPointerMove = useCallback(
		(e: ReactPointerEvent) => {
			if (!draggingRef.current) return;
			updateFromClientPoint(e.clientX, e.clientY);
		},
		[updateFromClientPoint],
	);

	const endDrag = useCallback(() => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		onControlPointCommit?.();
	}, [onControlPointCommit]);

	const controlX = region.controlPoint.cx * 100;
	const controlY = region.controlPoint.cy * 100;
	const shapeable = region.segmentKind === "move" && region.preset !== "recorded";

	return (
		<div
			ref={hostRef}
			style={{
				position: "absolute",
				inset: 0,
				// The layer is a readout except for the handle itself, which takes its
				// own pointer events back. Swallowing them all would make the preview
				// unclickable behind any selected section.
				pointerEvents: "none",
				zIndex: 4,
			}}
		>
			<svg
				viewBox="0 0 100 100"
				preserveAspectRatio="none"
				style={{ width: "100%", height: "100%", overflow: "visible" }}
				aria-hidden="true"
			>
				{recordedPath.length > 1 ? (
					<polyline
						points={toPolyline(recordedPath)}
						fill="none"
						stroke="#ffffff"
						strokeOpacity={0.45}
						strokeWidth={2}
						strokeDasharray="5 4"
						strokeLinecap="round"
						vectorEffect="non-scaling-stroke"
					/>
				) : null}
				{editedPath.length > 1 ? (
					<>
						{/* Drawn twice: a dark casing under the bright line, so the path stays
						    readable over pale footage as well as dark. */}
						<polyline
							points={toPolyline(editedPath)}
							fill="none"
							stroke="#0f172a"
							strokeOpacity={0.55}
							strokeWidth={5}
							strokeLinecap="round"
							strokeLinejoin="round"
							vectorEffect="non-scaling-stroke"
						/>
						<polyline
							points={toPolyline(editedPath)}
							fill="none"
							stroke="#22d3ee"
							strokeWidth={2.5}
							strokeLinecap="round"
							strokeLinejoin="round"
							vectorEffect="non-scaling-stroke"
						/>
					</>
				) : null}
				{shapeable ? (
					<line
						x1={((region.startPoint.cx + region.endPoint.cx) / 2) * 100}
						y1={((region.startPoint.cy + region.endPoint.cy) / 2) * 100}
						x2={controlX}
						y2={controlY}
						stroke="#22d3ee"
						strokeOpacity={0.5}
						strokeWidth={1.5}
						strokeDasharray="3 3"
						vectorEffect="non-scaling-stroke"
					/>
				) : null}
				<AnchorMarker point={region.startPoint} kind={region.startAnchor} />
				<AnchorMarker point={region.endPoint} kind={region.endAnchor} />
			</svg>
			{shapeable ? (
				// The handle is a DOM node, not an SVG circle: the overlay stretches with
				// `preserveAspectRatio="none"`, which would squash a circle into an
				// ellipse on any non-square stage, and a grab target should not change
				// shape with the aspect ratio of the footage.
				<div
					role="slider"
					tabIndex={0}
					aria-label="Cursor path control point"
					aria-valuenow={Math.round(region.controlPoint.cx * 100)}
					aria-valuemin={0}
					aria-valuemax={100}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
					style={{
						position: "absolute",
						left: `${controlX}%`,
						top: `${controlY}%`,
						width: 18,
						height: 18,
						marginLeft: -9,
						marginTop: -9,
						borderRadius: "50%",
						background: "#22d3ee",
						border: "3px solid #ffffff",
						boxShadow: "0 1px 6px rgba(0,0,0,0.45)",
						cursor: "grab",
						pointerEvents: "auto",
						touchAction: "none",
					}}
				/>
			) : null}
		</div>
	);
}
