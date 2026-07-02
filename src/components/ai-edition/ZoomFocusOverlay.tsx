// Draggable rectangle that lets the user reposition a zoom region's focus
// point directly on the preview, mirroring the legacy editor's Pixi overlay
// (`src/components/video-editor/VideoPlayback.tsx` + `videoPlayback/overlayUtils.ts`)
// but as a plain CSS overlay div — the new editor's preview has no Pixi stage.
//
// The rectangle's size reflects the zoom crop window (1/zoomScale of the
// stage), not just a crosshair, so the user sees exactly what will be
// visible once zoomed in.

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useRef } from "react";
import { getZoomScale, type ZoomFocus } from "@/components/video-editor/types";
import { getFocusBoundsForScale } from "@/components/video-editor/videoPlayback/focusUtils";
import type { AxcutZoomRegion } from "@/lib/ai-edition/schema";
import styles from "./ZoomFocusOverlay.module.css";

interface ZoomFocusOverlayProps {
	region: AxcutZoomRegion;
	isPlaying: boolean;
	/** Called on every pointermove while dragging — must be cheap/local-only. */
	onFocusChange: (id: string, focus: ZoomFocus) => void;
	/** Called once on pointer release to persist the final position. */
	onFocusCommit?: () => void;
}

function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

export function ZoomFocusOverlay({
	region,
	isPlaying,
	onFocusChange,
	onFocusCommit,
}: ZoomFocusOverlayProps) {
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const draggingRef = useRef(false);

	const updateFromClientPoint = useCallback(
		(clientX: number, clientY: number) => {
			const el = overlayRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			if (!rect.width || !rect.height) return;

			const zoomScale = getZoomScale(region);
			const bounds = getFocusBoundsForScale(zoomScale);
			const cx = clamp01((clientX - rect.left) / rect.width);
			const cy = clamp01((clientY - rect.top) / rect.height);

			onFocusChange(region.id, {
				cx: Math.min(bounds.maxX, Math.max(bounds.minX, cx)),
				cy: Math.min(bounds.maxY, Math.max(bounds.minY, cy)),
			});
		},
		[region, onFocusChange],
	);

	const handlePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (isPlaying || region.focusMode === "auto") return;
			event.preventDefault();
			draggingRef.current = true;
			event.currentTarget.setPointerCapture(event.pointerId);
			updateFromClientPoint(event.clientX, event.clientY);
		},
		[isPlaying, region.focusMode, updateFromClientPoint],
	);

	const handlePointerMove = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!draggingRef.current) return;
			event.preventDefault();
			updateFromClientPoint(event.clientX, event.clientY);
		},
		[updateFromClientPoint],
	);

	const endDrag = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!draggingRef.current) return;
			draggingRef.current = false;
			try {
				event.currentTarget.releasePointerCapture(event.pointerId);
			} catch {
				// pointer already released
			}
			onFocusCommit?.();
		},
		[onFocusCommit],
	);

	// Auto-follow (cursor-driven) regions have no user-placed focus point.
	if (region.focusMode === "auto") return null;

	const zoomScale = getZoomScale(region);
	const widthPercent = Math.min(100, (1 / zoomScale) * 100);
	const heightPercent = Math.min(100, (1 / zoomScale) * 100);
	const rawLeft = clamp01(region.focus.cx) * 100 - widthPercent / 2;
	const rawTop = clamp01(region.focus.cy) * 100 - heightPercent / 2;
	const left = Math.min(100 - widthPercent, Math.max(0, rawLeft));
	const top = Math.min(100 - heightPercent, Math.max(0, rawTop));

	return (
		<div
			ref={overlayRef}
			className={styles.overlay}
			style={{ pointerEvents: isPlaying ? "none" : "auto", cursor: isPlaying ? "default" : "move" }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={endDrag}
			onPointerLeave={endDrag}
		>
			<div
				className={styles.indicator}
				style={{
					width: `${widthPercent}%`,
					height: `${heightPercent}%`,
					left: `${left}%`,
					top: `${top}%`,
				}}
			/>
		</div>
	);
}
