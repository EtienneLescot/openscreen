// @vitest-environment jsdom
// The layout preset is a global setting but the camera is per clip, so a project can
// hold no camera at all (#248). These pin what the pane shows in that case: the
// controls go dead, the preset reads "No Webcam", and — the part that is easy to break —
// the saved preference is left untouched on disk and the help popover says so.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { LayoutPane } from "./RightPanes";

function seedProject(hasCamera: boolean): AxcutDocument {
	const base = createEmptyDocument({ projectId: "project_layout", title: "Layout" });
	return {
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.webm",
				originalPath: "/tmp/screen.webm",
				durationSec: 10,
				video: { codec: "unknown", width: 1920, height: 1080, fps: 30 },
				cameraTrack: hasCamera
					? { sourcePath: "/tmp/camera.webm", startMs: 0, offsetMs: 0, visible: true }
					: null,
			},
		],
		project: { ...base.project, primaryAssetId: "asset_1" },
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "test",
				},
			],
		},
		legacyEditor: { webcamLayoutPreset: "picture-in-picture" },
	};
}

// `doc` rather than `document`: this is a jsdom file, and shadowing the global would
// silently redirect any `document.querySelector` a later test adds.
function renderLayout(doc: AxcutDocument) {
	useProjectStore.setState({
		projectId: doc.project.id,
		document: doc,
		revision: 1,
		status: "ready",
	});
	return render(
		<I18nProvider>
			<LayoutPane />
		</I18nProvider>,
	);
}

beforeEach(() => {
	// The assertions below are on English copy; without pinning they would ride on
	// jsdom's implicit en-US and pass vacuously if the fallback ever changed.
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

afterEach(() => {
	cleanup();
	localStorage.clear();
	useProjectStore.getState().clear();
});

describe("LayoutPane camera availability", () => {
	it("shows No webcam without overwriting the saved camera preset", () => {
		renderLayout(seedProject(false));

		const preset = screen.getByRole("combobox", { name: "Preset" });
		expect(preset).toBeDisabled();
		expect(preset).toHaveValue("no-webcam");
		expect(useProjectStore.getState().document?.legacyEditor).toMatchObject({
			webcamLayoutPreset: "picture-in-picture",
		});
		expect(screen.queryByText("Camera Shape")).not.toBeInTheDocument();
		expect(screen.queryByText("Shrink on Zoom")).not.toBeInTheDocument();
		expect(screen.queryByText("Webcam Size")).not.toBeInTheDocument();
		const mirrorRow = screen.getByText("Mirror Webcam").closest("div");
		expect(mirrorRow).not.toBeNull();
		expect(within(mirrorRow as HTMLElement).getByRole("button")).toBeDisabled();
	});

	it("tells the user the saved preset was kept rather than thrown away", async () => {
		const user = userEvent.setup();
		renderLayout(seedProject(false));

		await user.click(screen.getByRole("button", { name: "Help" }));
		expect(screen.getByRole("note")).toHaveTextContent(/saved layout is kept/i);
	});

	it("keeps the saved preset active when a timeline clip has a camera", async () => {
		const user = userEvent.setup();
		renderLayout(seedProject(true));

		const preset = screen.getByRole("combobox", { name: "Preset" });
		expect(preset).toBeEnabled();
		expect(preset).toHaveValue("picture-in-picture");
		expect(screen.getByText("Camera Shape")).toBeInTheDocument();
		expect(screen.getByText("Shrink on Zoom")).toBeInTheDocument();
		expect(screen.getByText("Webcam Size")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Rounded" })).toBeEnabled();
		// Named, because the pane holds four sliders now — webcam size plus the three
		// webcam-framing ones. This one is the size slider the line above just found.
		expect(screen.getByRole("slider", { name: "Webcam Size" })).toBeEnabled();

		// The camera-less hint must not leak into the normal case.
		await user.click(screen.getByRole("button", { name: "Help" }));
		expect(screen.getByRole("note")).not.toHaveTextContent(/saved layout is kept/i);
	});
});

// #412. The pan used to be read back out of the crop rect, which cannot hold it: at 100%
// zoom the crop IS the frame, so its offset is 0 for every pan the user could have chosen.
// A trip down to 100% therefore erased the framing rather than suspending it.
describe("LayoutPane webcam crop pan", () => {
	const zoom = () => screen.getByRole("slider", { name: "Zoom" });
	const panX = () => screen.getByRole("slider", { name: "Pan horizontally" });
	const panY = () => screen.getByRole("slider", { name: "Pan vertically" });
	const set = (slider: HTMLElement, value: number) =>
		fireEvent.change(slider, { target: { value: String(value) } });
	const storedCrop = () =>
		useProjectStore.getState().document?.legacyEditor as unknown as {
			webcamCropRegion: { x: number; y: number; width: number; height: number };
			webcamCropPan: { x: number; y: number };
		};

	it("keeps the pan across a round trip through 100% zoom", () => {
		renderLayout(seedProject(true));

		set(zoom(), 200);
		set(panX(), 75);
		expect(panX()).toHaveValue("75");

		set(zoom(), 100);
		// Nowhere to pan at full frame, so the control is correctly out of reach...
		expect(panX()).toBeDisabled();

		set(zoom(), 200);
		// ...but the intent survived the trip.
		expect(panX()).toHaveValue("75");
	});

	it("does not move the pan while the zoom slider is dragged", () => {
		// The old clamp squeezed the rect's offset toward the near edge as the window grew,
		// so the pan slider crept upward on its own while the picture stayed put.
		renderLayout(seedProject(true));

		set(zoom(), 200);
		set(panX(), 75);

		for (const pct of [180, 150, 120, 110, 101]) {
			set(zoom(), pct);
			expect(panX()).toHaveValue("75");
		}
	});

	it("wires the vertical slider to the vertical axis", () => {
		// The two sliders differ by one character in the handler they call. Without this,
		// a Y slider wired to "x" would pass every other test in this block.
		renderLayout(seedProject(true));

		set(zoom(), 200);
		set(panY(), 80);

		expect(panY()).toHaveValue("80");
		expect(storedCrop().webcamCropPan.y).toBeCloseTo(0.8);
		expect(storedCrop().webcamCropRegion.y).toBeCloseTo(0.4);
		// ...and it left the horizontal axis alone.
		expect(panX()).toHaveValue("50");
		expect(storedCrop().webcamCropRegion.x).toBeCloseTo(0.25);
	});

	it("puts the crop where the pan says, at any zoom", () => {
		renderLayout(seedProject(true));

		set(zoom(), 200);
		set(panX(), 100);
		// Hard against the right edge: a half-width window starts halfway across.
		let crop = useProjectStore.getState().document?.legacyEditor?.webcamCropRegion as unknown as {
			x: number;
			width: number;
		};
		expect(crop.width).toBeCloseTo(0.5);
		expect(crop.x).toBeCloseTo(0.5);

		set(zoom(), 400);
		// Clamped to the slider's 300% ceiling, so a third of the frame, still hard right.
		crop = useProjectStore.getState().document?.legacyEditor?.webcamCropRegion as unknown as {
			x: number;
			width: number;
		};
		expect(crop.x).toBeCloseTo(1 - crop.width);
	});
});
