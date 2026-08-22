// @vitest-environment jsdom
// The placement sliders take their bounds from `captionOffsetRange`, the same
// function the geometry clamps with. That shared range is the fix for the dead
// travel in #396 — the vertical slider used to advertise ±45 while the bottom
// anchor could only honour −45…+3 — so what these tests pin is the agreement
// between what the slider offers and what the band can do, not any one number.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import {
	captionBandRect,
	captionInkHeightPct,
	captionOffsetRange,
	DEFAULT_CAPTION_SETTINGS,
	getCaptionSettings,
} from "@/lib/ai-edition/captions";
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
	it("offers both axes", () => {
		show({});
		expect(sliderFor("Vertical position")).toBeInTheDocument();
		expect(sliderFor("Horizontal position")).toBeInTheDocument();
	});

	it.each([
		"top",
		"middle",
		"bottom",
	] as const)("bounds the %s anchor's slider by what the band can actually reach", (verticalPosition) => {
		const settings = show({ verticalPosition });
		const range = captionOffsetRange(settings);
		const slider = sliderFor("Vertical position");
		expect(Number(slider.min)).toBeCloseTo(range.y.min, 6);
		expect(Number(slider.max)).toBeCloseTo(range.y.max, 6);
	});

	it("puts both ends of the range on a step, so the edges stay reachable", () => {
		// A fixed step of 1 would leave `max` off-grid for these fractional bounds and
		// the caption would stop just short of the frame edge — the #396 complaint.
		const settings = show({ verticalPosition: "bottom" });
		const slider = sliderFor("Vertical position");
		const [min, max, step] = [slider.min, slider.max, slider.step].map(Number);
		const steps = (max - min) / step;
		expect(steps).toBeCloseTo(Math.round(steps), 6);

		// And landing on `max` really does put the ink on the frame's bottom edge —
		// with the empty part of the band hanging off it, which is what buys the reach.
		const band = captionBandRect({ ...settings, offsetY: max });
		expect(band.y + band.height / 2 + captionInkHeightPct(settings) / 2).toBeCloseTo(100, 6);
		expect(band.y + band.height).toBeGreaterThan(100);
	});

	it("disables the horizontal slider only when the band fills the frame", () => {
		show({ width: 100 });
		expect(sliderFor("Horizontal position")).toBeDisabled();
		cleanup();
		show({ width: DEFAULT_CAPTION_SETTINGS.width });
		expect(sliderFor("Horizontal position")).toBeEnabled();
	});
});

describe("caption position presets", () => {
	const preset = (label: string) => screen.getByRole("button", { name: label });

	it("shows the default settings' presets pressed: Bottom and Position center", () => {
		show({});
		expect(preset("Bottom")).toHaveAttribute("aria-pressed", "true");
		expect(preset("Top")).toHaveAttribute("aria-pressed", "false");
		expect(preset("Position center")).toHaveAttribute("aria-pressed", "true");
		expect(preset("Position left")).toHaveAttribute("aria-pressed", "false");
	});

	it("clicking a vertical preset resets the vertical slider and lights that preset up", () => {
		show({ verticalPosition: "bottom", offsetY: -20 });
		expect(preset("Bottom")).toHaveAttribute("aria-pressed", "false");

		fireEvent.click(preset("Top"));

		expect(sliderFor("Vertical position")).toHaveValue("0");
		expect(preset("Top")).toHaveAttribute("aria-pressed", "true");
		expect(preset("Bottom")).toHaveAttribute("aria-pressed", "false");
	});

	it("dragging the vertical slider clears every vertical preset's pressed state", () => {
		show({});
		expect(preset("Bottom")).toHaveAttribute("aria-pressed", "true");

		fireEvent.change(sliderFor("Vertical position"), { target: { value: "-10" } });

		expect(preset("Bottom")).toHaveAttribute("aria-pressed", "false");
		expect(preset("Top")).toHaveAttribute("aria-pressed", "false");
		expect(preset("Middle")).toHaveAttribute("aria-pressed", "false");
	});

	it("clicking Position left/right moves the horizontal slider to the true frame edge", () => {
		const settings = show({});
		const range = captionOffsetRange(settings);

		fireEvent.click(preset("Position left"));
		expect(Number(sliderFor("Horizontal position").value)).toBeCloseTo(range.x.min, 6);
		expect(preset("Position left")).toHaveAttribute("aria-pressed", "true");

		fireEvent.click(preset("Position right"));
		expect(Number(sliderFor("Horizontal position").value)).toBeCloseTo(range.x.max, 6);
		expect(preset("Position right")).toHaveAttribute("aria-pressed", "true");
		expect(preset("Position left")).toHaveAttribute("aria-pressed", "false");
	});

	it("dragging the horizontal slider clears the horizontal preset row", () => {
		show({});
		fireEvent.change(sliderFor("Horizontal position"), { target: { value: "3" } });

		expect(preset("Position center")).toHaveAttribute("aria-pressed", "false");
		expect(preset("Position left")).toHaveAttribute("aria-pressed", "false");
		expect(preset("Position right")).toHaveAttribute("aria-pressed", "false");
	});

	it("disables the horizontal preset row exactly when the horizontal slider is disabled", () => {
		show({ width: 100 });
		expect(preset("Position left")).toBeDisabled();
		cleanup();
		show({ width: DEFAULT_CAPTION_SETTINGS.width });
		expect(preset("Position left")).toBeEnabled();
	});

	it("gives the text-align row its own section label, separate from Position", () => {
		show({});
		expect(screen.getByText("Text align")).toBeInTheDocument();
		// The words "Left"/"Center"/"Right" belong to text-align; "Position left" etc.
		// belong to the new row — both must resolve without ambiguity.
		expect(preset("Left")).toBeInTheDocument();
		expect(preset("Position left")).toBeInTheDocument();
	});
});
