import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutClip } from "../schema";
import { hasAnyClipWithCamera, resolveActiveCameraTrack } from "./camera";

const assetWithCamera: AxcutAsset = {
	id: "asset_with_camera",
	kind: "video",
	label: "a1",
	originalPath: "/screen-1.mp4",
	cameraTrack: { sourcePath: "/cam-1.mp4", startMs: 0, offsetMs: 0, visible: true },
};

const assetWithHiddenCamera: AxcutAsset = {
	id: "asset_hidden_camera",
	kind: "video",
	label: "a3",
	originalPath: "/screen-3.mp4",
	cameraTrack: { sourcePath: "/cam-3.mp4", startMs: 0, offsetMs: 0, visible: false },
};

const assetWithoutCamera: AxcutAsset = {
	id: "asset_without_camera",
	kind: "video",
	label: "a2",
	originalPath: "/screen-2.mp4",
	cameraTrack: null,
};

const clipWithCamera: AxcutClip = {
	id: "clip_1",
	assetId: "asset_with_camera",
	sourceStartSec: 0,
	sourceEndSec: 5,
	timelineStartSec: 0,
	timelineEndSec: 5,
	wordRefs: [],
	origin: "system",
	reason: "",
};

const clipWithoutCamera: AxcutClip = {
	id: "clip_2",
	assetId: "asset_without_camera",
	sourceStartSec: 0,
	sourceEndSec: 5,
	timelineStartSec: 5,
	timelineEndSec: 10,
	wordRefs: [],
	origin: "system",
	reason: "",
};

describe("resolveActiveCameraTrack", () => {
	it("returns the camera of the asset backing the clip under the playhead", () => {
		const track = resolveActiveCameraTrack(
			[assetWithCamera, assetWithoutCamera],
			[clipWithCamera, clipWithoutCamera],
			2,
		);
		expect(track?.sourcePath).toBe("/cam-1.mp4");
	});

	it("returns null when the active clip's asset has no camera", () => {
		const track = resolveActiveCameraTrack(
			[assetWithCamera, assetWithoutCamera],
			[clipWithCamera, clipWithoutCamera],
			7,
		);
		expect(track).toBeNull();
	});

	it("returns null when there are no clips", () => {
		expect(resolveActiveCameraTrack([assetWithCamera], [], 0)).toBeNull();
	});

	it("returns null when the active clip references an unknown asset", () => {
		const orphanClip: AxcutClip = { ...clipWithCamera, assetId: "missing" };
		expect(resolveActiveCameraTrack([assetWithCamera], [orphanClip], 2)).toBeNull();
	});
});

describe("hasAnyClipWithCamera", () => {
	it("is true when at least one clip's asset has a camera, even if hidden (visible:false)", () => {
		const hiddenClip: AxcutClip = { ...clipWithoutCamera, assetId: "asset_hidden_camera" };
		expect(
			hasAnyClipWithCamera(
				[assetWithHiddenCamera, assetWithoutCamera],
				[hiddenClip, clipWithoutCamera],
			),
		).toBe(true);
	});

	it("is true when at least one clip's asset has a camera", () => {
		expect(
			hasAnyClipWithCamera(
				[assetWithCamera, assetWithoutCamera],
				[clipWithCamera, clipWithoutCamera],
			),
		).toBe(true);
	});

	it("is false when no clip's asset has a camera", () => {
		expect(hasAnyClipWithCamera([assetWithoutCamera], [clipWithoutCamera])).toBe(false);
	});

	it("is false when there are no clips, even if an unused asset has a camera", () => {
		expect(hasAnyClipWithCamera([assetWithCamera], [])).toBe(false);
	});

	it("is false for an empty project", () => {
		expect(hasAnyClipWithCamera([], [])).toBe(false);
	});
});
