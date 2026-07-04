// Shared camera-track resolution (P4 — per-asset media links). A project can
// hold multiple assets, each carrying its own (or no) `cameraTrack`. These
// helpers resolve which camera, if any, applies at a given point on the
// timeline, and whether the timeline has ANY camera at all — used to gate
// camera-only preview chrome and settings controls.

import type { AxcutAsset, AxcutCameraTrack, AxcutClip } from "../schema";
import { locateVirtualPosition } from "./virtual-preview";

export function resolveActiveCameraTrack(
	assets: AxcutAsset[],
	clips: AxcutClip[],
	currentTimeSec: number,
): AxcutCameraTrack | null {
	const position = locateVirtualPosition(clips, currentTimeSec);
	if (!position) return null;
	const activeAsset = assets.find((a) => a.id === position.clip.assetId);
	return activeAsset?.cameraTrack ?? null;
}

/** True when at least one clip currently on the timeline has an asset with a camera attached. */
export function hasAnyClipWithCamera(assets: AxcutAsset[], clips: AxcutClip[]): boolean {
	return clips.some((clip) => assets.find((a) => a.id === clip.assetId)?.cameraTrack != null);
}
