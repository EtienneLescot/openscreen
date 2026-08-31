// @vitest-environment jsdom
// Typing a word into the transcript that nobody said.
//
// This is the third gesture on the one word stream, and the one that had to get past a
// guard: the block used to swallow every keystroke outright, because free text has no
// `transcript.words` entry to land on. It still never lands in the block — what a typed
// character opens is a field beside the word the caret was on, and only its commit makes a
// word. These tests hold that: the DOM never gets ahead of `words`, and Backspace inside
// the field types instead of cutting the clip out from under it.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutAsset, AxcutClip, AxcutTranscript, AxcutWord } from "@/lib/ai-edition/schema";
import { TranscriptPane } from "./RightPanes";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "recording.mp4",
	originalPath: "/rec.mp4",
	durationSec: 3,
	cameraTrack: null,
};

const CLIP: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 3,
	timelineStartSec: 0,
	timelineEndSec: 3,
	wordRefs: [],
	origin: "user",
	reason: "",
};

// Contiguous, so no `[silence]` pill sits between them to shift the caret indices.
const WORDS: AxcutWord[] = [
	{ id: "w1", segmentId: "s", startSec: 0, endSec: 1, text: "Bonjour" },
	{ id: "w2", segmentId: "s", startSec: 1, endSec: 2, text: "à" },
	{ id: "w3", segmentId: "s", startSec: 2, endSec: 3, text: "tous" },
];

function renderPane(words: AxcutWord[] = WORDS, busyAssetIds: string[] = []) {
	const onInsertWord = vi.fn();
	const onRemoveWords = vi.fn();
	const onAddTrimRange = vi.fn();
	const transcript: AxcutTranscript = {
		assetId: "asset_1",
		language: "fr",
		segments: [],
		words,
	};
	const view = render(
		<I18nProvider>
			<TranscriptPane
				clips={[CLIP]}
				transcripts={[transcript]}
				assets={[ASSET]}
				trimRanges={[]}
				busyAssetIds={busyAssetIds}
				onSeek={vi.fn()}
				onAddTrimRange={onAddTrimRange}
				onRemoveTrimRange={vi.fn()}
				onSetWordText={vi.fn()}
				onInsertWord={onInsertWord}
				onRemoveWords={onRemoveWords}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={false}
			/>
		</I18nProvider>,
	);
	const editor = view.container.querySelector<HTMLElement>('[role="textbox"]');
	if (!editor) throw new Error("transcript editor not rendered");
	const field = () => view.container.querySelector<HTMLInputElement>("input[data-word-inserter]");
	const wordEl = (id: string) => {
		const el = view.container.querySelector<HTMLElement>(`[data-word-id="clip_1:${id}"]`);
		if (!el) throw new Error(`word ${id} not rendered`);
		return el;
	};
	return { ...view, editor, field, wordEl, onInsertWord, onRemoveWords, onAddTrimRange };
}

/** Park the caret between words at editor level, the way `restoreCaretBeforeWord` does. */
function caretBeforeWordAt(editor: HTMLElement, index: number) {
	const range = document.createRange();
	range.setStart(editor, index);
	range.collapse(true);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

/**
 * A real native `beforeinput`, because that is what the block listens to.
 *
 * Not `fireEvent.beforeInput`: React 18 builds its `onBeforeInput` from the legacy
 * `textInput` event, whose `TextEvent` has no `inputType` — which is exactly why the guard
 * moved off React and onto the DOM. Driving the synthetic one here would test a path the
 * browser never takes.
 */
function type(editor: HTMLElement, data: string) {
	// Through `fireEvent` so the state the listener sets is flushed, but with an event
	// built by hand — `fireEvent.beforeInput` does not exist here, and the point is to
	// dispatch the real thing.
	fireEvent(
		editor,
		new InputEvent("beforeinput", {
			data,
			inputType: "insertText",
			bubbles: true,
			cancelable: true,
		}),
	);
}

afterEach(() => {
	cleanup();
	window.getSelection()?.removeAllRanges();
});

describe("typing between two words", () => {
	it("opens a field there instead of dropping the keystroke", () => {
		const view = renderPane();
		expect(view.field()).toBeNull();
		caretBeforeWordAt(view.editor, 2); // between "à" and "tous"
		type(view.editor, "v");
		expect(view.field()).toHaveValue("v");
	});

	it("never writes the typed text into the block itself", () => {
		// The whole reason inserts were blocked: a run of text with no word id behind it
		// desynchronises the DOM from `words`.
		const view = renderPane();
		caretBeforeWordAt(view.editor, 2);
		type(view.editor, "v");
		expect(view.editor.textContent).not.toContain("v ");
		expect(view.onInsertWord).not.toHaveBeenCalled();
	});

	it("commits on Enter, against the word the caret was after", () => {
		const view = renderPane();
		caretBeforeWordAt(view.editor, 2);
		type(view.editor, "v");
		const field = view.field();
		if (!field) throw new Error("no insertion field");
		fireEvent.change(field, { target: { value: "vraiment" } });
		fireEvent.keyDown(field, { key: "Enter" });
		expect(view.onInsertWord).toHaveBeenCalledWith("asset_1", "w2", "after", "vraiment");
	});

	it("anchors before the first word when the caret is at the very start", () => {
		const view = renderPane();
		caretBeforeWordAt(view.editor, 0);
		type(view.editor, "E");
		const field = view.field();
		if (!field) throw new Error("no insertion field");
		fireEvent.keyDown(field, { key: "Enter" });
		expect(view.onInsertWord).toHaveBeenCalledWith("asset_1", "w1", "before", "E");
	});

	it("abandons on Escape without writing anything", () => {
		const view = renderPane();
		caretBeforeWordAt(view.editor, 2);
		type(view.editor, "v");
		const field = view.field();
		if (!field) throw new Error("no insertion field");
		fireEvent.keyDown(field, { key: "Escape" });
		fireEvent.blur(field);
		expect(view.onInsertWord).not.toHaveBeenCalled();
		expect(view.field()).toBeNull();
	});

	it("commits on blur", () => {
		const view = renderPane();
		caretBeforeWordAt(view.editor, 1);
		type(view.editor, "x");
		const field = view.field();
		if (!field) throw new Error("no insertion field");
		fireEvent.change(field, { target: { value: "donc" } });
		fireEvent.blur(field);
		expect(view.onInsertWord).toHaveBeenCalledWith("asset_1", "w1", "after", "donc");
	});

	it("does not cut the media when Backspace is pressed inside the field", () => {
		const view = renderPane();
		caretBeforeWordAt(view.editor, 2);
		type(view.editor, "v");
		const field = view.field();
		if (!field) throw new Error("no insertion field");
		fireEvent.keyDown(field, { key: "Backspace" });
		expect(view.onAddTrimRange).not.toHaveBeenCalled();
	});

	it("stays shut while this clip's transcript is being regenerated", () => {
		const view = renderPane(WORDS, ["asset_1"]);
		caretBeforeWordAt(view.editor, 2);
		type(view.editor, "v");
		expect(view.field()).toBeNull();
	});
});

describe("a word that was inserted", () => {
	const INSERTED: AxcutWord[] = [
		WORDS[0],
		{ id: "synth_1", segmentId: "s", startSec: 1, endSec: 1, text: "vraiment", source: "synth" },
		WORDS[1],
		WORDS[2],
	];

	it("reads as its own thing, not as a transcribed word", () => {
		const view = renderPane(INSERTED);
		const el = view.wordEl("synth_1");
		expect(el).toHaveAttribute("data-inserted", "true");
		expect(el.textContent).toContain("vraiment");
	});

	// There is no audio for a trim to remove, so the gesture that makes a spoken word go
	// away cannot be the one that makes this go away.
	it("is deleted outright by its own control", () => {
		const view = renderPane(INSERTED);
		fireEvent.mouseEnter(view.wordEl("synth_1"));
		const remove = view.wordEl("synth_1").querySelector("button");
		if (!remove) throw new Error("no delete control");
		fireEvent.click(remove);
		expect(view.onRemoveWords).toHaveBeenCalledWith("asset_1", ["synth_1"]);
	});

	it("is deleted, not trimmed, when Backspace lands on it alone", () => {
		const view = renderPane(INSERTED);
		caretBeforeWordAt(view.editor, 2); // right after the insert
		fireEvent.keyDown(view.editor, { key: "Backspace" });
		expect(view.onRemoveWords).toHaveBeenCalledWith("asset_1", ["synth_1"]);
		expect(view.onAddTrimRange).not.toHaveBeenCalled();
	});
});
