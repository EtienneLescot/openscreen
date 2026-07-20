/**
 * Cache of real webcam dimensions per `sourcePath`, populated by the live webcam <video>'s
 * loadedmetadata event and consumed by `PreviewCanvas` (to shape its overlay box) and by
 * `NativeCompositorOverlay` (to shape the rect it ships to the native compositor in the scene
 * description).
 *
 * Why this exists: the composite layout's webcam rect is sized for the ASSUMED webcam aspect.
 * If we ship a 4:3 box and the real camera is 16:9, the Rust side's `fit_cam_aspect` closure
 * shrinks the 16:9 content to fit the 4:3 box, leaving visible empty margin inside the PiP
 * container. Probing the real webcam dims once at mountedmetadata time and threading them into
 * the layout call lets TS shape the box for the REAL aspect from the start, so the container
 * and the camera content agree.
 *
 * Tiny pub/sub (consistent with `nativeCompositorStore`) so callers can re-render when the
 * probe result arrives (the first push to native happens before loadedmetadata fires; the probe
 * triggers a re-push with the correct dimensions).
 */
type Size = { width: number; height: number };

const sizes = new Map<string, Size>();
const listeners = new Set<() => void>();
/** Monotonic counter — bumped on every cache mutation. Lets `useSyncExternalStore`
 *  produce a fresh snapshot on each push without diffing the whole map (which would
 *  re-fire the React effect regardless). */
let revision = 0;

function notify(): void {
	revision += 1;
	for (const l of listeners) l();
}

/** Record the webcam dimensions observed for `sourcePath`. `null` removes any prior entry. */
export function setWebcamNativeSize(sourcePath: string, size: Size | null): void {
	if (size && size.width > 0 && size.height > 0) {
		const prev = sizes.get(sourcePath);
		if (prev && prev.width === size.width && prev.height === size.height) {
			return;
		}
		sizes.set(sourcePath, size);
		notify();
		return;
	}
	if (sizes.delete(sourcePath)) {
		notify();
	}
}

/** Real webcam dimensions for `sourcePath`, or null if not yet probed / unsupported file. */
export function getWebcamNativeSize(sourcePath: string): Size | null {
	return sizes.get(sourcePath) ?? null;
}

/** Monotonic revision counter — useful for `useSyncExternalStore` snapshots. */
export function getWebcamNativeSizeRevision(): number {
	return revision;
}

/** Clear the entire cache (used by tests, or when the document is unloaded). */
export function clearWebcamNativeSizeCache(): void {
	if (sizes.size === 0) return;
	sizes.clear();
	notify();
}

/** Subscribe to any cache mutation. Returns an unsubscribe function. */
export function subscribeWebcamNativeSize(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
