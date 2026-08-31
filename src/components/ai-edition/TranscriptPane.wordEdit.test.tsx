// @vitest-environment jsdom
// Correcting a word's TEXT in the transcript pane, as opposed to cutting it.
//
// The two gestures share one word stream on purpose (no mode, no second tab), so what
// keeps them apart is which gesture the user makes: Backspace cuts the media, a
// double-click rewrites the text. These tests hold that line — a keystroke inside the
// editing field must never reach the cut path, and a correction must never touch the
// timeline.

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

// Contiguous: a gap would insert a `[silence]` pill between the words and move the
// indices these tests address words by.
const WORDS: AxcutWord[] = [
	{ id: "w1", segmentId: "s", startSec: 0, endSec: 1, text: "Bonjour" },
	{ id: "w2", segmentId: "s", startSec: 1, endSec: 2, text: "Kubernetes" },
	{ id: "w3", segmentId: "s", startSec: 2, endSec: 3, text: "tout" },
];

function transcript(words: AxcutWord[] = WORDS): AxcutTranscript {
	return { assetId: "asset_1", language: "fr", segments: [], words };
}

function renderPane(words?: AxcutWord[], busyAssetIds: string[] = []) {
	const onSetWordText = vi.fn();
	const onAddTrimRange = vi.fn();
	const view = render(
		<I18nProvider>
			<TranscriptPane
				clips={[CLIP]}
				transcripts={[transcript(words)]}
				assets={[ASSET]}
				trimRanges={[]}
				busyAssetIds={busyAssetIds}
				onSeek={vi.fn()}
				onAddTrimRange={onAddTrimRange}
				onRemoveTrimRange={vi.fn()}
				onSetWordText={onSetWordText}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={false}
			/>
		</I18nProvider>,
	);
	const wordEl = (id: string) => {
		const el = view.container.querySelector<HTMLElement>(`[data-word-id="clip_1:${id}"]`);
		if (!el) throw new Error(`word ${id} not rendered`);
		return el;
	};
	const field = () => view.container.querySelector<HTMLInputElement>("input[data-word-editor]");
	return { ...view, wordEl, field, onSetWordText, onAddTrimRange };
}

afterEach(cleanup);

describe("correcting a word", () => {
	it("opens an editing field on the word a double-click lands on", () => {
		const view = renderPane();
		expect(view.field()).toBeNull();
		fireEvent.doubleClick(view.wordEl("w2"));
		expect(view.field()).toHaveValue("Kubernetes");
	});

	it("commits on Enter, addressing the word by its BARE id and the clip's asset", () => {
		const view = renderPane();
		fireEvent.doubleClick(view.wordEl("w2"));
		const field = view.field();
		if (!field) throw new Error("no editing field");
		fireEvent.change(field, { target: { value: "Kubernetes 1.31" } });
		fireEvent.keyDown(field, { key: "Enter" });
		// `clip_1:w2` is what the DOM node carries; the transcript knows only `w2`.
		expect(view.onSetWordText).toHaveBeenCalledWith("asset_1", "w2", "Kubernetes 1.31");
	});

	it("commits on blur, so clicking away does not throw the correction out", () => {
		const view = renderPane();
		fireEvent.doubleClick(view.wordEl("w1"));
		const field = view.field();
		if (!field) throw new Error("no editing field");
		fireEvent.change(field, { target: { value: "Bonsoir" } });
		fireEvent.blur(field);
		expect(view.onSetWordText).toHaveBeenCalledWith("asset_1", "w1", "Bonsoir");
	});

	it("abandons on Escape, and a blur afterwards does not resurrect the draft", () => {
		const view = renderPane();
		fireEvent.doubleClick(view.wordEl("w1"));
		const field = view.field();
		if (!field) throw new Error("no editing field");
		fireEvent.change(field, { target: { value: "Bonsoir" } });
		fireEvent.keyDown(field, { key: "Escape" });
		fireEvent.blur(field);
		expect(view.onSetWordText).not.toHaveBeenCalled();
		expect(view.field()).toBeNull();
	});

	it("writes nothing when the text comes back unchanged", () => {
		const view = renderPane();
		fireEvent.doubleClick(view.wordEl("w2"));
		const field = view.field();
		if (!field) throw new Error("no editing field");
		fireEvent.keyDown(field, { key: "Enter" });
		expect(view.onSetWordText).not.toHaveBeenCalled();
	});

	// The field lives inside the block's contentEditable, whose Backspace handler cuts the
	// media. Without the stopPropagation on the field, deleting a letter would trim the clip.
	it("does not cut the media when Backspace is pressed inside the field", () => {
		const view = renderPane();
		fireEvent.doubleClick(view.wordEl("w2"));
		const field = view.field();
		if (!field) throw new Error("no editing field");
		fireEvent.keyDown(field, { key: "Backspace" });
		expect(view.onAddTrimRange).not.toHaveBeenCalled();
	});

	it("stays read-only while the transcript is being regenerated", () => {
		const view = renderPane(undefined, ["asset_1"]);
		fireEvent.doubleClick(view.wordEl("w2"));
		expect(view.field()).toBeNull();
	});
});

describe("a word already corrected", () => {
	const CORRECTED: AxcutWord[] = [
		WORDS[0],
		{ ...WORDS[1], text: "Kubernetes", originalText: "Cuber Nettes", source: "user" },
		WORDS[2],
	];

	it("is marked as corrected and names what the transcriber heard", () => {
		const view = renderPane(CORRECTED);
		const el = view.wordEl("w2");
		expect(el).toHaveAttribute("data-corrected", "true");
		expect(el.title).toContain("Cuber Nettes");
	});

	it("offers a revert that writes the transcriber's own text back", () => {
		const view = renderPane(CORRECTED);
		fireEvent.mouseEnter(view.wordEl("w2"));
		const revert = view.wordEl("w2").querySelector("button");
		if (!revert) throw new Error("no revert control");
		fireEvent.click(revert);
		expect(view.onSetWordText).toHaveBeenCalledWith("asset_1", "w2", "Cuber Nettes");
	});

	it("leaves an untouched word unmarked and without a revert", () => {
		const view = renderPane(CORRECTED);
		fireEvent.mouseEnter(view.wordEl("w1"));
		expect(view.wordEl("w1")).not.toHaveAttribute("data-corrected");
		expect(view.wordEl("w1").querySelector("button")).toBeNull();
	});
});

// Emptying a word is how a junk token gets out of the captions without cutting the audio.
// Rendered as its own (empty) text it would be a bare space: invisible, un-clickable, and
// therefore impossible to undo.
describe("a word the user emptied", () => {
	const BLANKED: AxcutWord[] = [
		WORDS[0],
		{ ...WORDS[1], text: "", originalText: "Kubernetes", source: "user" },
		WORDS[2],
	];

	it("keeps a visible, clickable place in the stream", () => {
		const view = renderPane(BLANKED);
		const el = view.wordEl("w2");
		expect(el).toHaveAttribute("data-blanked", "true");
		expect(el.textContent?.trim()).not.toBe("");
	});

	it("can be reopened for editing and reverted", () => {
		const view = renderPane(BLANKED);
		fireEvent.doubleClick(view.wordEl("w2"));
		expect(view.field()).toHaveValue("");

		fireEvent.keyDown(view.field() as HTMLInputElement, { key: "Escape" });
		fireEvent.mouseEnter(view.wordEl("w2"));
		const revert = view.wordEl("w2").querySelector("button");
		if (!revert) throw new Error("no revert control");
		fireEvent.click(revert);
		expect(view.onSetWordText).toHaveBeenCalledWith("asset_1", "w2", "Kubernetes");
	});
});
