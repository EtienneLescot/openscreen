// Six right-rail panes matching design/openscreen-editor.html. Each control
// reads from + writes to the project document via `useEditorSettings`, so the
// design's UI is the canonical surface (no more "more options" link to a
// legacy panel — the legacy SettingsPanel is still available to the legacy
// VideoEditor and to per-region inspectors, but the panes here are
// self-sufficient).

import {
	Crop as CropIcon,
	FileText,
	HelpCircle,
	Layout as LayoutIcon,
	MousePointerClick,
	Palette,
	Sliders,
	Trash2,
} from "lucide-react";
import {
	type ChangeEvent,
	type FormEvent,
	type ClipboardEvent as ReactClipboardEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import defaultCursorPreviewUrl from "@/assets/cursors/Cursor=Default.svg";
import GradientEditor, { type GradientEditorState } from "@/components/ui/gradient-editor";
import type {
	AxcutAsset,
	AxcutClip,
	AxcutTranscript,
	AxcutTrimRange,
	AxcutWord,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import {
	buildAggregatedSections,
	type ClipSection,
	type ClipWord,
	findCueWordId,
	isSilenceWord,
	type TrimRun,
} from "@/lib/ai-edition/timeline/aggregated-transcript";
import { hasAnyClipWithCamera } from "@/lib/ai-edition/timeline/camera";
import { formatMs } from "@/lib/ai-edition/timeline/format";
import { locateVirtualPosition } from "@/lib/ai-edition/timeline/virtual-preview";
import { getAssetPath } from "@/lib/assetPath";
import { CURSOR_THEMES, DEFAULT_CURSOR_THEME_ID } from "@/lib/cursor/cursorThemes";
import { buildGradientFromEditor } from "@/lib/gradientBuilder";
import { resolveImageWallpaperUrl, WALLPAPER_PATHS } from "@/lib/wallpaper";
import { isNativeCompositorActive, setNativeParam, subscribeNativeCompositor } from "@/native";
import styles from "./NewEditorShell.module.css";

export type RightPaneId =
	| "background"
	| "transcript"
	| "effects"
	| "layout"
	| "cursor"
	| "timeline";

interface PaneProps {
	title: string;
	icon: ReactNode;
	helpLabel?: string;
	// P3.3 — contextual help shown in a popover when the ? button is clicked.
	helpText?: string;
	children: ReactNode;
}

function Pane({ title, icon, helpLabel, helpText, children }: PaneProps) {
	const [helpOpen, setHelpOpen] = useState(false);
	return (
		<div className={`${styles.pane} ${styles.isActive}`}>
			<header className={styles.paneHead} style={{ position: "relative" }}>
				<h2>{title}</h2>
				<span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
					<button
						type="button"
						className={styles.iconBtn}
						title={helpLabel ?? "Help"}
						aria-label={helpLabel ?? "Help"}
						aria-expanded={helpOpen}
						onClick={() => setHelpOpen((v) => !v)}
					>
						<HelpCircle size={14} />
					</button>
				</span>
				<span style={{ display: "none" }}>{icon}</span>
				{helpOpen ? (
					<div
						role="note"
						style={{
							position: "absolute",
							top: "calc(100% + 4px)",
							right: 8,
							zIndex: 60,
							maxWidth: 240,
							padding: "10px 12px",
							background: "var(--surface)",
							border: "1px solid var(--border)",
							borderRadius: "var(--r-md)",
							boxShadow: "var(--elev-pop)",
							color: "var(--fg-2)",
							font: "400 12px/1.5 var(--font-body)",
						}}
						onClick={() => setHelpOpen(false)}
					>
						{helpText ?? `Settings for ${title.toLowerCase()}.`}
					</div>
				) : null}
			</header>
			<div className={styles.paneBody}>{children}</div>
		</div>
	);
}

// ─── Background ────────────────────────────────────────────────────

// keep the gradient palette small and curated — every block renders
// in the picker and gets serialized to legacyEditor on save.
const GRAD_PRESETS: readonly string[] = [
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #10b981, #eaebed)",
	"linear-gradient(135deg, #6b7280, #bcc0c6)",
	"linear-gradient(135deg, #eaebed, #10b981)",
	"linear-gradient(135deg, #16171d, #6b7280)",
	"linear-gradient(135deg, #bcc0c6, #16171d)",
	"linear-gradient(135deg, #10b981, #6b7280)",
	"linear-gradient(135deg, #eaebed, #10b981)",
	"linear-gradient(135deg, #6b7280, #16171d)",
	"linear-gradient(135deg, #bcc0c6, #10b981)",
	"linear-gradient(135deg, #16171d, #6b7280)",
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #10b981, #bcc0c6)",
	"linear-gradient(135deg, #eaebed, #16171d)",
	"linear-gradient(135deg, #6b7280, #10b981)",
	"linear-gradient(135deg, #bcc0c6, #eaebed)",
];

const COLOR_PALETTE: readonly string[] = [
	"#16171d",
	"#6b7280",
	"#bcc0c6",
	"#eaebed",
	"#ffffff",
	"#10b981",
	"#0ea371",
	"#34d399",
	"#f59e0b",
	"#ef4444",
	"#3b82f6",
	"#8b5cf6",
	"#ec4899",
	"#f97316",
	"#22c55e",
	"#1e293b",
];

const IMAGE_ACCEPT = ".jpg,.jpeg,.png,image/jpeg,image/png";

// Wallpaper picker — image / solid color / gradient tabs.
//
// Wallpapers round-trip through the legacyEditor envelope exactly as they did
// in the v2 editor: gradient strings stay as-is, colors as `#hex`, and image
// paths are restricted to `/wallpapers/...` or the user's own data: URLs from
// the upload custom flow.
export function BackgroundPane() {
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();
	const [tab, setTab] = useState<"image" | "color" | "gradient">("image");
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const customUrls = useMemoCustomWallpapers(settings.wallpaper);

	// The custom gradient editor emits continuously while the user drags a
	// color point / angle knob / brightness slider, so mirror the SliderCell
	// model: preview live with setLive, then persist once the changes settle.
	const gradientCommitTimer = useRef<number | null>(null);
	const handleGradientChange = useCallback(
		(state: GradientEditorState) => {
			setLive({ wallpaper: buildGradientFromEditor(state) });
			if (gradientCommitTimer.current !== null) {
				window.clearTimeout(gradientCommitTimer.current);
			}
			gradientCommitTimer.current = window.setTimeout(() => {
				gradientCommitTimer.current = null;
				void commit();
			}, 400);
		},
		[setLive, commit],
	);
	useEffect(
		() => () => {
			if (gradientCommitTimer.current !== null) {
				window.clearTimeout(gradientCommitTimer.current);
			}
		},
		[],
	);

	const isSelected = (value: string) => settings.wallpaper === value;

	const handleTabChange = (next: "image" | "color" | "gradient") => {
		setTab(next);
	};

	const handlePickFile = () => {
		if (!hasDocument) return;
		fileInputRef.current?.click();
	};

	const handleFileSelected = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		if (!file.type.startsWith("image/")) return;
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = typeof reader.result === "string" ? reader.result : "";
			if (!dataUrl) return;
			void set({ wallpaper: dataUrl });
		};
		reader.readAsDataURL(file);
	};

	return (
		<Pane
			title="Background"
			icon={<Palette size={14} />}
			helpText="Choose what appears behind the recording: a bundled wallpaper image, a solid color, a gradient, or a custom image from disk."
		>
			<div className={styles.paneTabs} role="tablist">
				<button
					type="button"
					className={tab === "image" ? styles.isActive : ""}
					onClick={() => handleTabChange("image")}
				>
					Image
				</button>
				<button
					type="button"
					className={tab === "color" ? styles.isActive : ""}
					onClick={() => handleTabChange("color")}
				>
					Color
				</button>
				<button
					type="button"
					className={tab === "gradient" ? styles.isActive : ""}
					onClick={() => handleTabChange("gradient")}
				>
					Gradient
				</button>
			</div>
			{tab === "image" ? (
				<>
					<button
						type="button"
						className={styles.uploadBtn}
						disabled={!hasDocument}
						onClick={handlePickFile}
					>
						Upload custom
					</button>
					<input
						ref={fileInputRef}
						type="file"
						accept={IMAGE_ACCEPT}
						style={{ display: "none" }}
						onChange={handleFileSelected}
					/>
					<div className={styles.bgGrid}>
						{customUrls.map((url) => (
							<button
								type="button"
								key={`custom-${url.slice(-32)}`}
								className={`${styles.bgThumb} ${isSelected(url) ? styles.isActive : ""}`}
								style={{ background: `center/cover no-repeat url(${url})` }}
								aria-label="Custom wallpaper"
								disabled={!hasDocument}
								onClick={() => void set({ wallpaper: url })}
							/>
						))}
						{WALLPAPER_PATHS.map((path, i) => {
							const previewUrl = resolveImageWallpaperUrl(path);
							return (
								<button
									type="button"
									key={path}
									className={`${styles.bgThumb} ${isSelected(path) ? styles.isActive : ""}`}
									style={{ background: `center/cover no-repeat url(${previewUrl})` }}
									aria-label={`Background ${i + 1}`}
									disabled={!hasDocument}
									onClick={() => void set({ wallpaper: path })}
								/>
							);
						})}
					</div>
				</>
			) : tab === "color" ? (
				<BackgroundColorTab
					value={settings.wallpaper}
					hasDocument={hasDocument}
					isSelected={isSelected}
					onPick={(color) => void set({ wallpaper: color })}
				/>
			) : (
				<>
					<div className={styles.bgGrid}>
						{GRAD_PRESETS.map((bg, i) => (
							<button
								type="button"
								key={bg}
								className={`${styles.bgThumb} ${isSelected(bg) ? styles.isActive : ""}`}
								style={{ background: bg }}
								aria-label={`Gradient ${i + 1}`}
								disabled={!hasDocument}
								onClick={() => void set({ wallpaper: bg })}
							/>
						))}
					</div>
					{hasDocument ? <GradientEditor onChange={handleGradientChange} /> : null}
				</>
			)}
		</Pane>
	);
}

// keep the user's last data: URL after they switch tabs so the Image
// tab can keep showing it without immediately pushing it back through `set`.
function useMemoCustomWallpapers(current: string): string[] {
	const [cached, setCached] = useState<string[]>([]);
	const lastValue = useRef(current);
	useEffect(() => {
		if (current.startsWith("data:")) {
			setCached((prev) => {
				if (prev[0] === current) return prev;
				return [current, ...prev.filter((u) => u !== current)].slice(0, 6);
			});
		}
		lastValue.current = current;
	}, [current]);
	return cached;
}

function BackgroundColorTab({
	value,
	hasDocument,
	isSelected,
	onPick,
}: {
	value: string;
	hasDocument: boolean;
	isSelected: (v: string) => boolean;
	onPick: (next: string) => void;
}) {
	const [hexDraft, setHexDraft] = useState(value.startsWith("#") ? value : "#000000");
	useEffect(() => {
		if (value.startsWith("#")) setHexDraft(value);
	}, [value]);
	const commitHex = () => {
		const next = normaliseHex(hexDraft);
		if (next) {
			onPick(next);
			if (isNativeCompositorActive()) {
				setNativeParam("backgroundColor", next);
			}
		}
	};
	return (
		<>
			<div className={styles.bgGrid} style={{ margin: "0 var(--sp-4) 12px" }}>
				{COLOR_PALETTE.map((c) => (
					<button
						type="button"
						key={c}
						className={`${styles.bgThumb} ${isSelected(c) ? styles.isActive : ""}`}
						style={{ background: c }}
						aria-label={`Color ${c}`}
						disabled={!hasDocument}
						onClick={() => {
							onPick(c);
							if (isNativeCompositorActive()) {
								setNativeParam("backgroundColor", c);
							}
						}}
					/>
				))}
			</div>
			<div
				style={{
					margin: "0 var(--sp-4) 12px",
					display: "flex",
					alignItems: "center",
					gap: 8,
				}}
			>
				<input
					type="color"
					value={hexDraft}
					disabled={!hasDocument}
					onChange={(e) => setHexDraft(e.target.value)}
					onBlur={commitHex}
					style={{
						width: 48,
						height: 36,
						border: "1px solid var(--border)",
						borderRadius: 8,
						background: "var(--surface)",
						padding: 0,
					}}
				/>
				<input
					type="text"
					value={hexDraft}
					disabled={!hasDocument}
					onChange={(e) => setHexDraft(e.target.value)}
					onBlur={commitHex}
					onKeyDown={(e) => {
						if (e.key === "Enter") commitHex();
					}}
					style={{
						flex: 1,
						height: 36,
						border: "1px solid var(--border)",
						borderRadius: 8,
						background: "var(--surface)",
						padding: "0 12px",
						color: "var(--fg-2)",
						font: "500 13px var(--font-mono)",
					}}
				/>
			</div>
		</>
	);
}

function normaliseHex(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
	if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(withHash)) return null;
	return withHash.toLowerCase();
}

// ─── Transcript ────────────────────────────────────────────────────
// Aggregated transcript view: one contentEditable region per clip on the
// timeline, in timeline order. Each word is rendered as a `<span
// data-word-id>` inside the editable div. Words inside any `trimRange`
// for the clip's asset are styled red+strikethrough and show a bin icon
// on hover (removing the skip restores them). User actions:
//
//   - Click on a word    → seek (timeline.playhead)
//   - Backspace / Delete → convert selection (or caret-adjacent word)
//                          into a new trimRange (the document's
//                          `timeline.trimRanges[]`, NOT the transcript
//                          text). The deleted word stays in the DOM as
//                          red text — nothing destructive.
//
// Mirrors axcut's apps/web/src/components/CurrentTranscriptView.tsx.
export function TranscriptPane({
	clips,
	transcripts,
	assets,
	trimRanges,
	busy,
	currentTimeSec,
	onSeek,
	onAddTrimRange,
	onRemoveTrimRange,
	onTranscribe,
	canTranscribe,
	isTranscribing,
}: {
	clips: AxcutClip[];
	transcripts: AxcutTranscript[];
	assets: AxcutAsset[];
	trimRanges: AxcutTrimRange[];
	busy: boolean;
	currentTimeSec: number;
	onSeek: (sec: number) => void;
	onAddTrimRange: (assetId: string, startSec: number, endSec: number, reason: string) => void;
	onRemoveTrimRange: (trimId: string) => void;
	onTranscribe: () => void;
	canTranscribe: boolean;
	isTranscribing: boolean;
}) {
	const sections = useMemo(
		() => buildAggregatedSections(clips, transcripts, assets, trimRanges),
		[clips, transcripts, assets, trimRanges],
	);

	// the cue position is the playback head's location in the
	// current clip's source time. `locateVirtualPosition` already accounts
	// for skip ranges and clipped durations — the cue word naturally
	// jumps over gaps the user has trimmed.
	const cue = useMemo(() => {
		if (clips.length === 0) return null;
		const position = locateVirtualPosition(clips, currentTimeSec);
		if (!position) return null;
		return {
			assetId: position.clip.assetId,
			clipId: position.clip.id,
			sourceTimeSec: position.sourceTimeSec,
		};
	}, [clips, currentTimeSec]);

	const cueWordId = useMemo(() => findCueWordId(sections, cue), [sections, cue]);

	const hasAnyTranscript = transcripts.length > 0;

	if (clips.length === 0 || !hasAnyTranscript) {
		return (
			<Pane
				title="Current transcription"
				icon={<FileText size={14} />}
				helpText="Aggregated transcript of every clip on the timeline. Backspace / Delete a word or selection to mark it as skipped (red). Hover a red span to restore it."
			>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						padding: 32,
						gap: 12,
						color: "var(--muted)",
						textAlign: "center",
					}}
				>
					<FileText size={28} style={{ color: "var(--dim)" }} />
					<p style={{ font: "500 13px var(--font-body)", color: "var(--fg-2)" }}>
						{clips.length === 0 ? "No clips yet" : "No transcript yet"}
					</p>
					<p style={{ font: "400 12px var(--font-body)", color: "var(--muted)", maxWidth: 260 }}>
						Transcribe uses local Whisper — runs in your browser, no data leaves the device.
					</p>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={onTranscribe}
						disabled={!canTranscribe || isTranscribing}
					>
						{isTranscribing ? "Transcribing…" : "Transcribe now"}
					</button>
				</div>
			</Pane>
		);
	}

	return (
		<div className={`${styles.pane} ${styles.isActive}`}>
			<header className={styles.paneHead}>
				<h2>Current transcription</h2>
			</header>
			<div className={styles.paneBody}>
				{sections.map((section, idx) => (
					<TranscriptClipBlock
						key={section.clip.id}
						index={idx}
						section={section}
						busy={busy}
						cueWordId={cueWordId}
						onSeek={onSeek}
						onAddTrimRange={onAddTrimRange}
						onRemoveTrimRange={onRemoveTrimRange}
					/>
				))}
			</div>
		</div>
	);
}

// One contentEditable block per clip — header (vignette + filename +
// range) and a flowing word stream. The stream contains every transcript
// word inside the clip's source range, color-coded by whether the word
// is inside any trimRange. Backspace/Delete adds a new trimRange via
// onAddTrimRange; hover-bin on a skip run removes it via onRemoveTrimRange.
function TranscriptClipBlock({
	index,
	section,
	busy,
	cueWordId,
	onSeek,
	onAddTrimRange,
	onRemoveTrimRange,
}: {
	index: number;
	section: ClipSection;
	busy: boolean;
	cueWordId: string | null;
	onSeek: (sec: number) => void;
	onAddTrimRange: (assetId: string, startSec: number, endSec: number, reason: string) => void;
	onRemoveTrimRange: (trimId: string) => void;
}) {
	const { clip, asset, words } = section;
	const filename = asset?.label ?? clip.assetId;
	const sourceRangeLabel =
		clip.sourceEndSec !== undefined
			? `${formatMs(clip.sourceStartSec * 1000)}—${formatMs(clip.sourceEndSec * 1000)}`
			: `${formatMs(clip.sourceStartSec * 1000)}—`;

	const editorRef = useRef<HTMLDivElement | null>(null);
	const pendingCaretWordIdRef = useRef<string | null>(null);

	// auto-scroll the cue word into view as the playback head
	// moves. The right pane has ONE scroll container (paneBody, which
	// already has overflow-y: auto) — the per-clip editor itself is not
	// scrollable, so the cue scroll always lands on the paneBody.
	// Mirrors axcut's `scrollCueWordIntoView` in CurrentTranscriptView
	// (margins keep the highlighted word clear of the editor's edges).
	const SCROLL_MARGIN_PX = 56;
	useLayoutEffect(() => {
		const editor = editorRef.current;
		if (!editor || !cueWordId) return;
		const wordElement = editor.querySelector<HTMLElement>(`[data-word-id="${cueWordId}"]`);
		if (!wordElement) return;
		// walk up to the first scrollable ancestor (paneBody)
		// and scroll so the word element lands inside its viewport.
		let ancestor: HTMLElement | null = wordElement.parentElement;
		while (ancestor && ancestor !== document.body) {
			const style = globalThis.getComputedStyle(ancestor);
			const overflowY = style.overflowY;
			if (overflowY === "auto" || overflowY === "scroll") {
				const ancestorRect = ancestor.getBoundingClientRect();
				const wordRect = wordElement.getBoundingClientRect();
				if (
					wordRect.top >= ancestorRect.top + SCROLL_MARGIN_PX &&
					wordRect.bottom <= ancestorRect.bottom - SCROLL_MARGIN_PX
				) {
					return;
				}
				if (wordRect.top < ancestorRect.top + SCROLL_MARGIN_PX) {
					ancestor.scrollTop -= ancestorRect.top + SCROLL_MARGIN_PX - wordRect.top;
				} else if (wordRect.bottom > ancestorRect.bottom - SCROLL_MARGIN_PX) {
					ancestor.scrollTop += wordRect.bottom - (ancestorRect.bottom - SCROLL_MARGIN_PX);
				}
				return;
			}
			ancestor = ancestor.parentElement;
		}
	}, [cueWordId]);

	// keep the caret anchored to the next kept word after a
	// trimRange is added (so the user can keep deleting without the caret
	// jumping to the start of the block).
	useLayoutEffect(() => {
		const wordId = pendingCaretWordIdRef.current;
		if (!wordId) return;
		pendingCaretWordIdRef.current = null;
		restoreCaretBeforeWord(editorRef.current, wordId);
	});

	const skipWordRange = useCallback(
		(rangeWords: ClipWord[]) => {
			if (busy || rangeWords.length === 0) return;
			// Only skip words that are currently kept (don't double-skip).
			const keptRange = rangeWords.filter((w) => w.kept);
			if (keptRange.length === 0) return;
			pendingCaretWordIdRef.current = keptRange[0].word.id;
			const startSec = Math.min(...keptRange.map((w) => w.word.startSec));
			const endSec = Math.max(...keptRange.map((w) => w.word.endSec));
			onAddTrimRange(
				clip.assetId,
				startSec,
				endSec,
				`Skip ${formatMs(startSec * 1000)}-${formatMs(endSec * 1000)} from ${clip.assetId}.`,
			);
		},
		[busy, clip.assetId, onAddTrimRange],
	);

	const removeTrimRun = useCallback(
		(run: TrimRun) => {
			if (busy || !run.trimId) return;
			onRemoveTrimRange(run.trimId);
		},
		[busy, onRemoveTrimRange],
	);

	const cutNativeSelection = useCallback(
		(direction: "backward" | "forward") => {
			const editor = editorRef.current;
			const selection = globalThis.getSelection();
			if (!selection || !editor) return false;
			if (!editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) {
				return false;
			}
			if (selection.isCollapsed) {
				const wordId = findCollapsedDeletionWordId(
					editor,
					selection.anchorNode,
					selection.anchorOffset,
					direction,
					words,
				);
				if (!wordId) return false;
				const cw = words.find((w) => w.word.id === wordId);
				if (!cw) return false;
				skipWordRange([cw]);
				return true;
			}
			// for a non-collapsed selection, the anchor/focus
			// already identify the endpoints — no need to apply the
			// "Backspace at start of word" / "Delete at end of word"
			// boundary heuristic (that fallback is for collapsed carets
			// only — it would return the previous/next word here and
			// shrink the trim range to a few words at the selection
			// boundary). Use findWordId directly to get the word
			// containing each endpoint.
			const anchorId = findWordId(selection.anchorNode);
			const focusId = findWordId(selection.focusNode);
			if (!anchorId || !focusId) return false;
			const fromIdx = words.findIndex((w) => w.word.id === anchorId);
			const toIdx = words.findIndex((w) => w.word.id === focusId);
			if (fromIdx < 0 || toIdx < 0) return false;
			const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
			skipWordRange(words.slice(lo, hi + 1));
			return true;
		},
		[skipWordRange, words],
	);

	const handleKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (event.key !== "Backspace" && event.key !== "Delete") return;
			event.preventDefault();
			cutNativeSelection(event.key === "Backspace" ? "backward" : "forward");
		},
		[cutNativeSelection],
	);

	const handleBeforeInput = useCallback(
		(event: FormEvent<HTMLDivElement>) => {
			const inputEvent = event.nativeEvent as InputEvent;
			if (inputEvent.inputType.startsWith("delete")) {
				event.preventDefault();
				cutNativeSelection(
					inputEvent.inputType === "deleteContentForward" ? "forward" : "backward",
				);
				return;
			}
			// typing/pasting free text is non-destructive by design
			// (the user's transcript edits come via the Source Transcript
			// modal, not here). Block inserts to keep the projection stable.
			if (inputEvent.inputType === "insertText" || inputEvent.inputType === "insertFromPaste") {
				event.preventDefault();
			}
		},
		[cutNativeSelection],
	);

	const handlePaste = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
		event.preventDefault();
	}, []);

	const handlePointerUp = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			// a click on the trim-pill button (bin) bubbles up here
			// before the button's onClick fires. Skip those — the bin's own
			// handler is responsible for restoring the skip range.
			if (event.target instanceof Element && event.target.closest("button")) return;
			const editor = editorRef.current;
			if (!editor) return;
			const selection = globalThis.getSelection();
			if (selection && !selection.isCollapsed) return; // user is selecting text — let them

			// clicks land on the deepest element under the cursor,
			// which is usually the text node inside a word span. Text nodes
			// don't have `closest`, and a non-filler word's text is rendered
			// as a bare text node (no inner span). Walk up to an Element
			// first, then look for the enclosing word span.
			const targetEl =
				event.target instanceof Element
					? event.target
					: event.target instanceof Text
						? (event.target.parentElement ?? null)
						: null;
			if (!targetEl) return;
			const wordEl = targetEl.closest<HTMLElement>("[data-word-id]");
			if (!wordEl?.dataset.wordId) return;
			const cw = words.find((w) => w.word.id === wordEl.dataset.wordId);
			if (!cw) return;
			onSeek(cw.word.startSec);
		},
		[onSeek, words],
	);

	return (
		<span
			style={{
				display: "block",
				marginBottom: 16,
			}}
		>
			<span
				style={{
					display: "flex",
					alignItems: "center",
					gap: 10,
					padding: "0 4px 4px",
					borderBottom: "1px solid var(--border-soft)",
					marginBottom: 6,
				}}
			>
				<span
					style={{
						width: 22,
						height: 22,
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						background: "var(--accent-soft)",
						color: "var(--accent)",
						borderRadius: "var(--r-sm)",
						font: "700 12px/1 var(--font-mono)",
						flexShrink: 0,
					}}
				>
					{index + 1}
				</span>
				<span style={{ minWidth: 0, flex: 1 }}>
					<span
						style={{
							display: "block",
							font: "600 13px/1.2 var(--font-body)",
							color: "var(--fg)",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
					>
						{filename}
					</span>
					<span
						style={{
							display: "block",
							font: "400 11px/1.3 var(--font-mono)",
							color: "var(--muted)",
							marginTop: 2,
						}}
					>
						Clip {index + 1} · {sourceRangeLabel}
					</span>
				</span>
			</span>
			{words.length === 0 ? (
				<p
					style={{
						margin: 0,
						padding: "4px 4px",
						font: "400 12px/1.5 var(--font-body)",
						color: "var(--muted)",
						fontStyle: "italic",
					}}
				>
					No transcript for this clip — open the asset card and regenerate.
				</p>
			) : (
				<div
					ref={editorRef}
					role="textbox"
					tabIndex={0}
					contentEditable={!busy}
					suppressContentEditableWarning
					spellCheck={false}
					aria-label={`Transcript for ${filename}`}
					aria-multiline="true"
					onBeforeInput={handleBeforeInput}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					onPointerUp={handlePointerUp}
					style={{
						padding: "4px 4px",
						font: "400 13px/1.65 var(--font-body)",
						color: "var(--fg)",
						textWrap: "pretty",
						cursor: "text",
						outline: "none",
						// no overflow on the per-clip editor — the
						// parent paneBody (already overflow-y: auto) is the
						// single scroll container for the whole transcript.
						// Scrolling within the editor would create a nested
						// scrollbar that breaks the cue auto-scroll UX.
					}}
				>
					{words.map((cw) => (
						<TranscriptWord
							key={cw.word.id}
							cw={cw}
							isCue={cw.word.id === cueWordId}
							assetId={clip.assetId}
							onRestore={removeTrimRun}
							onAddTrimRange={onAddTrimRange}
						/>
					))}
				</div>
			)}
		</span>
	);
}

// One word inside the editable block. Kept words render plain; removed
// words (inside a skip range) render red+strikethrough with a hover bin.
// `isCue` highlights the word the playback head is currently inside with
// an accent underline (matches axcut's `word.transcript-word.cue` rule).
function TranscriptWord({
	cw,
	isCue,
	assetId,
	onRestore,
	onAddTrimRange,
}: {
	cw: ClipWord;
	isCue: boolean;
	assetId: string;
	onRestore: (run: TrimRun) => void;
	onAddTrimRange: (assetId: string, startSec: number, endSec: number, reason: string) => void;
}) {
	const [hover, setHover] = useState(false);
	const removed = !cw.kept;

	if (isSilenceWord(cw.word)) {
		const durationSec = cw.word.endSec - cw.word.startSec;
		const label = `[silence ${durationSec.toFixed(1)}s]`;
		if (removed) {
			return (
				<button
					type="button"
					contentEditable={false}
					data-word-id={cw.word.id}
					data-silence="true"
					title={`Restore silence (${durationSec.toFixed(1)}s)`}
					aria-label={`Restore silence (${durationSec.toFixed(1)}s)`}
					onClick={(e) => {
						e.stopPropagation();
						onRestore({
							trimId: cw.trimId ?? "",
							assetId: "",
							startWordIndex: 0,
							endWordIndex: 0,
							durationSec: 0,
						});
					}}
					style={{
						display: "inline-flex",
						alignItems: "center",
						margin: "0 3px 2px 0",
						padding: "1px 6px",
						borderRadius: 999,
						border: "1px solid var(--danger)",
						background: "var(--danger-soft)",
						color: "var(--danger)",
						font: "600 11px/1.5 var(--font-mono)",
						textDecoration: "line-through",
						cursor: "pointer",
					}}
				>
					{label}
				</button>
			);
		}
		return (
			<button
				type="button"
				contentEditable={false}
				data-word-id={cw.word.id}
				data-silence="true"
				title={`Trim silence (${durationSec.toFixed(1)}s)`}
				aria-label={`Trim silence (${durationSec.toFixed(1)}s)`}
				onClick={(e) => {
					e.stopPropagation();
					onAddTrimRange(
						assetId,
						cw.word.startSec,
						cw.word.endSec,
						`Skip silence ${formatMs(cw.word.startSec * 1000)}-${formatMs(cw.word.endSec * 1000)}.`,
					);
				}}
				style={{
					display: "inline-flex",
					alignItems: "center",
					margin: "0 3px 2px 0",
					padding: "1px 6px",
					borderRadius: 999,
					border: "1px dashed var(--border-hi)",
					background: "transparent",
					color: "var(--muted)",
					font: "500 11px/1.5 var(--font-mono)",
					cursor: "pointer",
				}}
			>
				{label}
			</button>
		);
	}

	return (
		<span
			data-word-id={cw.word.id}
			data-start-sec={cw.word.startSec}
			data-end-sec={cw.word.endSec}
			data-skip-id={cw.trimId ?? undefined}
			data-cue={isCue ? "true" : undefined}
			style={{
				display: "inline",
				color: removed ? "var(--danger)" : "var(--fg)",
				fontWeight: removed ? 600 : 400,
				textDecoration: removed ? "line-through" : "none",
				textDecorationColor: removed ? "var(--danger)" : undefined,
				opacity: removed ? 0.9 : 1,
				borderBottom: isCue ? "2px solid var(--accent)" : "none",
				paddingBottom: isCue ? 1 : 0,
			}}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
		>
			{/* no filler chip. axcut renders every word the same way;
			    the LLM is the only place that names a word a filler (via the
			    filler_or_hesitation reason when generating suggestions). */}
			{cw.word.text}{" "}
			{removed && hover && cw.trimId ? (
				<button
					type="button"
					contentEditable={false}
					title={`Restore "${cw.word.text}"`}
					aria-label={`Restore "${cw.word.text}"`}
					onClick={(e) => {
						e.stopPropagation();
						// build a minimal TrimRun stub — only trimId is
						// read by onRestore.
						onRestore({
							trimId: cw.trimId ?? "",
							assetId: "",
							startWordIndex: 0,
							endWordIndex: 0,
							durationSec: 0,
						});
					}}
					style={{
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						width: 18,
						height: 18,
						marginLeft: 4,
						padding: 0,
						border: 0,
						borderRadius: 4,
						background: "var(--danger)",
						color: "white",
						cursor: "pointer",
						verticalAlign: "middle",
					}}
				>
					<Trash2 size={12} strokeWidth={1.9} aria-hidden="true" />
				</button>
			) : null}
		</span>
	);
}

// ─── Caret / selection helpers ────────────────────────────────────
// Ponytail port of axcut's findCollapsedDeletionWordId. The non-collapsed
// path uses findWordId directly (a range selection's endpoints already
// identify the boundary words — no boundary heuristic needed).

function findWordId(node: Node | null): string | null {
	const element = node instanceof Element ? node : node?.parentElement;
	return element?.closest<HTMLElement>("[data-word-id]")?.dataset.wordId ?? null;
}

function findCollapsedDeletionWordId(
	editor: HTMLElement,
	node: Node | null,
	offset: number,
	direction: "backward" | "forward",
	words: ClipWord[],
): string | null {
	// read the kept/skip state from the words array, not the
	// DOM's data-skip-id. The DOM may be lagging a render behind (its
	// trimId is only set on the next React commit), so a DOM check would
	// re-trim an already-trimmed word. The words array is the React state
	// captured at the call site — always current.
	const skippedIds = new Set(words.filter((w) => !w.kept).map((w) => w.word.id));

	const direct = closestWordElement(node);
	if (direct) {
		const textLength = node?.textContent?.length ?? 0;
		if (node?.nodeType === Node.TEXT_NODE) {
			if (direction === "backward" && offset <= 0) {
				// clicking at the start of a word normally deletes
				// the previous word, but when the previous word is already
				// trimmed, that would be a no-op. Fall back to the current
				// word so Backspace always does something.
				const prev = adjacentWordId(editor, direct, "backward");
				if (prev && !skippedIds.has(prev)) {
					return prev;
				}
				return direct.dataset.wordId ?? null;
			}
			if (direction === "forward" && offset >= textLength) {
				const next = adjacentWordId(editor, direct, "forward");
				if (next && !skippedIds.has(next)) {
					return next;
				}
				return direct.dataset.wordId ?? null;
			}
		}
		return direct.dataset.wordId ?? null;
	}
	if (!node) return null;
	const wordNodes = Array.from(editor.querySelectorAll<HTMLElement>("[data-word-id]"));
	if (wordNodes.length === 0) return null;
	const boundaryNode = node instanceof Element ? node : node.parentElement;
	if (!boundaryNode) return null;
	const childNodes = Array.from(boundaryNode.childNodes);

	// when restoreCaretBeforeWord places the caret before word W
	// (via setStartBefore), `anchorNode` becomes the parent div and
	// `anchorOffset` is W's index. The naive "previous sibling" lookup
	// below would always return the word that was *just* trimmed, which
	// is a no-op (the previous word is already skipped). The user
	// expects Backspace at the start of W to delete W. So when the
	// previous adjacent word is already trimmed, fall forward to W.
	if (direction === "backward" && node instanceof Element && node === editor) {
		const idx = Math.max(0, Math.min(offset, wordNodes.length) - 1);
		const previousWordId = wordNodes[idx]?.dataset.wordId ?? null;
		if (previousWordId && skippedIds.has(previousWordId)) {
			return wordNodes[idx]?.dataset.wordId ?? null;
		}
	}

	const candidates =
		direction === "backward" ? childNodes.slice(0, offset).reverse() : childNodes.slice(offset);
	for (const candidate of candidates) {
		const wordId = findWordId(candidate) ?? findDescendantWordId(candidate);
		if (wordId) return wordId;
	}
	const range = globalThis.document.createRange();
	range.setStart(editor, 0);
	range.setEnd(node, clampRangeOffset(node, offset));
	const wordsBefore = wordNodes.filter((wordNode) => range.comparePoint(wordNode, 0) <= 0);
	return direction === "backward"
		? (wordsBefore.at(-1)?.dataset.wordId ?? null)
		: (wordNodes.find((wordNode) => !wordsBefore.includes(wordNode))?.dataset.wordId ?? null);
}

function findDescendantWordId(node: Node): string | null {
	if (node instanceof HTMLElement && node.dataset.wordId) {
		return node.dataset.wordId;
	}
	return node instanceof Element
		? (node.querySelector<HTMLElement>("[data-word-id]")?.dataset.wordId ?? null)
		: null;
}

function closestWordElement(node: Node | null): HTMLElement | null {
	const element = node instanceof Element ? node : node?.parentElement;
	return element?.closest<HTMLElement>("[data-word-id]") ?? null;
}

function adjacentWordId(
	editor: HTMLElement,
	wordElement: HTMLElement,
	direction: "backward" | "forward",
): string | null {
	const wordNodes = Array.from(editor.querySelectorAll<HTMLElement>("[data-word-id]"));
	const index = wordNodes.indexOf(wordElement);
	if (index < 0) return null;
	return wordNodes[index + (direction === "backward" ? -1 : 1)]?.dataset.wordId ?? null;
}

function clampRangeOffset(node: Node, offset: number): number {
	if (node.nodeType === Node.TEXT_NODE) {
		return Math.max(0, Math.min(offset, node.textContent?.length ?? 0));
	}
	return Math.max(0, Math.min(offset, node.childNodes.length));
}

function restoreCaretBeforeWord(editor: HTMLElement | null, wordId: string): void {
	const wordElement = editor?.querySelector<HTMLElement>(`[data-word-id="${wordId}"]`);
	if (!editor || !wordElement) return;
	editor.focus();
	const range = globalThis.document.createRange();
	range.setStartBefore(wordElement);
	range.collapse(true);
	const selection = globalThis.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

// Re-export AxcutWord type so the helpers above can be typed without
// pulling the schema into the helpers block.
export type { AxcutWord };

// ─── Video Effects ─────────────────────────────────────────────────

export function VideoEffectsPane() {
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();

	// Push the current frame-styling settings into the native D3D compositor
	// view whenever it becomes active (or the settings change while it's up).
	// The onChange handlers above already push per-control diffs; this effect
	// also covers the "user tweaked a setting before the native view was
	// mounted" case so the view doesn't render with stale defaults.
	// Le rayon natif = rayon de base de la fixture (~24px @1920) × cette échelle. Diviser la
	// valeur px de l'UI par ce même rayon de base fait que le coin natif ≈ les px affichés
	// (au lieu de plafonner à ~24px comme avec /64).
	const NATIVE_SCREEN_BASE_RADIUS_PX = 24;
	useEffect(() => {
		const syncToNative = () => {
			// pas de garde `isNativeCompositorActive` : setNativeParam mémorise les valeurs
			// même sans vue active, et le store les rejoue quand une vue s'active (fix du
			// démarrage sur les défauts, indépendant de l'ordre de montage).
			setNativeParam("backgroundBlur", settings.showBlur);
			setNativeParam("motionBlur", settings.motionBlurAmount);
			setNativeParam("shadow", settings.shadowIntensity);
			setNativeParam("roundness", settings.borderRadius / NATIVE_SCREEN_BASE_RADIUS_PX);
			setNativeParam("padding", settings.padding / 100);
			const bg = settings.wallpaper;
			if (bg.startsWith("#")) {
				setNativeParam("backgroundColor", bg);
			}
		};
		syncToNative();
		return subscribeNativeCompositor(syncToNative);
	}, [
		settings.showBlur,
		settings.motionBlurAmount,
		settings.shadowIntensity,
		settings.borderRadius,
		settings.padding,
		settings.wallpaper,
	]);

	return (
		<Pane
			title="Video effects"
			icon={<Sliders size={14} />}
			helpText="Frame styling for the recording: background blur, drop shadow, motion blur, corner radius, and padding around the video."
		>
			<div className={styles.paneRow}>
				<span className="label">Blur BG</span>
				<Toggle
					checked={settings.showBlur}
					disabled={!hasDocument}
					onChange={(v) => {
						void set({ showBlur: v });
						if (isNativeCompositorActive()) {
							setNativeParam("backgroundBlur", v);
						}
					}}
				/>
			</div>
			<div className={styles.sliderGrid}>
				<SliderCell
					label="Motion blur"
					value={settings.motionBlurAmount * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => {
						setLive({ motionBlurAmount: v / 100 });
						if (isNativeCompositorActive()) {
							setNativeParam("motionBlur", v / 100);
						}
					}}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Shadow"
					value={settings.shadowIntensity * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => {
						setLive({ shadowIntensity: v / 100 });
						if (isNativeCompositorActive()) {
							setNativeParam("shadow", v / 100);
						}
					}}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Roundness"
					value={settings.borderRadius}
					min={0}
					max={64}
					step={0.5}
					suffix="px"
					disabled={!hasDocument}
					onChange={(v) => {
						setLive({ borderRadius: v });
						if (isNativeCompositorActive()) {
							setNativeParam("roundness", v / NATIVE_SCREEN_BASE_RADIUS_PX);
						}
					}}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Padding"
					value={settings.padding}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => {
						setLive({ padding: v });
						if (isNativeCompositorActive()) {
							setNativeParam("padding", v / 100);
						}
					}}
					onCommit={() => void commit()}
				/>
			</div>
		</Pane>
	);
}

// ─── Layout (webcam) ──────────────────────────────────────────────

const WEBCAM_PRESETS = [
	{ value: "picture-in-picture", label: "Picture in picture" },
	{ value: "dual-frame", label: "Side by side" },
	{ value: "vertical-stack", label: "Top / bottom" },
	{ value: "no-webcam", label: "Screen only" },
] as const;

// Webcam size (% of frame width) that maps to the native compositor's default PiP webcam
// (fixture a_side = 320px @ 1920 ≈ 16.7%). `webcamSizePreset / this` = the native size scale
// (1 = fixture default), so the slider reads as a direct multiplier on the shipped webcam.
const NATIVE_WEBCAM_BASE_PCT = 16.7;

const CAMERA_SHAPES: Array<{
	value: "rectangle" | "circle" | "square" | "rounded";
	label: string;
	icon: ReactNode;
}> = [
	{ value: "rectangle", label: "Rect", icon: <rect x="3" y="6" width="18" height="12" rx="1" /> },
	{ value: "circle", label: "Circle", icon: <circle cx="12" cy="12" r="9" /> },
	{ value: "square", label: "Square", icon: <rect x="4" y="4" width="16" height="16" rx="1" /> },
	{ value: "rounded", label: "Rounded", icon: <rect x="3" y="6" width="18" height="12" rx="6" /> },
];

export function LayoutPane() {
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();
	const document = useProjectStore((s) => s.document);

	// Push webcam-layout settings into the native compositor (initial values + on view
	// activation); the per-control handlers below also push their diffs live.
	useEffect(() => {
		const syncToNative = () => {
			setNativeParam("webcamSize", settings.webcamSizePreset / NATIVE_WEBCAM_BASE_PCT);
			setNativeParam("webcamMirror", settings.webcamMirrored);
			setNativeParam("webcamShape", settings.webcamMaskShape);
		};
		syncToNative();
		return subscribeNativeCompositor(syncToNative);
	}, [settings.webcamSizePreset, settings.webcamMirrored, settings.webcamMaskShape]);
	// the mask shape picker only makes sense for Picture-in-Picture.
	// Dual-frame (side-by-side) and vertical-stack (top/bottom) hardcode a
	// rectangle in the legacy layout math, so we hide those controls when the
	// preset isn't PiP.
	const isPip = settings.webcamLayoutPreset === "picture-in-picture";
	// P4 — a project can hold clips with no camera attached at all (plain
	// imported videos, or a recording made without a webcam). The layout
	// controls have nothing to act on in that case, so they're disabled
	// rather than left live for a preset that will never show anything.
	const hasAnyCamera = document
		? hasAnyClipWithCamera(document.assets, document.timeline.clips)
		: false;
	const layoutControlsDisabled = !hasDocument || !hasAnyCamera;
	return (
		<Pane
			title="Layout"
			icon={<LayoutIcon size={14} />}
			helpText="How the webcam is composed with the screen: picture-in-picture, vertical stack, dual frame, mask shape, size, and mirroring."
		>
			<div className={styles.sectionLabel}>Preset</div>
			<div className={styles.field}>
				<label>Layout</label>
				<select
					value={settings.webcamLayoutPreset}
					disabled={layoutControlsDisabled}
					onChange={(e) =>
						void set({ webcamLayoutPreset: e.target.value as typeof settings.webcamLayoutPreset })
					}
				>
					{WEBCAM_PRESETS.map((p) => (
						<option key={p.value} value={p.value}>
							{p.label}
						</option>
					))}
				</select>
			</div>
			<div className={styles.paneRow}>
				<span className="label">Mirror webcam</span>
				<Toggle
					checked={settings.webcamMirrored}
					disabled={layoutControlsDisabled}
					onChange={(v) => {
						void set({ webcamMirrored: v });
						if (isNativeCompositorActive()) {
							setNativeParam("webcamMirror", v);
						}
					}}
				/>
			</div>
			<div className={styles.paneRow}>
				<span className="label">Shrink on zoom</span>
				<Toggle
					checked={settings.webcamReactiveZoom}
					disabled={layoutControlsDisabled}
					onChange={(v) => void set({ webcamReactiveZoom: v })}
				/>
			</div>
			{isPip ? (
				<>
					<div className={styles.sectionLabel}>Camera shape</div>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(4, 1fr)",
							gap: 8,
							padding: "0 var(--sp-4) 12px",
						}}
					>
						{CAMERA_SHAPES.map((shape) => {
							const isActive = settings.webcamMaskShape === shape.value;
							return (
								<button
									type="button"
									key={shape.value}
									className={`${styles.cursorCell} ${isActive ? styles.isActive : ""}`}
									style={{
										flexDirection: "column",
										gap: 4,
										padding: 8,
										display: "flex",
										alignItems: "center",
									}}
									disabled={layoutControlsDisabled}
									onClick={() => {
										void set({ webcamMaskShape: shape.value });
										if (isNativeCompositorActive()) {
											setNativeParam("webcamShape", shape.value);
										}
									}}
								>
									<svg
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										width={22}
										height={22}
									>
										{shape.icon}
									</svg>
									<span style={{ font: "500 11px/1 var(--font-body)" }}>{shape.label}</span>
								</button>
							);
						})}
					</div>
				</>
			) : null}
			{isPip ? (
				<div className={styles.sliderGrid}>
					<div className={`${styles.sliderCell} ${styles.full}`}>
						<div className="head">
							<span className="label">Webcam size</span>
							<span className="val">{Math.round(settings.webcamSizePreset)}%</span>
						</div>
						<input
							type="range"
							min={10}
							max={50}
							step={1}
							defaultValue={settings.webcamSizePreset}
							disabled={layoutControlsDisabled}
							onChange={(e) => {
								const next = Number(e.target.value);
								setLive({ webcamSizePreset: next });
								if (isNativeCompositorActive()) {
									setNativeParam("webcamSize", next / NATIVE_WEBCAM_BASE_PCT);
								}
							}}
							onMouseUp={() => void commit()}
							onTouchEnd={() => void commit()}
							onKeyUp={() => void commit()}
						/>
					</div>
				</div>
			) : null}
		</Pane>
	);
}

// ─── Cursor ───────────────────────────────────────────────────────

function safeAssetUrl(relativePath: string): string {
	try {
		return getAssetPath(relativePath);
	} catch {
		return `/${relativePath.replace(/^\/+/, "")}`;
	}
}

export function CursorPane() {
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();

	// Push cursor settings into the native compositor (initial + on view activation); the
	// handlers below push diffs live. Sizes are sent as direct scales (1 = fixture default).
	useEffect(() => {
		const syncToNative = () => {
			setNativeParam("cursorShow", settings.cursorShow);
			setNativeParam("cursorSize", settings.cursor.size);
			setNativeParam("cursorClickBounce", settings.cursor.clickBounce);
		};
		syncToNative();
		return subscribeNativeCompositor(syncToNative);
	}, [settings.cursorShow, settings.cursor.size, settings.cursor.clickBounce]);

	// Built-in "Default" plus each bundled theme. Thumbnails use the theme's
	// arrow asset; the persisted value is the theme id. Same shape as the
	// legacy SettingsPanel picker.
	const cursorThemeOptions = useMemo(
		() => [
			{
				id: DEFAULT_CURSOR_THEME_ID,
				name: "Default",
				previewUrl: defaultCursorPreviewUrl,
			},
			...CURSOR_THEMES.map((theme) => {
				const previewPath = (theme.assets.arrow ?? theme.assets.pointer)?.assetPath;
				return {
					id: theme.id,
					name: theme.name,
					previewUrl: previewPath ? safeAssetUrl(previewPath) : defaultCursorPreviewUrl,
				};
			}),
		],
		[],
	);

	return (
		<Pane
			title="Cursor"
			icon={<MousePointerClick size={14} />}
			helpText="Cursor rendering from the recorded telemetry: theme, size, smoothing, motion blur, and click-bounce emphasis."
		>
			<div className={styles.paneRow}>
				<span className="label">Show cursor</span>
				<Toggle
					checked={settings.cursorShow}
					disabled={!hasDocument}
					onChange={(v) => {
						void set({ cursor: { show: v } });
						if (isNativeCompositorActive()) {
							setNativeParam("cursorShow", v);
						}
					}}
				/>
			</div>
			<div className={styles.paneRow}>
				<span className="label">Clip to canvas</span>
				<Toggle
					checked={settings.cursor.clipToBounds}
					disabled={!hasDocument}
					onChange={(v) => void set({ cursor: { clipToBounds: v } })}
				/>
			</div>
			<div className={styles.sectionLabel}>Cursor style</div>
			<div className={styles.cursorGrid}>
				{cursorThemeOptions.map((option) => {
					const isActive = settings.cursorTheme === option.id;
					return (
						<button
							type="button"
							key={option.id}
							className={`${styles.cursorCell} ${isActive ? styles.isActive : ""}`}
							title={option.name}
							aria-label={option.name}
							aria-pressed={isActive}
							disabled={!hasDocument}
							onClick={() => void set({ cursor: { theme: option.id } })}
						>
							<img
								src={option.previewUrl}
								alt=""
								width={20}
								height={20}
								draggable={false}
								style={{ objectFit: "contain", pointerEvents: "none" }}
							/>
						</button>
					);
				})}
			</div>
			<div className={styles.sliderGrid}>
				<SliderCell
					label="Size"
					value={settings.cursor.size * 10}
					min={5}
					max={100}
					step={0.1}
					decimals={1}
					disabled={!hasDocument}
					onChange={(v) => {
						setLive({ cursor: { size: v / 10 } });
						if (isNativeCompositorActive()) {
							setNativeParam("cursorSize", v / 10);
						}
					}}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Smoothing"
					value={settings.cursor.smoothing * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => setLive({ cursor: { smoothing: v / 100 } })}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Motion blur"
					value={settings.cursor.motionBlur * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => setLive({ cursor: { motionBlur: v / 100 } })}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Click bounce"
					value={settings.cursor.clickBounce * 10}
					min={0}
					max={50}
					step={0.1}
					decimals={1}
					disabled={!hasDocument}
					onChange={(v) => {
						setLive({ cursor: { clickBounce: v / 10 } });
						if (isNativeCompositorActive()) {
							setNativeParam("cursorClickBounce", v / 10);
						}
					}}
					onCommit={() => void commit()}
				/>
			</div>
		</Pane>
	);
}

// ─── Timeline (trim waveform) ──────────────────────────────────────

export function TimelinePaneBody() {
	const { settings, set, hasDocument } = useEditorSettings();
	return (
		<Pane
			title="Timeline"
			icon={<CropIcon size={14} />}
			helpText="Timeline display options, like showing the audio waveform on the trim track."
		>
			<div className={styles.paneRow}>
				<span className="label">Show audio waveform on trim track</span>
				<Toggle
					checked={settings.showTrimWaveform}
					disabled={!hasDocument}
					onChange={(v) => void set({ showTrimWaveform: v })}
				/>
			</div>
		</Pane>
	);
}

// ─── primitives ───────────────────────────────────────────────────

function Toggle({
	checked,
	disabled,
	onChange,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<button
			type="button"
			className={`${styles.toggle} ${checked ? styles.isOn : ""}`}
			aria-pressed={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		/>
	);
}

function SliderCell({
	label,
	value,
	min,
	max,
	step = 1,
	decimals = 0,
	suffix = "",
	disabled,
	onChange,
	onCommit,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	decimals?: number;
	suffix?: string;
	disabled?: boolean;
	onChange: (next: number) => void;
	onCommit: () => void;
}) {
	return (
		<div className={styles.sliderCell}>
			<div className="head">
				<span className="label">{label}</span>
				<span className="val">
					{value.toFixed(decimals)}
					{suffix}
				</span>
			</div>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				defaultValue={value}
				disabled={disabled}
				onChange={(e) => onChange(Number(e.target.value))}
				onMouseUp={onCommit}
				onTouchEnd={onCommit}
				onKeyUp={onCommit}
			/>
		</div>
	);
}

// legacy color wheel / hue track styling was a cosmetic placeholder —
// the active BackgroundColorTab uses real pickers (color input + hex text) so
// the static style helpers are no longer needed.
