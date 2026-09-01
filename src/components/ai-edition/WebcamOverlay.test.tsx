// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { WebcamOverlay } from "./WebcamOverlay";

// P4 regression test: a project can hold multiple assets, each with its own
// (or no) camera link. The overlay must resolve the camera from the ACTIVE
// clip's asset, not a single document-global field — so the PiP appears and
// disappears per clip, not per project.

const CLIP_WITH_CAMERA: AxcutClip = {
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

const CLIP_WITHOUT_CAMERA: AxcutClip = {
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

function makeDocument(): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "proj_test",
			title: "Test",
			createdAt: "2026-06-25T10:00:00.000Z",
			updatedAt: "2026-06-25T10:00:00.000Z",
			primaryAssetId: "asset_with_camera",
		},
		assets: [
			{
				id: "asset_with_camera",
				kind: "video",
				label: "a1",
				originalPath: "/screen-1.mp4",
				cameraTrack: { sourcePath: "/cam-1.mp4", startMs: 0, offsetMs: 0, visible: true },
			},
			{
				id: "asset_without_camera",
				kind: "video",
				label: "a2",
				originalPath: "/screen-2.mp4",
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [CLIP_WITH_CAMERA, CLIP_WITHOUT_CAMERA],
			gaps: [],
			trimRanges: [],
			insertRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	};
}

function baseProps(currentTimeSec: number) {
	return {
		clips: [CLIP_WITH_CAMERA, CLIP_WITHOUT_CAMERA],
		currentTimeSec,
		onTimeChange: () => undefined,
		isPlaying: false,
		borderRadius: 0,
		webcamMaskShape: "rectangle" as const,
		layoutPreset: "picture-in-picture" as const,
	};
}

const baseLegacyEditor = {
	wallpaper: "#000000",
	shadowIntensity: 0,
	borderRadius: 0,
	padding: 0,
	showBlur: false,
	motionBlurAmount: 0,
	webcamSizePreset: 25,
	webcamMaskShape: "rectangle",
	webcamLayoutPreset: "picture-in-picture",
	webcamMirrored: false,
	webcamReactiveZoom: false,
	webcamWallpaper: "#ff0080",
	webcamBlurIntensity: 0.5,
	cursorShow: false,
	cursorSize: 1,
	cursorSmoothing: 0,
	cursorMotionBlur: 0,
	cursorClickBounce: 0,
	cursorTheme: "default",
	cursorClipToBounds: false,
};

describe("WebcamOverlay (per-clip camera resolution)", () => {
	afterEach(() => {
		cleanup();
		useProjectStore.getState().clear();
	});

	it("renders the camera video while the playhead is on a clip whose asset has one", () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: makeDocument(),
			revision: 1,
			status: "ready",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 2,
			dirty: false,
			lastSavedAt: new Date(),
		});

		const { container } = render(<WebcamOverlay {...baseProps(2)} />);
		const video = container.querySelector("video");
		expect(video).toBeTruthy();
		expect(video?.getAttribute("src")).toContain("cam-1.mp4");
	});

	it("renders nothing while the playhead is on a clip whose asset has no camera", () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: makeDocument(),
			revision: 1,
			status: "ready",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 7,
			dirty: false,
			lastSavedAt: new Date(),
		});

		const { container } = render(<WebcamOverlay {...baseProps(7)} />);
		expect(container.querySelector("video")).toBeNull();
	});

	it("re-resolves the camera when the playhead moves from one clip to the other", () => {
		useProjectStore.setState({
			projectId: "proj_test",
			document: makeDocument(),
			revision: 1,
			status: "ready",
			error: null,
			sourceDurationSec: 0,
			currentTimeSec: 2,
			dirty: false,
			lastSavedAt: new Date(),
		});

		const { container, rerender } = render(<WebcamOverlay {...baseProps(2)} />);
		expect(container.querySelector("video")).toBeTruthy();

		rerender(<WebcamOverlay {...baseProps(7)} />);
		expect(container.querySelector("video")).toBeNull();

		rerender(<WebcamOverlay {...baseProps(2)} />);
		expect(container.querySelector("video")).toBeTruthy();
	});

	// The webcam background effect is composited by the native compositor from the scene,
	// not by this component: the mask reaches the shader as a texture. So the overlay renders
	// the same thing whatever the mode — a <video> that exists to drive decode and the
	// playback clock. It used to mount a <canvas> and paint the effect here, which is what
	// made preview and export two different implementations of the same layer.
	it("renders only the video element, whatever the background mode", () => {
		for (const mode of ["none", "blur", "custom", "transparent"] as const) {
			const doc = makeDocument();
			doc.legacyEditor = { ...baseLegacyEditor, webcamBackgroundMode: mode };
			useProjectStore.setState({
				projectId: "proj_test",
				document: doc,
				revision: 1,
				status: "ready",
				error: null,
				sourceDurationSec: 0,
				currentTimeSec: 2,
				dirty: false,
				lastSavedAt: new Date(),
			});

			const { container, unmount } = render(<WebcamOverlay {...baseProps(2)} />);
			expect(container.querySelector("video"), mode).toBeTruthy();
			expect(container.querySelector("canvas"), mode).toBeNull();
			unmount();
		}
	});
});
