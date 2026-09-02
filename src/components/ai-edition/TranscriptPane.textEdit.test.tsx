// @vitest-environment jsdom

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { replaceTranscriptText } from "@/lib/ai-edition/document/transcript";
import type {
	AxcutAsset,
	AxcutClip,
	AxcutTranscript,
	AxcutTrimRange,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { TranscriptPane, type TrimTarget } from "./RightPanes";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "recording.mp4",
	originalPath: "/rec.mp4",
	durationSec: 8,
	cameraTrack: null,
};

const CLIP: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 8,
	timelineStartSec: 0,
	timelineEndSec: 8,
	wordRefs: [],
	origin: "user",
	reason: "",
};

const SECOND_CLIP: AxcutClip = {
	...CLIP,
	id: "clip_2",
	timelineStartSec: 8,
	timelineEndSec: 16,
};

const TRANSCRIPT: AxcutTranscript = {
	assetId: "asset_1",
	language: "en",
	segments: [
		{
			id: "segment_1",
			kind: "speech",
			startSec: 0,
			endSec: 8,
			text: "Hello brave world",
			wordIds: ["w1", "w2", "w3"],
		},
	],
	words: [
		{ id: "w1", segmentId: "segment_1", startSec: 0, endSec: 1, text: "Hello" },
		// The 1-4s gap creates a synthetic silence chip in cut mode.
		{ id: "w2", segmentId: "segment_1", startSec: 4, endSec: 5, text: "brave" },
		{ id: "w3", segmentId: "segment_1", startSec: 5, endSec: 6, text: "world" },
	],
};

const TRIMMED_W2: AxcutTrimRange = {
	id: "trim_w2",
	assetId: "asset_1",
	clipId: "clip_1",
	startSec: 4,
	endSec: 5,
	origin: "user",
	reason: "",
};

type TextSave = (
	assetId: string,
	wordIds: readonly string[],
	text: string,
) => Promise<boolean> | boolean;

function paneElement({
	clips = [CLIP],
	transcript = TRANSCRIPT,
	trimRanges = [TRIMMED_W2],
	busyAssetIds = [],
	onSeek = vi.fn(),
	onAddTrimRange = vi.fn(),
	onEditTranscriptText = vi.fn(async () => true),
}: {
	clips?: AxcutClip[];
	transcript?: AxcutTranscript;
	trimRanges?: AxcutTrimRange[];
	busyAssetIds?: string[];
	onSeek?: ReturnType<typeof vi.fn>;
	onAddTrimRange?: ReturnType<typeof vi.fn>;
	onEditTranscriptText?: TextSave;
} = {}) {
	return (
		<I18nProvider>
			<TranscriptPane
				clips={clips}
				transcripts={[transcript]}
				assets={[ASSET]}
				trimRanges={trimRanges}
				busyAssetIds={busyAssetIds}
				onSeek={onSeek as (sec: number) => void}
				onAddTrimRange={
					onAddTrimRange as (
						target: TrimTarget,
						startSec: number,
						endSec: number,
						reason: string,
					) => void
				}
				onRemoveTrimRange={vi.fn()}
				onEditTranscriptText={onEditTranscriptText}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={false}
			/>
		</I18nProvider>
	);
}

function renderPane({
	clips = [CLIP],
	transcript = TRANSCRIPT,
	trimRanges = [TRIMMED_W2],
	busyAssetIds = [],
	onSeek = vi.fn(),
	onAddTrimRange = vi.fn(),
	onEditTranscriptText = vi.fn(async () => true),
}: {
	clips?: AxcutClip[];
	transcript?: AxcutTranscript;
	trimRanges?: AxcutTrimRange[];
	busyAssetIds?: string[];
	onSeek?: ReturnType<typeof vi.fn>;
	onAddTrimRange?: ReturnType<typeof vi.fn>;
	onEditTranscriptText?: TextSave;
} = {}) {
	return {
		...render(
			paneElement({
				clips,
				transcript,
				trimRanges,
				busyAssetIds,
				onSeek,
				onAddTrimRange,
				onEditTranscriptText,
			}),
		),
		onSeek,
		onAddTrimRange,
		onEditTranscriptText,
	};
}

function selectText(node: Text, start: number, end: number) {
	const range = document.createRange();
	range.setStart(node, start);
	range.setEnd(node, end);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

async function flushTextEdit() {
	await act(async () => {
		vi.advanceTimersByTime(300);
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	useProjectStore.setState({ currentTimeSec: 0 });
});

afterEach(() => {
	cleanup();
	window.getSelection()?.removeAllRanges();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("TranscriptPane text editing mode", () => {
	it("defaults to cut mode and preserves cut rendering and Backspace semantics", () => {
		const onAddTrimRange = vi.fn();
		const { container } = renderPane({ onAddTrimRange });
		expect(screen.getByRole("button", { name: "Cut selected video" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("button", { name: "Transcript text" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		expect(container.querySelector('[data-silence="true"]')).toBeInTheDocument();
		expect(container.querySelector('[data-word-id="clip_1:w2"]')).toHaveStyle({
			textDecoration: "line-through",
		});

		const editor = screen.getByRole("textbox");
		const firstWord = container.querySelector<HTMLElement>('[data-word-id="clip_1:w1"]');
		selectText(firstWord?.firstChild as Text, 1, 1);
		fireEvent.keyDown(editor, { key: "Backspace" });
		expect(onAddTrimRange).toHaveBeenCalled();
	});

	it("switches to a plain editable projection and restores cut affordances on return", () => {
		const { container } = renderPane();
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));

		const editor = screen.getByRole("textbox");
		expect(editor).toHaveAttribute("contenteditable", "true");
		expect(editor).toHaveAttribute("aria-readonly", "false");
		expect(editor).toHaveTextContent("Hello brave world");
		expect(container.querySelector('[data-silence="true"]')).not.toBeInTheDocument();
		expect(container.querySelector("[data-skip-id]")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Cut selected video" }));
		expect(container.querySelector('[data-silence="true"]')).toBeInTheDocument();
		expect(container.querySelector('[data-word-id="clip_1:w2"]')).toHaveStyle({
			textDecoration: "line-through",
		});
	});

	it("renders Chinese compactly and mixed Latin text with readable boundaries", () => {
		const transcript: AxcutTranscript = {
			assetId: "asset_1",
			language: "auto",
			segments: [
				{
					id: "segment_zh",
					kind: "speech",
					startSec: 0,
					endSec: 5,
					text: "我使用 Claude Code 剪视频",
					wordIds: ["zh1", "zh2", "zh3", "zh4", "zh5"],
				},
			],
			words: [
				{ id: "zh1", segmentId: "segment_zh", startSec: 0, endSec: 1, text: "我" },
				{ id: "zh2", segmentId: "segment_zh", startSec: 1, endSec: 2, text: "使用" },
				{ id: "zh3", segmentId: "segment_zh", startSec: 2, endSec: 3, text: "Claude" },
				{ id: "zh4", segmentId: "segment_zh", startSec: 3, endSec: 4, text: "Code" },
				{ id: "zh5", segmentId: "segment_zh", startSec: 4, endSec: 5, text: "剪视频" },
			],
		};
		renderPane({ transcript, trimRanges: [] });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));

		expect(screen.getByRole("textbox")).toHaveTextContent("我使用 Claude Code 剪视频");
	});

	it("coalesces a typing burst into one bare-word text save and never trims video", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		const onAddTrimRange = vi.fn();
		renderPane({ onEditTranscriptText, onAddTrimRange });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");

		editor.textContent = "Hello brave worlds";
		fireEvent.input(editor, { inputType: "insertText", data: "s" });
		editor.textContent = "Hello brave worlds!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });
		expect(onEditTranscriptText).not.toHaveBeenCalled();
		await flushTextEdit();

		expect(onEditTranscriptText).toHaveBeenCalledTimes(1);
		expect(onEditTranscriptText).toHaveBeenCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Hello brave worlds!",
		);
		expect(onAddTrimRange).not.toHaveBeenCalled();
	});

	it("debounces a typing burst from the most recent input", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		renderPane({ onEditTranscriptText });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");

		editor.textContent = "Hello brave world!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });
		await act(async () => {
			vi.advanceTimersByTime(200);
		});
		editor.textContent = "Hello brave world!!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });
		await act(async () => {
			vi.advanceTimersByTime(60);
			await Promise.resolve();
		});

		// Only 60 ms passed after the newest input, so the 250 ms debounce
		// must still be armed rather than saving on the first input's clock.
		expect(onEditTranscriptText).not.toHaveBeenCalled();
		await act(async () => {
			vi.advanceTimersByTime(200);
			await Promise.resolve();
		});
		expect(onEditTranscriptText).toHaveBeenCalledTimes(1);
		expect(onEditTranscriptText).toHaveBeenCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Hello brave world!!",
		);
	});

	it("preserves newer typing when an earlier save projection lands", async () => {
		let releaseFirst: (() => void) | undefined;
		const onEditTranscriptText = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					releaseFirst = () => resolve(true);
				}),
		);
		const view = render(paneElement({ onEditTranscriptText }));
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");

		editor.textContent = "Hello brave world!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });
		await act(async () => {
			vi.advanceTimersByTime(300);
			await Promise.resolve();
		});
		expect(onEditTranscriptText).toHaveBeenCalledTimes(1);

		// Keep typing while the first disk write is still in flight.
		editor.textContent = "Hello brave world!!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });

		// The first save lands in the store and re-renders the projection
		// before its promise resolves to the editor.
		const firstSaved = replaceTranscriptText(TRANSCRIPT, ["w1", "w2", "w3"], "Hello brave world!");
		view.rerender(paneElement({ transcript: firstSaved, onEditTranscriptText }));
		await act(async () => {
			releaseFirst?.();
			await Promise.resolve();
			vi.advanceTimersByTime(300);
			await Promise.resolve();
		});

		expect(onEditTranscriptText).toHaveBeenCalledTimes(2);
		expect(onEditTranscriptText).toHaveBeenLastCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Hello brave world!!",
		);
	});

	it("replaces a selection spanning words with normalized plain-text paste", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		renderPane({ onEditTranscriptText });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		const textNode = editor.firstChild as Text;
		selectText(textNode, 3, 12);

		fireEvent.paste(editor, {
			clipboardData: { getData: (type: string) => (type === "text/plain" ? "pasted\ntext" : "") },
		});
		// The fixture's 1-4s speech pause projects as a "\n\n" break inside the
		// selection (offsets 3-12 cover "lo\n\nbrave"), so the space before "world"
		// survives the paste.
		expect(editor).toHaveTextContent("Helpasted text world");
		await flushTextEdit();
		expect(onEditTranscriptText).toHaveBeenCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Helpasted text world",
		);
	});

	it("lets Backspace/Delete edit text without seeking or cutting", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		const onAddTrimRange = vi.fn();
		const onSeek = vi.fn();
		renderPane({ onEditTranscriptText, onAddTrimRange, onSeek });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		selectText(editor.firstChild as Text, 5, 5);

		fireEvent.pointerUp(editor, { button: 0 });
		fireEvent.keyDown(editor, { key: "Backspace" });
		editor.textContent = "Hell brave world";
		fireEvent.input(editor, { inputType: "deleteContentBackward" });
		fireEvent.keyDown(editor, { key: "Delete" });
		await flushTextEdit();

		expect(onSeek).not.toHaveBeenCalled();
		expect(onAddTrimRange).not.toHaveBeenCalled();
		expect(onEditTranscriptText).toHaveBeenCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Hell brave world",
		);
	});

	it("is read-only only for the asset currently being transcribed", () => {
		const first = renderPane({ busyAssetIds: ["asset_1"] });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "false");
		expect(screen.getByRole("textbox")).toHaveAttribute("aria-busy", "true");
		first.unmount();

		renderPane({ busyAssetIds: ["asset_other"] });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true");
		expect(screen.getByRole("textbox")).toHaveAttribute("aria-busy", "false");
	});

	it("updates both clip projections when shared transcript state is saved", async () => {
		function Harness() {
			const [transcript, setTranscript] = useState(TRANSCRIPT);
			return (
				<I18nProvider>
					<TranscriptPane
						clips={[CLIP, SECOND_CLIP]}
						transcripts={[transcript]}
						assets={[ASSET]}
						trimRanges={[]}
						busyAssetIds={[]}
						onSeek={vi.fn()}
						onAddTrimRange={vi.fn()}
						onRemoveTrimRange={vi.fn()}
						onEditTranscriptText={(_assetId, wordIds, text) => {
							setTranscript((current) => replaceTranscriptText(current, wordIds, text));
							return true;
						}}
						onTranscribe={vi.fn()}
						canTranscribe
						isTranscribing={false}
					/>
				</I18nProvider>
			);
		}

		render(<Harness />);
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editors = screen.getAllByRole("textbox");
		editors[0].textContent = "Hello shared world";
		fireEvent.input(editors[0], { inputType: "insertText" });
		await flushTextEdit();
		// The fixture's 1-4s pause projects as a break: "Hello shared | world" is
		// two paragraphs, and both clip editors render the same projection.
		expect(screen.getAllByRole("textbox").map((editor) => editor.textContent)).toEqual([
			"Hello shared\n\nworld",
			"Hello shared\n\nworld",
		]);
	});

	it("restores the last committed text when persistence reports failure", async () => {
		const onEditTranscriptText = vi.fn(async () => false);
		renderPane({ onEditTranscriptText });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		editor.textContent = "unsaved text";
		fireEvent.input(editor, { inputType: "insertText" });

		await flushTextEdit();

		expect(onEditTranscriptText).toHaveBeenCalled();
		expect(editor).toHaveTextContent("Hello brave world");
	});

	it("does not save when switching modes without editing", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		renderPane({ onEditTranscriptText });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		fireEvent.click(screen.getByRole("button", { name: "Cut selected video" }));
		await flushTextEdit();
		expect(onEditTranscriptText).not.toHaveBeenCalled();
	});

	it("ignores intermediate IME composition input and saves once at compositionend", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		renderPane({ onEditTranscriptText });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");

		fireEvent.compositionStart(editor);
		// Pinyin fragments arrive as input events mid-composition.
		editor.textContent = "Hello brave worldn";
		fireEvent.input(editor, { inputType: "insertCompositionText", data: "n" });
		editor.textContent = "Hello brave worldni";
		fireEvent.input(editor, { inputType: "insertCompositionText", data: "i" });
		fireEvent.compositionEnd(editor, { data: "你" });
		editor.textContent = "Hello brave world你好";
		fireEvent.input(editor, { inputType: "insertCompositionText", data: "你" });
		await flushTextEdit();

		expect(onEditTranscriptText).toHaveBeenCalledTimes(1);
		expect(onEditTranscriptText).toHaveBeenCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Hello brave world你好",
		);
	});

	it("keeps the caret in place when a replaced transcript rewrites the DOM", async () => {
		const replaced: AxcutTranscript = {
			assetId: "asset_1",
			language: "en",
			segments: [
				{
					id: "segment_new",
					kind: "speech",
					startSec: 0,
					endSec: 3,
					text: "Bonjour le monde",
					wordIds: ["n1", "n2", "n3"],
				},
			],
			words: [
				{ id: "n1", segmentId: "segment_new", startSec: 0, endSec: 1, text: "Bonjour" },
				{ id: "n2", segmentId: "segment_new", startSec: 1, endSec: 2, text: "le" },
				{ id: "n3", segmentId: "segment_new", startSec: 2, endSec: 3, text: "monde" },
			],
		};
		const view = render(paneElement({ onEditTranscriptText: vi.fn(async () => true) }));
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		editor.focus();
		const textNode = editor.firstChild as Text;
		selectText(textNode, 6, 6); // caret after "Hello "
		expect(editor.textContent).toBe("Hello\n\nbrave world");

		// A transcription regen lands a new transcript while the user is
		// focused in the editor: the DOM is rewritten to the new projection,
		// and the caret must stay at its (clamped) offset instead of jumping
		// to the start.
		view.rerender(paneElement({ transcript: replaced }));
		const selection = window.getSelection();
		expect(editor.textContent).toBe("Bonjour le monde");
		expect(selection?.rangeCount).toBeGreaterThan(0);
		expect(editor.contains(selection?.anchorNode ?? null)).toBe(true);
		expect(selection?.anchorOffset).toBe(6);
	});

	it("does not rewrite the DOM mid-composition even when the projection changes", async () => {
		const replaced: AxcutTranscript = {
			assetId: "asset_1",
			language: "en",
			segments: [
				{
					id: "segment_new",
					kind: "speech",
					startSec: 0,
					endSec: 3,
					text: "Bonjour le monde",
					wordIds: ["n1", "n2", "n3"],
				},
			],
			words: [
				{ id: "n1", segmentId: "segment_new", startSec: 0, endSec: 1, text: "Bonjour" },
				{ id: "n2", segmentId: "segment_new", startSec: 1, endSec: 2, text: "le" },
				{ id: "n3", segmentId: "segment_new", startSec: 2, endSec: 3, text: "monde" },
			],
		};
		const view = render(paneElement({ onEditTranscriptText: vi.fn(async () => true) }));
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		editor.focus();
		fireEvent.compositionStart(editor);
		editor.textContent = "Hello brave world中";
		fireEvent.input(editor, { inputType: "insertCompositionText", data: "中" });

		// A projection update lands while composition is live: the DOM must be
		// left to the IME until compositionend.
		view.rerender(paneElement({ transcript: replaced }));
		expect(editor.textContent).toBe("Hello brave world中");

		fireEvent.compositionEnd(editor, { data: "中国" });
		// compositionend clears the guard; the next projection CHANGE (this
		// rerender with a further transcript) converges the DOM onto it.
		const afterComposition: AxcutTranscript = {
			...replaced,
			words: [
				{ id: "n1", segmentId: "segment_new", startSec: 0, endSec: 1, text: "Au" },
				{ id: "n2", segmentId: "segment_new", startSec: 1, endSec: 2, text: "revoir" },
			],
			segments: [
				{
					id: "segment_new",
					kind: "speech",
					startSec: 0,
					endSec: 2,
					text: "Au revoir",
					wordIds: ["n1", "n2"],
				},
			],
		};
		view.rerender(paneElement({ transcript: afterComposition }));
		expect(editor.textContent).toBe("Au revoir");
	});

	it("polls a pending save through a transcription run instead of dropping it", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		const view = render(paneElement({ onEditTranscriptText }));
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		editor.textContent = "Hello brave world!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });

		// The transcription run starts BEFORE the debounce fires: the editor
		// goes read-only and the save must wait it out.
		view.rerender(paneElement({ onEditTranscriptText, busyAssetIds: ["asset_1"] }));
		await act(async () => {
			vi.advanceTimersByTime(400);
			await Promise.resolve();
		});
		expect(onEditTranscriptText).not.toHaveBeenCalled();

		// The run finishes; the next poll commits the burst.
		view.rerender(paneElement({ onEditTranscriptText }));
		await act(async () => {
			vi.advanceTimersByTime(400);
			await Promise.resolve();
		});
		expect(onEditTranscriptText).toHaveBeenCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Hello brave world!",
		);
	});

	it("drops a stale pending burst when the transcript is replaced underneath it", async () => {
		const replaced: AxcutTranscript = {
			assetId: "asset_1",
			language: "en",
			segments: [
				{
					id: "segment_new",
					kind: "speech",
					startSec: 0,
					endSec: 3,
					text: "Brand new words",
					wordIds: ["n1", "n2", "n3"],
				},
			],
			words: [
				{ id: "n1", segmentId: "segment_new", startSec: 0, endSec: 1, text: "Brand" },
				{ id: "n2", segmentId: "segment_new", startSec: 1, endSec: 2, text: "new" },
				{ id: "n3", segmentId: "segment_new", startSec: 2, endSec: 3, text: "words" },
			],
		};
		const onEditTranscriptText = vi.fn(async () => true);
		const view = render(paneElement({ onEditTranscriptText }));
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		editor.textContent = "Hello brave world!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });

		// The transcript is replaced wholesale (regen / undo) before the
		// debounce fires: the burst was typed against the OLD word rows and
		// must be dropped, not replayed over the replacement.
		view.rerender(paneElement({ onEditTranscriptText, transcript: replaced }));
		await flushTextEdit();
		expect(onEditTranscriptText).not.toHaveBeenCalled();
		expect(editor.textContent).toBe("Brand new words");
	});

	it("keeps the pending burst when a save fails and the editor has focus, retrying once", async () => {
		const onEditTranscriptText = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		renderPane({ onEditTranscriptText });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		editor.focus();
		editor.textContent = "Hello brave world!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });

		await act(async () => {
			vi.advanceTimersByTime(300);
			await Promise.resolve();
		});
		// First attempt failed: the focused editor keeps its text and the
		// pending burst for the retry.
		expect(editor.textContent).toBe("Hello brave world!");
		expect(onEditTranscriptText).toHaveBeenCalledTimes(1);

		await act(async () => {
			vi.advanceTimersByTime(1100);
			await Promise.resolve();
		});
		expect(onEditTranscriptText).toHaveBeenCalledTimes(2);
		expect(onEditTranscriptText).toHaveBeenLastCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Hello brave world!",
		);
	});

	it("reverts an unfocused editor when its save fails", async () => {
		const onEditTranscriptText = vi.fn(async () => false);
		renderPane({ onEditTranscriptText });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		// No focus(): the user has moved on to another control.
		editor.textContent = "unsaved text";
		fireEvent.input(editor, { inputType: "insertText" });
		await flushTextEdit();

		// Reverted to the committed projection — text mode's own rendering of
		// it, paragraph break included.
		expect(editor.textContent).toBe("Hello\n\nbrave world");
	});

	it("flushes an unsaved burst on unmount", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		const { unmount } = renderPane({ onEditTranscriptText });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		editor.textContent = "Hello brave world!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });
		// Unmount BEFORE the 250ms debounce fires.
		unmount();
		await act(async () => {
			await Promise.resolve();
		});

		expect(onEditTranscriptText).toHaveBeenCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Hello brave world!",
		);
	});

	it("flushes a pending burst immediately when leaving text mode", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		renderPane({ onEditTranscriptText });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		editor.textContent = "Hello brave world!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });
		fireEvent.click(screen.getByRole("button", { name: "Cut selected video" }));
		await act(async () => {
			vi.advanceTimersByTime(0);
			await Promise.resolve();
		});

		expect(onEditTranscriptText).toHaveBeenCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Hello brave world!",
		);
	});

	it("flushes a pending burst immediately when the editor loses focus", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		renderPane({ onEditTranscriptText });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		editor.focus();
		editor.textContent = "Hello brave world!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });
		fireEvent.blur(editor);
		await act(async () => {
			vi.advanceTimersByTime(0);
			await Promise.resolve();
		});

		expect(onEditTranscriptText).toHaveBeenCalledWith(
			"asset_1",
			["w1", "w2", "w3"],
			"Hello brave world!",
		);
	});

	it("clears the pending burst when the user undoes their own typing", async () => {
		const onEditTranscriptText = vi.fn(async () => true);
		renderPane({ onEditTranscriptText, trimRanges: [] });
		fireEvent.click(screen.getByRole("button", { name: "Transcript text" }));
		const editor = screen.getByRole("textbox");
		editor.textContent = "Hello brave world!";
		fireEvent.input(editor, { inputType: "insertText", data: "!" });
		// Undo by hand before the debounce fires: the pending text now equals
		// the committed projection ("Hello\n\nbrave world"), so nothing is
		// saved and the view is restored to the projection's own rendering.
		editor.textContent = "Hello\n\nbrave world";
		fireEvent.input(editor, { inputType: "deleteContentBackward" });
		await flushTextEdit();
		expect(onEditTranscriptText).not.toHaveBeenCalled();
		expect(editor.textContent).toBe("Hello\n\nbrave world");
	});
});
