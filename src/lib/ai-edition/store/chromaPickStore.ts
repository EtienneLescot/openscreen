/**
 * "The chroma-key eyedropper is armed" — a one-boolean store.
 *
 * The button that arms it lives in the Layout pane (`RightPanes.tsx`) and the
 * surface that consumes the click lives in the preview (`PreviewCanvas.tsx`).
 * They are siblings under the editor shell with no shared owner between them,
 * and threading a boolean plus two callbacks through that shell would put
 * transient UI state into the document-facing prop chain.
 *
 * Same shape as `src/native/nativeCompositorStore.ts` (module-level value +
 * listener set + `useSyncExternalStore`), which solves the same problem for the
 * native view id. Deliberately NOT in the project store: this is not document
 * state, it must not survive a reload, and it must never mark the project dirty.
 */

import { useSyncExternalStore } from "react";

let picking = false;
const listeners = new Set<() => void>();

function emit(): void {
	for (const l of listeners) l();
}

/** Arm the eyedropper. The preview reveals the raw camera and takes the next click. */
export function startChromaPick(): void {
	if (picking) return;
	picking = true;
	emit();
}

/** Disarm — after a successful pick, on Escape, or when the pane unmounts. */
export function stopChromaPick(): void {
	if (!picking) return;
	picking = false;
	emit();
}

export function isChromaPicking(): boolean {
	return picking;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useChromaPicking(): boolean {
	return useSyncExternalStore(subscribe, isChromaPicking, () => false);
}
