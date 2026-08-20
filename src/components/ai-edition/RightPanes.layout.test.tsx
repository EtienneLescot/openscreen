// @vitest-environment jsdom
// The layout preset is a global setting but the camera is per clip, so a project can
// hold no camera at all (#248). These pin what the pane shows in that case: the
// controls go dead, the preset reads "No Webcam", and — the part that is easy to break —
// the saved preference is left untouched on disk and the help popover says so.

import "@testing-library/jest-dom";
import { cleanup, render, screen, within } from "@testing-library/react";
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

		const preset = screen.getByRole("combobox", { name: "Layout" });
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

		const preset = screen.getByRole("combobox", { name: "Layout" });
		expect(preset).toBeEnabled();
		expect(preset).toHaveValue("picture-in-picture");
		expect(screen.getByText("Camera Shape")).toBeInTheDocument();
		expect(screen.getByText("Shrink on Zoom")).toBeInTheDocument();
		expect(screen.getByText("Webcam Size")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Rounded" })).toBeEnabled();
		expect(screen.getByRole("slider")).toBeEnabled();

		// The camera-less hint must not leak into the normal case.
		await user.click(screen.getByRole("button", { name: "Help" }));
		expect(screen.getByRole("note")).not.toHaveTextContent(/saved layout is kept/i);
	});
});
