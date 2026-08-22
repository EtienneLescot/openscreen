// @vitest-environment jsdom
// The caption guide is DOM, and the last DOM caption layer was deleted for good
// reason (it painted the same text through a second wrapping engine and the two
// disagreed). What these tests pin is the boundary that makes this one safe: it
// draws no text, it only appears while the pane that explains it is open, and it
// tracks the same geometry function the compositor is handed.

import "@testing-library/jest-dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captionBoxRect, getCaptionSettings } from "@/lib/ai-edition/captions";
import type { AxcutAsset, AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useCaptionGuideBus } from "@/lib/ai-edition/store/useCaptionGuideBus";
import { CaptionGuideOverlay } from "./CaptionGuideOverlay";

vi.mock("@/native", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "recording.mp4",
	originalPath: "/rec.mp4",
	durationSec: 12,
	cameraTrack: null,
};

function documentWith(captions: Record<string, unknown>): AxcutDocument {
	return {
		schemaVersion: 7,
		project: {
			id: "proj_1",
			title: "Test",
			createdAt: "2026-06-25T10:00:00.000Z",
			updatedAt: "2026-06-25T10:00:00.000Z",
			primaryAssetId: ASSET.id,
		},
		assets: [ASSET],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip_1",
					assetId: ASSET.id,
					sourceStartSec: 0,
					sourceEndSec: 12,
					timelineStartSec: 0,
					timelineEndSec: 12,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: { captions },
	} as unknown as AxcutDocument;
}

function show(captions: Record<string, unknown>, open: boolean) {
	const document = documentWith(captions);
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		status: "ready",
		error: null,
		dirty: false,
	});
	useCaptionGuideBus.setState({ open });
	return { document, ...render(<CaptionGuideOverlay />) };
}

beforeEach(() => {
	useProjectStore.getState().clear();
	useCaptionGuideBus.setState({ open: false });
});

afterEach(() => {
	cleanup();
});

describe("caption guide overlay", () => {
	it("draws nothing while the captions pane is closed", () => {
		const { container } = show({ enabled: true }, false);
		expect(container).toBeEmptyDOMElement();
	});

	it("draws nothing when captions are off, even with the pane open", () => {
		const { container } = show({ enabled: false }, true);
		expect(container).toBeEmptyDOMElement();
	});

	it("puts the anchor line exactly where the compositor pins the caption", () => {
		const { container, document } = show({ enabled: true, anchorV: "bottom", insetY: 12 }, true);
		const line = container.querySelector('div[style*="height: 2px"]');
		expect(line).toBeInTheDocument();
		// 100 − insetY: the same number `captionBoxRect` puts the box's bottom edge at,
		// so the guide cannot drift from the thing it is drawing.
		expect((line as HTMLElement).style.top).toBe("88%");

		const box = captionBoxRect(getCaptionSettings(document, 16 / 9), 16 / 9);
		expect(box.y + box.height).toBeCloseTo(88, 6);
	});

	it("follows the anchor to the top edge", () => {
		const { container } = show({ enabled: true, anchorV: "top", insetY: 9 }, true);
		const line = container.querySelector('div[style*="height: 2px"]');
		expect((line as HTMLElement).style.top).toBe("9%");
	});

	it("carries no text — it is a guide, not a second caption painter", () => {
		const { container } = show({ enabled: true }, true);
		expect(container.textContent).toBe("");
		// And it is inert: it must never eat a click meant for the canvas beneath.
		const root = container.firstElementChild as HTMLElement;
		expect(root.style.pointerEvents).toBe("none");
		expect(root).toHaveAttribute("aria-hidden", "true");
	});
});
