// @vitest-environment jsdom
// The placement controls after the anchor redesign. What these pin is the property
// the previous UI could not hold: every control names the edge it measures from, and
// nothing it can produce is a signed number or a dead affordance.
//
// The pane it replaced had four controls that overlapped — a band width nothing drew,
// an offset measured against that invisible band, and a text alignment fighting the
// offset for the same visual outcome — so the tests here are as much about what is
// ABSENT as about what is present.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { getCaptionSettings } from "@/lib/ai-edition/captions";
import type { AxcutAsset, AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useTranscriptionStore } from "@/lib/ai-edition/store/transcriptionStore";
import { CaptionsPane } from "./CaptionsPane";

vi.mock("@/native", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
		legacyEditor: { captions: { enabled: true, ...captions } },
	} as unknown as AxcutDocument;
}

/** The `<input type="range">` sitting under a given slider label. */
function sliderFor(label: string): HTMLInputElement {
	const cell = screen.getByText(label).closest("div")?.parentElement;
	const input = cell?.querySelector("input[type=range]");
	if (!(input instanceof HTMLInputElement)) throw new Error(`no slider for "${label}"`);
	return input;
}

const button = (name: string) => screen.getByRole("button", { name });

function show(captions: Record<string, unknown>) {
	const document = documentWith(captions);
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		status: "ready",
		error: null,
		dirty: false,
	});
	render(
		<I18nProvider>
			<CaptionsPane />
		</I18nProvider>,
	);
	return getCaptionSettings(document);
}

beforeEach(() => {
	useTranscriptionStore.getState().reset();
	useProjectStore.getState().clear();
});

afterEach(() => {
	cleanup();
});

describe("caption placement controls", () => {
	it("offers one anchor and one distance per axis", () => {
		show({});
		expect(button("Bottom")).toHaveAttribute("aria-pressed", "true");
		expect(button("Top")).toHaveAttribute("aria-pressed", "false");
		expect(button("Center")).toHaveAttribute("aria-pressed", "true");
		expect(sliderFor("Distance from bottom")).toBeInTheDocument();
	});

	it("names the edge the distance is measured from, and follows the anchor", () => {
		// The old label said "Vertical offset" and the value could read "-7.3%", which
		// corresponds to nothing in any subtitle format and to nothing a user can see.
		show({ anchorV: "bottom" });
		expect(screen.getByText("Distance from bottom")).toBeInTheDocument();
		expect(screen.queryByText("Distance from top")).not.toBeInTheDocument();

		fireEvent.click(button("Top"));
		expect(screen.getByText("Distance from top")).toBeInTheDocument();
		expect(screen.queryByText("Distance from bottom")).not.toBeInTheDocument();
	});

	it("never offers a negative distance", () => {
		show({});
		expect(Number(sliderFor("Distance from bottom").min)).toBe(0);
		fireEvent.click(button("Left"));
		expect(Number(sliderFor("Distance from left").min)).toBe(0);
	});

	it("keeps the distance when the anchor flips, mirroring to the opposite edge", () => {
		// The inset means the same thing on both anchors, so there is nothing to reset —
		// unlike the old presets, which had to zero an offset that meant something else.
		show({ anchorV: "bottom", insetY: 12 });
		fireEvent.click(button("Top"));
		expect(sliderFor("Distance from top")).toHaveValue("12");
	});

	it("hides the horizontal distance when centred instead of disabling it", () => {
		// A centred block has no edge to measure from. A dead slider reads as a bug, so
		// the control is absent rather than greyed out.
		show({ anchorH: "center" });
		expect(screen.queryByText("Distance from left")).not.toBeInTheDocument();
		expect(screen.queryByText("Distance from right")).not.toBeInTheDocument();

		fireEvent.click(button("Right"));
		expect(sliderFor("Distance from right")).toBeEnabled();
	});

	it("leaves no control disabled once a document is open", () => {
		show({});
		for (const name of ["Bottom", "Top", "Left", "Center", "Right"]) {
			expect(button(name)).toBeEnabled();
		}
		expect(sliderFor("Distance from bottom")).toBeEnabled();
	});

	it("writes the anchor and the inset straight through to the document", () => {
		show({});
		fireEvent.click(button("Top"));
		fireEvent.change(sliderFor("Distance from top"), { target: { value: "18.5" } });

		const stored = useProjectStore.getState().document as AxcutDocument;
		expect(getCaptionSettings(stored)).toMatchObject({ anchorV: "top", insetY: 18.5 });
	});

	it("no longer offers the controls the redesign removed", () => {
		// Band width drew nothing until the text happened to wrap; the separate text
		// alignment fought the horizontal position for the same outcome.
		show({});
		expect(screen.queryByText("Width")).not.toBeInTheDocument();
		expect(screen.queryByText("Text align")).not.toBeInTheDocument();
		expect(screen.queryByText("Vertical offset")).not.toBeInTheDocument();
		expect(screen.queryByText("Horizontal offset")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Middle" })).not.toBeInTheDocument();
	});

	it("explains which way a long caption grows", () => {
		show({ anchorV: "bottom" });
		expect(screen.getByText(/grow upward/i)).toBeInTheDocument();
		fireEvent.click(button("Top"));
		expect(screen.getByText(/grow downward/i)).toBeInTheDocument();
	});
});

describe("migrating a pre-anchor project into the pane", () => {
	it("opens an old document on the anchor that reproduces where it was drawn", () => {
		// A default bottom caption from the old model: band at 75%, ink centred in it,
		// drawn block ending at 92.67% — so a 7.33% inset from the bottom.
		show({ verticalPosition: "bottom", offsetY: 0, width: 80, textAlign: "center" });
		expect(button("Bottom")).toHaveAttribute("aria-pressed", "true");
		// The migrated value is the real distance, not a value snapped to the slider's
		// step — the step governs dragging, not what a document may already hold.
		expect(Number(sliderFor("Distance from bottom").value)).toBeCloseTo(7.333, 2);
	});
});
