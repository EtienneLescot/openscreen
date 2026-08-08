// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
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

function renderLayout(document: AxcutDocument) {
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		revision: 1,
		status: "ready",
	});
	return render(
		<I18nProvider>
			<LayoutPane />
		</I18nProvider>,
	);
}

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});

describe("LayoutPane camera availability", () => {
	it("shows No webcam without overwriting the saved camera preset", () => {
		const document = seedProject(false);
		renderLayout(document);

		const preset = screen.getByRole("combobox");
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

	it("keeps the saved preset active when a timeline clip has a camera", () => {
		renderLayout(seedProject(true));

		const preset = screen.getByRole("combobox");
		expect(preset).toBeEnabled();
		expect(preset).toHaveValue("picture-in-picture");
		expect(screen.getByText("Camera Shape")).toBeInTheDocument();
		expect(screen.getByText("Shrink on Zoom")).toBeInTheDocument();
		expect(screen.getByText("Webcam Size")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Rounded" })).toBeEnabled();
		expect(screen.getByRole("slider")).toBeEnabled();
	});
});
