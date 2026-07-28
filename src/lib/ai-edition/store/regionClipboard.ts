// Per-region copy/paste clipboard. Backed by module-level state so Cmd+C in
// one component can be picked up by Cmd+V in another. Mirrors the legacy
// regionClipboard pattern but keeps it focused on zoom/annotation/speed
// regions (skip is stored in the timeline directly, so it doesn't go through
// this path).

import { useCallback, useEffect, useState } from "react";

export type RegionSnapshot =
	| { kind: "zoom"; region: Record<string, unknown> }
	| { kind: "annotation"; region: Record<string, unknown> }
	| { kind: "speed"; region: Record<string, unknown> }
	| { kind: "cameraFullscreen"; region: Record<string, unknown> };

let clipboard: RegionSnapshot | null = null;
const listeners = new Set<() => void>();
function notify() {
	for (const fn of listeners) fn();
}
export function copyRegion(snap: RegionSnapshot) {
	clipboard = { ...snap };
	notify();
}
export function pasteClipboard(): RegionSnapshot | null {
	return clipboard;
}
export function useRegionClipboard() {
	const [, force] = useState(0);
	useEffect(() => {
		const fn = () => force((n) => n + 1);
		listeners.add(fn);
		return () => {
			listeners.delete(fn);
		};
	}, []);
	return {
		hasContent: clipboard !== null,
		kind: clipboard?.kind ?? null,
		read: () => clipboard,
	};
}

// React-friendly hook for components to use a stable callback reference.
export function useCopyRegion() {
	return useCallback((snap: RegionSnapshot) => copyRegion(snap), []);
}
