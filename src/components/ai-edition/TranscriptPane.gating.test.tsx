// @vitest-environment jsdom
// The transcript pane's empty state is what a user meets before any transcript
// exists — and, since transcription now runs by itself in the background, it is
// also where they wait for one. These assertions pin the three answers it has
// to give: "it's coming", "here's the button", and "this media has no audio, so
// there is nothing to press".

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutAsset, AxcutClip } from "@/lib/ai-edition/schema";
import type { TranscriptGateReason } from "@/lib/ai-edition/transcription/status";
import { TranscriptPane } from "./RightPanes";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "recording.mp4",
	originalPath: "/rec.mp4",
	durationSec: 12,
	cameraTrack: null,
};

const CLIPS: AxcutClip[] = [
	{
		id: "clip_1",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 12,
		timelineStartSec: 0,
		timelineEndSec: 12,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

function renderPane(
	overrides: {
		isTranscribing?: boolean;
		blocked?: { reason: TranscriptGateReason; message?: string };
	} = {},
) {
	return render(
		<I18nProvider>
			<TranscriptPane
				clips={CLIPS}
				transcripts={[]}
				assets={[ASSET]}
				trimRanges={[]}
				busyAssetIds={[]}
				onSeek={vi.fn()}
				onAddTrimRange={vi.fn()}
				onRemoveTrimRange={vi.fn()}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={overrides.isTranscribing ?? false}
				blocked={overrides.blocked}
			/>
		</I18nProvider>,
	);
}

afterEach(() => {
	cleanup();
});

describe("transcript pane gating", () => {
	it("offers the button while nothing has been attempted", () => {
		renderPane();
		expect(screen.getByRole("button", { name: "Transcribe now" })).toBeEnabled();
	});

	it("shows the background run in progress instead of an idle button", () => {
		renderPane({ isTranscribing: true });
		const button = screen.getByRole("button", { name: "Transcribing…" });
		expect(button).toBeDisabled();
	});

	it("disables the button when the timeline's media have no audio track, and says why", () => {
		renderPane({ blocked: { reason: "no-audio" } });
		expect(screen.getByRole("button", { name: "Transcribe now" })).toBeDisabled();
		expect(screen.getByText("This media has no audio track")).toBeInTheDocument();
	});

	it("keeps the retry available after a transient failure, and surfaces the engine message", () => {
		renderPane({ blocked: { reason: "failed", message: "whisper-server exited" } });
		expect(screen.getByRole("button", { name: "Transcribe now" })).toBeEnabled();
		expect(screen.getByText("whisper-server exited")).toBeInTheDocument();
	});
});
