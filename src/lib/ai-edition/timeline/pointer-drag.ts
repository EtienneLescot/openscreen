import type { PointerEvent as ReactPointerEvent } from "react";

// End reason for a global pointer drag — drives cleanup branching in
// callers (some want to commit on pointerup, others want to discard on
// cancel).
export type PointerDragEndReason =
	| "pointerup"
	| "pointercancel"
	| "window-blur"
	| "document-hidden";

interface PointerDragOptions {
	onMove: (event: PointerEvent) => void;
	onEnd: (reason: PointerDragEndReason, event?: PointerEvent) => void;
}

// Single primitive for every drag-style interaction on the timeline
// (resize skip, reorder clip, scrub, pan, navigator handle). Wraps the
// React PointerEvent in window-level capture so the drag survives the
// pointer leaving the original element.
//
// Source of truth: axcut/apps/web/src/lib/pointer-drag.ts. Behaviors:
//   • sets pointer capture on the source element
//   • installs capture-phase listeners on window for move / up / cancel /
//     out / blur and on document for visibilitychange
//   • early-ends when buttons drop to 0 (some platforms fire pointermove
//     without buttons)
//   • early-ends on window blur or document-hidden (no stuck state)
//   • ignores pointer events for other pointerIds (multi-touch safety)
//
// Returns a cancel function for callers that want to abort (rare).
export function startGlobalPointerDrag(
	event: ReactPointerEvent<HTMLElement>,
	options: PointerDragOptions,
): () => void {
	const target = event.currentTarget;
	const pointerId = event.pointerId;
	let ended = false;

	const cleanup = (reason: PointerDragEndReason, pointerEvent?: PointerEvent) => {
		if (ended) return;
		ended = true;
		globalThis.window.removeEventListener("pointermove", handleMove, true);
		globalThis.window.removeEventListener("pointerup", handlePointerUp, true);
		globalThis.window.removeEventListener("pointercancel", handlePointerCancel, true);
		globalThis.window.removeEventListener("pointerout", handlePointerOut, true);
		globalThis.window.removeEventListener("mouseout", handleMouseOut, true);
		globalThis.window.removeEventListener("blur", handleWindowBlur, true);
		globalThis.document.removeEventListener("visibilitychange", handleVisibilityChange, true);
		try {
			if (target.hasPointerCapture(pointerId)) {
				target.releasePointerCapture(pointerId);
			}
		} catch {
			// Some browsers can throw if the pointer was already implicitly released.
		}
		options.onEnd(reason, pointerEvent);
	};

	const handleMove = (pointerEvent: PointerEvent) => {
		if (pointerEvent.pointerId !== pointerId) return;
		if (pointerEvent.buttons === 0) {
			cleanup("pointerup", pointerEvent);
			return;
		}
		options.onMove(pointerEvent);
	};

	const handlePointerUp = (pointerEvent: PointerEvent) => {
		if (pointerEvent.pointerId !== pointerId) return;
		cleanup("pointerup", pointerEvent);
	};

	const handlePointerCancel = (pointerEvent: PointerEvent) => {
		if (pointerEvent.pointerId !== pointerId) return;
		cleanup("pointercancel", pointerEvent);
	};

	const handlePointerOut = (pointerEvent: PointerEvent) => {
		if (pointerEvent.pointerId === pointerId && pointerEvent.relatedTarget === null) {
			cleanup("pointercancel", pointerEvent);
		}
	};
	const handleMouseOut = (mouseEvent: MouseEvent) => {
		if (mouseEvent.relatedTarget === null) {
			cleanup("pointercancel");
		}
	};
	const handleWindowBlur = () => cleanup("window-blur");
	const handleVisibilityChange = () => {
		if (globalThis.document.visibilityState === "hidden") {
			cleanup("document-hidden");
		}
	};

	try {
		target.setPointerCapture(pointerId);
	} catch {
		// Window-level listeners below still provide a fallback for older/edge cases.
	}
	globalThis.window.addEventListener("pointermove", handleMove, true);
	globalThis.window.addEventListener("pointerup", handlePointerUp, true);
	globalThis.window.addEventListener("pointercancel", handlePointerCancel, true);
	globalThis.window.addEventListener("pointerout", handlePointerOut, true);
	globalThis.window.addEventListener("mouseout", handleMouseOut, true);
	globalThis.window.addEventListener("blur", handleWindowBlur, true);
	globalThis.document.addEventListener("visibilitychange", handleVisibilityChange, true);

	return () => cleanup("pointercancel");
}
