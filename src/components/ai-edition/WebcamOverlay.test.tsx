import "@testing-library/jest-dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
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
		schemaVersion: 4,
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
			skipRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
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
});
