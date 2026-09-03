// @vitest-environment jsdom
// Issue #560: the transcript tab reads ONE lane, and which one is the user's
// choice. These pin the two halves of that: the switch only exists when there is
// somewhere to switch to, and choosing actually changes what the tab is reading —
// not what it is showing of the same thing.

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type {
	AxcutAsset,
	AxcutAudioTrack,
	AxcutClip,
	AxcutTranscript,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { TranscriptPane } from "./RightPanes";

vi.mock("@/native", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ASSETS: AxcutAsset[] = [
	{
		id: "asset_rec",
		kind: "video",
		label: "recording.mp4",
		originalPath: "/rec.mp4",
		durationSec: 12,
		cameraTrack: null,
	},
	{
		id: "asset_vo",
		kind: "audio",
		label: "voiceover.mp3",
		originalPath: "/vo.mp3",
		durationSec: 30,
		cameraTrack: null,
	},
];

const CLIPS: AxcutClip[] = [
	{
		id: "clip_1",
		assetId: "asset_rec",
		sourceStartSec: 0,
		sourceEndSec: 12,
		timelineStartSec: 0,
		timelineEndSec: 12,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

function words(...texts: string[]) {
	return texts.map((text, i) => ({
		id: `w${i}`,
		segmentId: "s",
		text,
		startSec: i * 0.5,
		endSec: i * 0.5 + 0.4,
	}));
}

const TRANSCRIPTS = [
	{ assetId: "asset_rec", language: "en", words: words("filmed", "words"), segments: [] },
	{ assetId: "asset_vo", language: "en", words: words("narrated", "words"), segments: [] },
] as unknown as AxcutTranscript[];

const VOICEOVER: AxcutAudioTrack = {
	id: "track_1",
	startMs: 0,
	endMs: 4000,
	clipId: "clip_1",
	sourceStartSec: 0,
	sourceEndSec: 4,
	assetId: "asset_vo",
	kind: "voiceover",
	durationSec: 30,
	offsetMs: 0,
	gainDb: 0,
	loop: false,
	fadeInMs: 0,
	fadeOutMs: 0,
	muted: false,
	label: "",
	origin: "user",
} as unknown as AxcutAudioTrack;

function mount(audioTracks: AxcutAudioTrack[]) {
	// The lane lives in the DOCUMENT now (issue #560), so the switch needs one to write
	// to — it is no longer a piece of component state that answers on its own.
	useProjectStore.setState({
		projectId: "proj_1",
		document: {
			schemaVersion: 7,
			project: {
				id: "proj_1",
				title: "T",
				createdAt: "2026-06-25T10:00:00.000Z",
				updatedAt: "2026-06-25T10:00:00.000Z",
				primaryAssetId: "asset_rec",
			},
			assets: ASSETS,
			transcript: null,
			transcripts: TRANSCRIPTS,
			timeline: {
				clips: CLIPS,
				gaps: [],
				trimRanges: [],
				muteRanges: [],
				speedRanges: [],
				captionRanges: [],
			},
			annotations: [],
			zoomRanges: [],
			audioTracks,
			legacyEditor: null,
			// biome-ignore lint/suspicious/noExplicitAny: fixture, not a schema exercise
		} as any,
		status: "ready",
		error: null,
		dirty: false,
	});
	render(
		<I18nProvider>
			<TranscriptPane
				clips={CLIPS}
				audioTracks={audioTracks}
				transcripts={TRANSCRIPTS}
				assets={ASSETS}
				trimRanges={[]}
				busyAssetIds={[]}
				onSeek={vi.fn()}
				onTrimTimelineSpan={vi.fn()}
				onRemoveTrimRanges={vi.fn()}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={false}
			/>
		</I18nProvider>,
	);
}

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});

describe("transcript lane switch", () => {
	it("stays out of the way when there is no voiceover to switch to", () => {
		mount([]);
		expect(screen.queryByRole("group", { name: "Read the transcript from" })).toBeNull();
		expect(screen.getByText("filmed", { exact: false })).toBeInTheDocument();
	});

	it("appears once a voiceover is on the timeline, reading the recording first", () => {
		mount([VOICEOVER]);
		expect(screen.getByRole("group", { name: "Read the transcript from" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Recording" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByText("filmed", { exact: false })).toBeInTheDocument();
	});

	it("reads the voiceover's own words once chosen", async () => {
		const user = userEvent.setup();
		mount([VOICEOVER]);
		await user.click(screen.getByRole("button", { name: "Voice-over" }));
		expect(await screen.findByText("narrated", { exact: false })).toBeInTheDocument();
		// The recording is not filtered out of a shared view — it is not what the tab
		// is reading any more.
		expect(screen.queryByText("filmed", { exact: false })).toBeNull();
	});

	it("ignores music, which is never transcribed", () => {
		mount([{ ...VOICEOVER, kind: "music" } as AxcutAudioTrack]);
		expect(screen.queryByRole("group", { name: "Read the transcript from" })).toBeNull();
	});
});
