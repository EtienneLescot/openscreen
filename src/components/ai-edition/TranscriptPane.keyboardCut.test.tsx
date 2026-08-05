// @vitest-environment jsdom
// Backspace/Delete in the transcript pane, with the caret sitting BETWEEN words at editor
// level. That is where `restoreCaretBeforeWord` parks it after every cut, so it is the
// state the user is in when they hold Backspace to keep trimming — and the state where
// the keystroke silently stopped doing anything as soon as an already-trimmed word lay in
// its path. Driving it needs a real Range/Selection, so these are DOM tests.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type {
	AxcutAsset,
	AxcutClip,
	AxcutTranscript,
	AxcutTrimRange,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { TranscriptPane } from "./RightPanes";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "recording.mp4",
	originalPath: "/rec.mp4",
	durationSec: 4,
	cameraTrack: null,
};

const CLIP: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 4,
	timelineStartSec: 0,
	timelineEndSec: 4,
	wordRefs: [],
	origin: "user",
	reason: "",
};

// Contiguous on purpose: any gap ≥ SILENCE_THRESHOLD_SEC would insert a `[silence]`
// pseudo-word between them and change the indices these tests set the caret by.
const TRANSCRIPT: AxcutTranscript = {
	assetId: "asset_1",
	language: "fr",
	segments: [],
	words: [
		{ id: "w1", segmentId: "s", startSec: 0, endSec: 1, text: "un" },
		{ id: "w2", segmentId: "s", startSec: 1, endSec: 2, text: "deux" },
		{ id: "w3", segmentId: "s", startSec: 2, endSec: 3, text: "trois" },
		{ id: "w4", segmentId: "s", startSec: 3, endSec: 4, text: "quatre" },
	],
};

/** A trim over `deux` only — `findCoveringTrim` matches on the word's centre (1.5s). */
const W2_TRIMMED: AxcutTrimRange = {
	id: "t_w2",
	assetId: "asset_1",
	clipId: "clip_1",
	startSec: 1,
	endSec: 2,
	origin: "user",
	reason: "",
};

function renderPane(
	trimRanges: AxcutTrimRange[],
	onAddTrimRange = vi.fn(),
	busyAssetIds: string[] = [],
) {
	const view = render(
		<I18nProvider>
			<TranscriptPane
				clips={[CLIP]}
				transcripts={[TRANSCRIPT]}
				assets={[ASSET]}
				trimRanges={trimRanges}
				busyAssetIds={busyAssetIds}
				onSeek={vi.fn()}
				onAddTrimRange={onAddTrimRange}
				onRemoveTrimRange={vi.fn()}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={false}
			/>
		</I18nProvider>,
	);
	const editor = view.container.querySelector<HTMLElement>('[role="textbox"]');
	if (!editor) throw new Error("transcript editor not rendered");
	return { ...view, editor, onAddTrimRange };
}

/**
 * Park the caret between words exactly as `restoreCaretBeforeWord` does: `setStartBefore`
 * on a word span collapses to (editor, index-of-that-word), so `anchorNode` is the editor
 * itself rather than any word's text node.
 */
function caretBeforeWordAt(editor: HTMLElement, index: number) {
	const range = document.createRange();
	range.setStart(editor, index);
	range.collapse(true);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

/** The words the pane cut, as `[startSec, endSec]` — what `onAddTrimRange` was asked for. */
function cutRange(onAddTrimRange: ReturnType<typeof vi.fn>): [number, number] | null {
	const call = onAddTrimRange.mock.calls.at(-1);
	return call ? [call[1] as number, call[2] as number] : null;
}

beforeEach(() => {
	useProjectStore.setState({ currentTimeSec: 0 });
});

afterEach(() => {
	cleanup();
	window.getSelection()?.removeAllRanges();
});

describe("keyboard cut with the caret between words", () => {
	it("Backspace cuts the word before the caret", () => {
		// The ordinary case, and the one that already worked: nothing trimmed yet.
		const { editor, onAddTrimRange } = renderPane([]);
		caretBeforeWordAt(editor, 3); // before "quatre"
		fireEvent.keyDown(editor, { key: "Backspace" });
		expect(cutRange(onAddTrimRange)).toEqual([2, 3]); // "trois"
	});

	it("keeps cutting while ANOTHER asset is being transcribed", () => {
		// The background pass runs on its own now, so a run on some other media must
		// not quietly turn this block into an editor that ignores Backspace — the
		// read-only state is scoped to the asset whose transcript is being rewritten.
		const { editor, onAddTrimRange } = renderPane([], vi.fn(), ["asset_other"]);
		caretBeforeWordAt(editor, 3);
		fireEvent.keyDown(editor, { key: "Backspace" });
		expect(cutRange(onAddTrimRange)).toEqual([2, 3]);
	});

	it("stops cutting, visibly, while THIS asset is being transcribed", () => {
		// Its transcript is about to be replaced, so the block is read-only — and it
		// says so, instead of swallowing the keystroke in silence.
		const { editor, onAddTrimRange, getByText } = renderPane([], vi.fn(), ["asset_1"]);
		caretBeforeWordAt(editor, 3);
		fireEvent.keyDown(editor, { key: "Backspace" });
		expect(cutRange(onAddTrimRange)).toBeNull();
		expect(editor).toHaveAttribute("aria-busy", "true");
		expect(getByText("Transcribing…")).toBeInTheDocument();
	});

	it("Backspace skips over an already-trimmed word instead of doing nothing", () => {
		// Hold Backspace and you land here: "deux" is already struck through, so the word
		// immediately before the caret has nothing left to cut. The keystroke used to
		// resolve to it anyway, `skipWordRange` dropped it as not-kept, and the user got
		// silence — they had to click elsewhere to carry on.
		const { editor, onAddTrimRange } = renderPane([W2_TRIMMED]);
		caretBeforeWordAt(editor, 2); // before "trois", i.e. right after the trimmed "deux"
		fireEvent.keyDown(editor, { key: "Backspace" });
		expect(cutRange(onAddTrimRange)).toEqual([0, 1]); // "un" — the nearest word still there
	});

	it("Delete skips over an already-trimmed word instead of doing nothing", () => {
		// The mirror case going forward. It had no guard at all: the candidate walk simply
		// returned the first word it met, trimmed or not.
		const { editor, onAddTrimRange } = renderPane([W2_TRIMMED]);
		caretBeforeWordAt(editor, 1); // before the trimmed "deux"
		fireEvent.keyDown(editor, { key: "Delete" });
		expect(cutRange(onAddTrimRange)).toEqual([2, 3]); // "trois"
	});

	it("does nothing when every word in that direction is already trimmed", () => {
		// Not a regression — there is genuinely nothing left to cut, so no document write.
		const { editor, onAddTrimRange } = renderPane([
			{ ...W2_TRIMMED, id: "t_head", startSec: 0, endSec: 2 },
		]);
		caretBeforeWordAt(editor, 2); // before "trois"; "un" and "deux" are both gone
		fireEvent.keyDown(editor, { key: "Backspace" });
		expect(onAddTrimRange).not.toHaveBeenCalled();
	});

	it("cuts nothing when the caret is at the very start and Backspace is pressed", () => {
		const { editor, onAddTrimRange } = renderPane([]);
		caretBeforeWordAt(editor, 0);
		fireEvent.keyDown(editor, { key: "Backspace" });
		expect(onAddTrimRange).not.toHaveBeenCalled();
	});

	// The story the whole thing exists for, in the shape the user meets it: the tests above
	// place the caret by hand, this one lets the pane park it itself
	// (`restoreCaretBeforeWord`) between keystrokes.
	//
	// It starts with "deux" ALREADY cut, because that is what it takes to reproduce. A plain
	// run of Backspaces never stalls: the caret lands before the word just removed and the
	// next press starts from its neighbour, which is still kept. The stall needs a
	// previously-trimmed word in the path — then the walk resolved to it, `skipWordRange`
	// dropped it as not-kept, and the run went quiet mid-hold.
	it("keeps cutting backwards while Backspace is held, across an earlier cut", () => {
		function Harness() {
			const [trims, setTrims] = useState<AxcutTrimRange[]>([W2_TRIMMED]);
			return (
				<I18nProvider>
					<TranscriptPane
						clips={[CLIP]}
						transcripts={[TRANSCRIPT]}
						assets={[ASSET]}
						trimRanges={trims}
						busyAssetIds={[]}
						onSeek={vi.fn()}
						onAddTrimRange={(_target, startSec, endSec) =>
							setTrims((prev) => [
								...prev,
								{
									id: `t_${prev.length}`,
									assetId: "asset_1",
									clipId: "clip_1",
									startSec,
									endSec,
									origin: "user" as const,
									reason: "",
								},
							])
						}
						onRemoveTrimRange={vi.fn()}
						onTranscribe={vi.fn()}
						canTranscribe
						isTranscribing={false}
					/>
				</I18nProvider>
			);
		}

		const { container } = render(<Harness />);
		const editor = container.querySelector<HTMLElement>('[role="textbox"]');
		if (!editor) throw new Error("transcript editor not rendered");

		// Start inside the last word, as a user would after clicking it.
		const quatre = container.querySelector<HTMLElement>('[data-word-id="clip_1:w4"]');
		const range = document.createRange();
		range.setStart(quatre?.firstChild as Node, 1);
		range.collapse(true);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);

		// quatre, trois, then straight over the already-cut deux to un.
		for (let i = 0; i < 3; i += 1) fireEvent.keyDown(editor, { key: "Backspace" });

		const struck = Array.from(container.querySelectorAll<HTMLElement>("[data-word-id]"))
			.filter((el) => el.style.textDecoration === "line-through")
			.map((el) => el.dataset.wordId);
		// The third press is the one that used to be swallowed: without it "un" survives.
		expect(struck).toEqual(["clip_1:w1", "clip_1:w2", "clip_1:w3", "clip_1:w4"]);
	});
});
