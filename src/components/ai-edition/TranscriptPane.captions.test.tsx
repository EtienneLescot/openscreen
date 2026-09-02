// @vitest-environment jsdom
// Issue #560: captions used to be their own inspector tab, next to the transcript
// they are a view OF. Two tabs meant two entry points to the same background pass,
// and the caption one was the only one many people ever found.
//
// So the tab is gone and its pane hangs off the transcript tab instead. What that
// costs is reachability, and that is exactly what these assertions pin: the control
// is present in BOTH of the transcript pane's states — including the empty one,
// where a user with no transcript would otherwise have no way back to caption
// settings at all — and it really does open the pane, not a rebuilt stub of it.

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutAsset, AxcutClip, AxcutTranscript } from "@/lib/ai-edition/schema";
import { TranscriptPane } from "./RightPanes";

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

const TRANSCRIPT: AxcutTranscript = {
	assetId: "asset_1",
	language: "en",
	words: [
		{ id: "w_1", text: "hello", startSec: 0.2, endSec: 0.6 },
		{ id: "w_2", text: "there", startSec: 0.6, endSec: 1.1 },
	],
	segments: [],
} as unknown as AxcutTranscript;

function mount(transcripts: AxcutTranscript[]) {
	return render(
		<I18nProvider>
			<TranscriptPane
				clips={CLIPS}
				audioTracks={[]}
				transcripts={transcripts}
				assets={[ASSET]}
				trimRanges={[]}
				busyAssetIds={[]}
				onSeek={vi.fn()}
				onAddTrimRange={vi.fn()}
				onRemoveTrimRange={vi.fn()}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={false}
			/>
		</I18nProvider>,
	);
}

afterEach(() => {
	cleanup();
});

describe("caption settings on the transcript tab", () => {
	it("is reachable before any transcript exists", () => {
		mount([]);
		expect(screen.getByRole("button", { name: "Captions" })).toBeInTheDocument();
		// The single transcription gate stays where it was: on this pane, not
		// hidden one popover deep.
		expect(screen.getByRole("button", { name: "Transcribe now" })).toBeInTheDocument();
	});

	it("is reachable once there is a transcript to caption", () => {
		mount([TRANSCRIPT]);
		expect(screen.getByRole("button", { name: "Captions" })).toBeInTheDocument();
	});

	it("opens the real caption settings rather than a stub", async () => {
		const user = userEvent.setup();
		mount([TRANSCRIPT]);
		await user.click(screen.getByRole("button", { name: "Captions" }));
		// A control that only the actual CaptionsPane renders — proof the pane was
		// mounted whole rather than reimplemented into the popover.
		expect(await screen.findByText("Show captions")).toBeInTheDocument();
	});
});
