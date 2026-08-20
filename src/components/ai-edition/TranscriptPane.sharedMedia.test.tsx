// @vitest-environment jsdom
// The rendered half of the shared-media cue bug. `findCueWordId` returning the right
// answer is not enough on its own: the cue id is compared against every rendered word,
// so while `data-word-id` carried the bare `word.id`, the SAME transcript word projected
// into two clips over one media matched in BOTH blocks and the highlight appeared twice —
// whichever section the resolver had picked. Only a render can catch that, which is why
// these assertions count DOM nodes rather than inspect the resolver's return value.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutAsset, AxcutClip, AxcutTranscript } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { TranscriptPane } from "./RightPanes";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: {} },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "recording.mp4",
	originalPath: "/rec.mp4",
	durationSec: 12,
	cameraTrack: null,
};

// One 12s media placed twice on the ruler — the shape the user reported.
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
	{
		id: "clip_2",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 12,
		timelineStartSec: 12,
		timelineEndSec: 24,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

const TRANSCRIPT: AxcutTranscript = {
	assetId: "asset_1",
	language: "fr",
	segments: [],
	words: [
		{ id: "w1", segmentId: "s", startSec: 0, endSec: 2, text: "Salut" },
		// 4s gap → `withSilenceGaps` mints a `silence_1` in EACH section.
		{ id: "w2", segmentId: "s", startSec: 6, endSec: 8, text: "voilà" },
	],
};

function renderPane(onSeek: (sec: number) => void = vi.fn()) {
	return render(
		<I18nProvider>
			<TranscriptPane
				clips={CLIPS}
				transcripts={[TRANSCRIPT]}
				assets={[ASSET]}
				trimRanges={[]}
				busyAssetIds={[]}
				onSeek={onSeek}
				onAddTrimRange={vi.fn()}
				onRemoveTrimRange={vi.fn()}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={false}
			/>
		</I18nProvider>,
	);
}

beforeEach(() => {
	useProjectStore.setState({ currentTimeSec: 0 });
});

afterEach(() => {
	cleanup();
});

describe("transcript pane with two clips over one media", () => {
	it("gives every rendered word a DOM id unique across both blocks", () => {
		const { container } = renderPane();
		const ids = Array.from(container.querySelectorAll<HTMLElement>("[data-word-id]")).map(
			(el) => el.dataset.wordId,
		);
		// Each block renders w1, the 2–6s silence, w2 and the 8–12s trailing silence. The
		// two blocks are projections of the same transcript, so a bare `word.id` produced
		// these eight nodes carrying only four distinct ids — and the silence tokens
		// collided on top of that, being numbered from 1 within each clip.
		expect(ids).toHaveLength(8);
		expect(new Set(ids).size).toBe(8);
		expect(ids).toEqual(
			expect.arrayContaining(["clip_1:silence_1", "clip_2:silence_1", "clip_1:w2", "clip_2:w2"]),
		);
	});

	it("highlights the cue word in the playing clip only", () => {
		// Playhead at RAW 19s → inside clip_2 (ruler 12–24), source 7s → the word "voilà".
		useProjectStore.setState({ currentTimeSec: 19 });
		const { container } = renderPane();

		const cues = Array.from(container.querySelectorAll<HTMLElement>('[data-cue="true"]'));
		expect(cues).toHaveLength(1);
		expect(cues[0].dataset.wordId).toBe("clip_2:w2");
		expect(cues[0]).toHaveTextContent("voilà");
	});

	it("moves the highlight to the other block when the playhead crosses the boundary", () => {
		// Same source moment (7s), now reached through clip_1 (ruler 0–12).
		useProjectStore.setState({ currentTimeSec: 7 });
		const { container } = renderPane();

		const cues = Array.from(container.querySelectorAll<HTMLElement>('[data-cue="true"]'));
		expect(cues).toHaveLength(1);
		expect(cues[0].dataset.wordId).toBe("clip_1:w2");
	});

	// `onSeek` takes RAW TIMELINE seconds, a word's times are the ASSET's source seconds.
	// They coincide only for a clip sitting at ruler 0, so this was invisible until a second
	// clip existed — and stayed invisible while the cue lit up every block regardless of
	// where the playhead had actually landed.
	it("seeks to the clicked word's position on the RULER, not its source time", () => {
		const onSeek = vi.fn();
		const { container } = renderPane(onSeek);

		const inClip2 = container.querySelector<HTMLElement>('[data-word-id="clip_2:w2"]');
		expect(inClip2).not.toBeNull();
		fireEvent.pointerUp(inClip2 as HTMLElement, { button: 0 });
		// "voilà" is source 6s; clip_2 plays source 0–12 at ruler 12–24 → ruler 18s.
		expect(onSeek).toHaveBeenCalledWith(18);

		onSeek.mockClear();
		const inClip1 = container.querySelector<HTMLElement>('[data-word-id="clip_1:w2"]');
		fireEvent.pointerUp(inClip1 as HTMLElement, { button: 0 });
		// Same word, same source moment — but reached through the clip at ruler 0.
		expect(onSeek).toHaveBeenCalledWith(6);
	});

	it("clears the old block's highlight as the playhead crosses, rather than adding a second", () => {
		// A transition, not two independent renders: `TranscriptClipBlock` is memoised, so
		// the block the cue LEAVES only drops its underline if it actually re-renders. Two
		// highlights at once is the reported symptom, and a lingering stale one would look
		// identical on screen.
		useProjectStore.setState({ currentTimeSec: 7 }); // in clip_1
		const { container } = renderPane();
		expect(
			Array.from(container.querySelectorAll<HTMLElement>('[data-cue="true"]')).map(
				(el) => el.dataset.wordId,
			),
		).toEqual(["clip_1:w2"]);

		act(() => {
			useProjectStore.setState({ currentTimeSec: 19 }); // same source moment, in clip_2
		});
		expect(
			Array.from(container.querySelectorAll<HTMLElement>('[data-cue="true"]')).map(
				(el) => el.dataset.wordId,
			),
		).toEqual(["clip_2:w2"]);
	});
});
