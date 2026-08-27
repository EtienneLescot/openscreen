// Six right-rail panes matching design/openscreen-editor.html. Each control
// reads from + writes to the project document via `useEditorSettings`, so the
// design's UI is the canonical surface (no more "more options" link to a
// legacy panel — the legacy SettingsPanel is still available to the legacy
// VideoEditor and to per-region inspectors, but the panes here are
// self-sufficient).

import {
	AudioLines,
	ChevronDown,
	FileText,
	HelpCircle,
	Layout as LayoutIcon,
	Loader2,
	MousePointerClick,
	Sliders,
	Trash2,
} from "lucide-react";

import {
	type ChangeEvent,
	type CSSProperties,
	type FormEvent,
	memo,
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
import { toast } from "sonner";
import defaultCursorPreviewUrl from "@/assets/cursors/Cursor=Default.svg";
import GradientEditor, { type GradientEditorState } from "@/components/ui/gradient-editor";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { collectNativeFormats } from "@/lib/ai-edition/document/outputFormat";
import type {
	AxcutAsset,
	AxcutClip,
	AxcutTranscript,
	AxcutTrimRange,
	AxcutWord,
} from "@/lib/ai-edition/schema";
import {
	AUDIO_GAIN_DB_LIMIT,
	type EditorSettingsPatch,
} from "@/lib/ai-edition/store/editorSettings";
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
import {
	type AssetTranscriptionView,
	firstBusyView,
	type TranscriptGateReason,
} from "@/lib/ai-edition/transcription/status";
import { getAssetPath } from "@/lib/assetPath";
import { resolveWebcamLayoutPreset, supportsWebcamReactiveZoom } from "@/lib/compositeLayout";
import { supportsCursorClickEffects } from "@/lib/cursor/cursorCapabilities";
import {
	CURSOR_THEMES,
	DEFAULT_CURSOR_THEME_ID,
	themePickerPreviewAssets,
} from "@/lib/cursor/cursorThemes";
import { buildGradientFromEditor } from "@/lib/gradientBuilder";
import {
	classifyWallpaper,
	resolveImageWallpaperUrl,
	WALLPAPER_PATHS,
	WALLPAPER_THUMB_PATHS,
} from "@/lib/wallpaper";
import { isNativeCompositorActive, setNativeParam } from "@/native";
import {
	ASPECT_RATIO_PRESETS,
	type AspectRatio,
	getAspectRatioLabel,
} from "@/utils/aspectRatioUtils";
import { useCanSegmentCamera } from "../../native/hooks/useSegmentationSupport";
import styles from "./NewEditorShell.module.css";
import { useTranscriptionLabel } from "./TranscriptionStatus";
import { transcriptionBusyLabel } from "./transcriptionBusyLabel";

interface PaneProps {
	title: string;
	icon: ReactNode;
	// P3.3 — contextual help shown in a popover when the ? button is clicked.
	helpText: string;
	children: ReactNode;
}

function Pane({ title, icon, helpText, children }: PaneProps) {
	const ts = useScopedT("settings");
	const helpLabel = ts("panes.help");
	const [helpOpen, setHelpOpen] = useState(false);
	return (
		<div className={`${styles.pane} ${styles.isActive}`}>
			<header className={styles.paneHead} style={{ position: "relative" }}>
				<h2>{title}</h2>
				<span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
					<button
						type="button"
						className={styles.iconBtn}
						title={helpLabel}
						aria-label={helpLabel}
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
						{helpText}
					</div>
				) : null}
			</header>
			<div className={styles.paneBody}>{children}</div>
		</div>
	);
}

// ─── Background (section of the Effects pane) ──────────────────────

// keep the gradient palette small and curated — every block renders
// in the picker and gets serialized to legacyEditor on save.
// Spans the same hues as COLOR_PALETTE below rather than leaning on the
// brand mint for half the grid — a wall of green reads as "we only
// have one color" rather than "pick a gradient."
const GRAD_PRESETS: readonly string[] = [
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #3b82f6, #8b5cf6)",
	"linear-gradient(135deg, #8b5cf6, #ec4899)",
	"linear-gradient(135deg, #f97316, #ec4899)",
	"linear-gradient(135deg, #f59e0b, #f97316)",
	"linear-gradient(135deg, #10b981, #3b82f6)",
	"linear-gradient(135deg, #22c55e, #10b981)",
	"linear-gradient(135deg, #6b7280, #16171d)",
	"linear-gradient(135deg, #ec4899, #ef4444)",
	"linear-gradient(135deg, #3b82f6, #22c55e)",
	"linear-gradient(135deg, #8b5cf6, #3b82f6)",
	"linear-gradient(135deg, #f59e0b, #ef4444)",
	"linear-gradient(135deg, #16171d, #1e293b)",
	"linear-gradient(135deg, #34d399, #3b82f6)",
	"linear-gradient(135deg, #ef4444, #8b5cf6)",
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

// One source for the file dialog's filter AND the post-pick validation. They were separate
// before — the accept string was an inline copy of a constant living in a module whose
// extension fallback never got wired up, so the dialog offered files the handler then
// dropped on the floor.
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];
// `image/jpg` is not the registered type but real systems emit it, so accept it too.
const IMAGE_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png"];
const IMAGE_ACCEPT = [...IMAGE_EXTENSIONS, ...IMAGE_MIME_TYPES].join(",");

/**
 * Whether a picked file is a background image we can use.
 *
 * A blank `type` falls back to the extension: the browser reports no MIME type for some
 * files and some locales on Windows, and a bare `file.type.startsWith("image/")` then
 * rejected perfectly good PNGs — silently, since the handler just returned. That is the
 * case "Allow PNG custom background uploads" fixed once already (its test named a real
 * one: `生成画像1.png`, arriving with no MIME type at all).
 *
 * An explicit non-image type is still a rejection. Only a blank one earns the fallback,
 * so `notes.txt` renamed to `notes.png` does not sneak through on its extension.
 */
export function isSupportedBackgroundImage(type: string, fileName: string): boolean {
	const mime = type.trim().toLowerCase();
	if (mime) {
		return IMAGE_MIME_TYPES.includes(mime);
	}
	const name = fileName.trim().toLowerCase();
	return IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * The "upload custom wallpaper" concern: a hidden `<input type=file>` plus the reader
 * that turns the pick into a `data:` URL.
 *
 * A hook rather than part of `WallpaperPicker` because WHERE the input may be mounted is
 * the caller's problem. `BackgroundSection` renders the picker inside a Popover, and
 * opening the OS file dialog takes focus, which closes the Popover — an input mounted
 * inside it would unmount mid-pick and drop the file. That caller mounts `input` outside
 * the Popover; inline callers mount it next to the picker.
 */
function useWallpaperFileInput(onPicked: (dataUrl: string) => void): {
	pick: () => void;
	input: ReactNode;
} {
	const ts = useScopedT("settings");
	const ref = useRef<HTMLInputElement | null>(null);

	const handleFileSelected = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		if (!isSupportedBackgroundImage(file.type, file.name)) {
			toast.error(ts("background.unsupportedImage"));
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = typeof reader.result === "string" ? reader.result : "";
			if (!dataUrl) {
				toast.error(ts("background.imageReadFailed"));
				return;
			}
			onPicked(dataUrl);
		};
		reader.onerror = () => toast.error(ts("background.imageReadFailed"));
		reader.readAsDataURL(file);
	};

	return {
		pick: () => ref.current?.click(),
		input: (
			<input
				ref={ref}
				type="file"
				accept={IMAGE_ACCEPT}
				style={{ display: "none" }}
				onChange={handleFileSelected}
			/>
		),
	};
}

// Wallpaper picker — image / solid color / gradient tabs.
//
// Wallpapers round-trip through the legacyEditor envelope exactly as they did
// in the v2 editor: gradient strings stay as-is, colors as `#hex`, and image
// paths are restricted to `/wallpapers/...` or the user's own data: URLs from
// the upload custom flow.
function BackgroundSection() {
	const ts = useScopedT("settings");
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();
	const [pickerOpen, setPickerOpen] = useState(false);
	const { pick: handlePickFile, input: fileInput } = useWallpaperFileInput((dataUrl) =>
		set({ wallpaper: dataUrl }),
	);

	return (
		<>
			<div className={styles.sectionLabel}>{ts("background.title")}</div>
			{/* The picker FLOATS instead of sitting inline. Inline, the 18-swatch grid was
			    ~300px of the pane on its own and pushed padding/roundness/shadow — the
			    controls #84 is actually about — below the fold on a laptop window. A user
			    who opened the one appearance tab saw wallpapers and nothing else, which is
			    the same failure the facet merge set out to fix, one level down. Same
			    trade the aspect-ratio menu makes in the timeline toolbar: big choice,
			    small trigger. */}
			<Popover open={pickerOpen} onOpenChange={setPickerOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						className={styles.bgTrigger}
						style={backgroundSwatchStyle(settings.wallpaper)}
						// Deliberately NOT gated on hasDocument: opening the picker mutates
						// nothing, and the swatches inside carry their own gate. The inline grid
						// was browsable with no project open; collapsing it should not take that
						// away, only the space it used.
						aria-label={ts("background.title")}
					>
						<span className={styles.bgTriggerChip}>
							{ts(`background.${classifyWallpaper(settings.wallpaper).kind}`)}
							<ChevronDown size={11} />
						</span>
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					sideOffset={6}
					// Keeps the picker off the window edge, and the same padding is what Radix
					// subtracts from `--radix-popover-content-available-height`, which sizes it.
					collisionPadding={12}
					animated={false}
					className="w-auto border-0 bg-transparent p-0 shadow-none"
				>
					<div className={styles.bgPopover}>
						<WallpaperPicker
							value={settings.wallpaper}
							hasDocument={hasDocument}
							onChange={(url) => void set({ wallpaper: url })}
							onLiveChange={(url) => setLive({ wallpaper: url })}
							onCommit={commit}
							onPickFile={handlePickFile}
						/>
					</div>
				</PopoverContent>
			</Popover>
			{/* Stays mounted OUTSIDE the popover: opening the OS file dialog takes focus,
			    which closes the popover and would unmount the input mid-pick, dropping the
			    file. It has no layout to cost us here. */}
			{fileInput}
			{/* Reads in the order it acts: pick a background, then blur it. Lived under
			    "Effects" while that was a separate facet, which is how a control named
			    "Blur BG" ended up in the tab that doesn't say background. */}
			<div className={styles.paneRow}>
				<span className={styles.label}>{ts("effects.blurBg")}</span>
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
		</>
	);
}

/**
 * The CSS `background` shorthand that paints a wallpaper value as a swatch — the same
 * painting the grid thumbs do, hoisted out so the collapsed trigger shows exactly what the
 * grid would show as selected. Bundled wallpapers resolve to their small pre-generated
 * thumbnail; colours and gradients are their own literal; a custom `data:` URL passes
 * through `resolveImageWallpaperUrl` untouched.
 */
function backgroundSwatchStyle(value: string): CSSProperties {
	const classified = classifyWallpaper(value);
	if (classified.kind !== "image") return { background: classified.value };
	const bundled = WALLPAPER_PATHS.indexOf(classified.path);
	try {
		const url = resolveImageWallpaperUrl(
			bundled >= 0 ? WALLPAPER_THUMB_PATHS[bundled] : classified.path,
		);
		return { background: `center/cover no-repeat url(${url})` };
	} catch {
		// resolveImageWallpaperUrl THROWS for an image path outside /wallpapers/ — a guard
		// that exists to stop the app loading arbitrary files. The swatch grid only ever
		// feeds it constants, but this call site feeds it whatever the document holds, and a
		// throw here happens during render: one project saved by an older build with a path
		// we no longer allow would take the whole pane down instead of drawing a dull square.
		return { background: "var(--surface-2)" };
	}
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

function normaliseHex(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
	if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(withHash)) return null;
	return withHash.toLowerCase();
}

function BackgroundColorTab({
	value,
	hasDocument,
	isSelected,
	onPick,
	updateNative = true,
}: {
	value: string;
	hasDocument: boolean;
	isSelected: (v: string) => boolean;
	onPick: (next: string) => void;
	updateNative?: boolean;
}) {
	const ts = useScopedT("settings");
	const [hexDraft, setHexDraft] = useState(value.startsWith("#") ? value : "#000000");
	useEffect(() => {
		if (value.startsWith("#")) setHexDraft(value);
	}, [value]);
	const commitHex = () => {
		const next = normaliseHex(hexDraft);
		if (next) {
			onPick(next);
			if (updateNative && isNativeCompositorActive()) {
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
						aria-label={ts("background.colorLabel", { color: c })}
						disabled={!hasDocument}
						onClick={() => {
							onPick(c);
							if (updateNative && isNativeCompositorActive()) {
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

export interface WallpaperPickerProps {
	value: string;
	hasDocument: boolean;
	onChange: (val: string) => void;
	onLiveChange?: (val: string) => void;
	onCommit?: () => void;
	updateNativeBackground?: boolean;
	/** Opens the OS file dialog. The hidden `<input>` it clicks belongs to the caller
	 *  (see `useWallpaperFileInput`): where it may be mounted depends on the caller. */
	onPickFile: () => void;
}

export function WallpaperPicker({
	value,
	hasDocument,
	onChange,
	onLiveChange,
	onCommit,
	updateNativeBackground = true,
	onPickFile,
}: WallpaperPickerProps) {
	const ts = useScopedT("settings");
	// Seeded from what is actually in use, so the picker opens on the tab the user is
	// already in rather than always on Image.
	const [tab, setTab] = useState<"image" | "color" | "gradient">(
		() => classifyWallpaper(value).kind,
	);
	const customUrls = useMemoCustomWallpapers(value);

	const gradientCommitTimer = useRef<number | null>(null);
	const handleGradientChange = useCallback(
		(state: GradientEditorState) => {
			const grad = buildGradientFromEditor(state);
			if (onLiveChange) onLiveChange(grad);
			else onChange(grad);
			if (gradientCommitTimer.current !== null) {
				window.clearTimeout(gradientCommitTimer.current);
			}
			gradientCommitTimer.current = window.setTimeout(() => {
				gradientCommitTimer.current = null;
				if (onCommit) void onCommit();
			}, 400);
		},
		[onChange, onLiveChange, onCommit],
	);
	useEffect(
		() => () => {
			if (gradientCommitTimer.current !== null) {
				window.clearTimeout(gradientCommitTimer.current);
			}
		},
		[],
	);

	const isSelected = (candidate: string) => value === candidate;

	const handleTabChange = (next: "image" | "color" | "gradient") => {
		setTab(next);
	};

	return (
		<>
			{/* role="tab" + aria-selected are what make the tablist mean anything: without
			    them a screen reader announces three plain buttons and never says which one
			    is current. */}
			<div className={styles.paneTabs} role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "image"}
					className={tab === "image" ? styles.isActive : ""}
					onClick={() => handleTabChange("image")}
				>
					{ts("background.image")}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "color"}
					className={tab === "color" ? styles.isActive : ""}
					onClick={() => handleTabChange("color")}
				>
					{ts("background.color")}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "gradient"}
					className={tab === "gradient" ? styles.isActive : ""}
					onClick={() => handleTabChange("gradient")}
				>
					{ts("background.gradient")}
				</button>
			</div>
			{tab === "image" ? (
				<>
					<button
						type="button"
						className={styles.uploadBtn}
						disabled={!hasDocument}
						onClick={onPickFile}
					>
						{ts("background.uploadCustom")}
					</button>
					<div className={styles.bgGrid}>
						{customUrls.map((url) => (
							<button
								type="button"
								key={`custom-${url.slice(-32)}`}
								className={`${styles.bgThumb} ${isSelected(url) ? styles.isActive : ""}`}
								style={{ background: `center/cover no-repeat url(${url})` }}
								aria-label={ts("background.customWallpaper")}
								disabled={!hasDocument}
								onClick={() => onChange(url)}
							/>
						))}
						{WALLPAPER_PATHS.map((path, i) => {
							const previewUrl = resolveImageWallpaperUrl(WALLPAPER_THUMB_PATHS[i]);
							return (
								<button
									type="button"
									key={path}
									className={`${styles.bgThumb} ${isSelected(path) ? styles.isActive : ""}`}
									style={{ background: `center/cover no-repeat url(${previewUrl})` }}
									aria-label={ts("background.imageLabel", { index: i + 1 })}
									disabled={!hasDocument}
									onClick={() => onChange(path)}
								/>
							);
						})}
					</div>
				</>
			) : tab === "color" ? (
				<BackgroundColorTab
					value={value}
					hasDocument={hasDocument}
					isSelected={isSelected}
					onPick={(color) => onChange(color)}
					updateNative={updateNativeBackground}
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
								aria-label={ts("background.gradientLabel", { index: i + 1 })}
								disabled={!hasDocument}
								onClick={() => onChange(bg)}
							/>
						))}
					</div>
					{hasDocument ? <GradientEditor onChange={handleGradientChange} /> : null}
				</>
			)}
		</>
	);
}

/** Which clip a transcript cut lands on. The clip id is what makes the cut land on ONE
 *  block: two clips over the same media share an asset and a source range, so an
 *  asset-only target had the trim show up on both of them (and on the wrong one in the
 *  ruler). See `trimAppliesToClip`. */
export interface TrimTarget {
	assetId: string;
	clipId: string;
}

// ─── Transcript ────────────────────────────────────────────────────
// Aggregated transcript view: one contentEditable region per clip on the
// timeline, in timeline order. Each word is rendered as a `<span
// data-word-id>` inside the editable div. Words inside any `trimRange`
// anchored to the clip are styled red+strikethrough and show a bin icon
// on hover (removing the skip restores them). User actions:
//
//   - Click on a word    → seek (timeline.playhead)
//   - Backspace / Delete → convert selection (or caret-adjacent word)
//                          into a new trimRange (the document's
//                          `timeline.trimRanges[]`, NOT the transcript
//                          text). The deleted word stays in the DOM as
//                          red text — nothing destructive.
//
// `data-word-id` carries the CLIP-SCOPED `ClipWord.id`, never the bare `word.id`. A
// transcript belongs to an asset, so two clips over the same media project the same
// words twice, and silence tokens are numbered from 1 per clip — a bare word id names
// a moment in the media, not a thing on screen. Everything that points at a rendered
// word (React key, cue highlight, caret anchor, the DOM helpers at the bottom of this
// file) goes through `ClipWord.id`. Those helpers treat it as an opaque string, so they
// needed no change beyond the ids they are handed.
//
// Mirrors axcut's apps/web/src/components/CurrentTranscriptView.tsx.
export function TranscriptPane({
	clips,
	transcripts,
	assets,
	trimRanges,
	busyAssetIds,
	transcriptions,
	onSeek,
	onAddTrimRange,
	onRemoveTrimRange,
	onTranscribe,
	canTranscribe,
	isTranscribing,
	blocked,
}: {
	clips: AxcutClip[];
	transcripts: AxcutTranscript[];
	assets: AxcutAsset[];
	trimRanges: AxcutTrimRange[];
	/** Assets whose transcript is being (re)generated right now — their block is
	 *  read-only while the run is in flight, since it is about to be replaced.
	 *  PER ASSET on purpose: a timeline-wide flag made every other clip's word
	 *  stream silently swallow Backspace and hover-bin clicks for the whole
	 *  background pass, with nothing on screen to say why. */
	busyAssetIds: readonly string[];
	transcriptions?: Record<string, AssetTranscriptionView>;
	onSeek: (sec: number) => void;
	onAddTrimRange: (target: TrimTarget, startSec: number, endSec: number, reason: string) => void;
	onRemoveTrimRange: (trimId: string) => void;
	onTranscribe: () => void;
	canTranscribe: boolean;
	isTranscribing: boolean;
	/** Why no transcript can be had right now, resolved over the timeline's assets
	 *  (`resolveTranscriptGate`). Silent media disable the button; anything else
	 *  leaves it clickable. */
	blocked?: { reason: TranscriptGateReason; message?: string };
}) {
	const ts = useScopedT("settings");
	// Subscribed here, not passed down: the playhead is rewritten every animation
	// frame during playback, and reading it in NewEditorShell re-rendered the whole
	// editor (timeline included) once per frame — see NativePlaybackSync there. Only
	// the cue word derived below actually moves, and `TranscriptClipBlock` is memoised
	// on `cueWordId`, so a frame that doesn't cross a word boundary re-renders nothing
	// but this component's own (cheap) lookup.
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);
	const sections = useMemo(
		() => buildAggregatedSections(clips, transcripts, assets, trimRanges),
		[clips, transcripts, assets, trimRanges],
	);

	// the cue position is the playback head's location in the current clip's source time.
	// `currentTimeSec` is the RAW/document timeline (same referential as the ruler, see
	// NewEditorShell) — looked up against the raw `clips`, matching that referential.
	// `clipId` is what `findCueWordId` keys on — do NOT drop it as unused: source time is
	// per asset, so without it the resolver falls back to the first section of the asset
	// and the cue tracks clip 1 forever on a timeline that plays one media twice.
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
	// Only silence is a dead end: every other reason (a retryable failure, no
	// engine, nothing attempted) leaves the button worth pressing.
	const silentMedia = blocked?.reason === "no-audio";
	const transcriptionLabel = useTranscriptionLabel();
	const paneBusyLabel = transcriptionBusyLabel(
		firstBusyView(Object.values(transcriptions ?? {})) ??
			(isTranscribing ? { assetId: "", status: "running", phase: "loading-model" } : undefined),
		transcriptionLabel,
	);

	if (clips.length === 0 || !hasAnyTranscript) {
		return (
			<Pane
				title={ts("transcript.title")}
				icon={<FileText size={14} />}
				helpText={ts("transcript.help")}
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
						{clips.length === 0
							? ts("transcript.noClips")
							: isTranscribing
								? (paneBusyLabel ?? ts("transcript.transcribing"))
								: silentMedia
									? ts("transcript.noAudio")
									: ts("transcript.noTranscript")}
					</p>
					<p style={{ font: "400 12px var(--font-body)", color: "var(--muted)", maxWidth: 260 }}>
						{blocked?.reason === "failed" && blocked.message
							? blocked.message
							: ts("transcript.whisperHint")}
					</p>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={onTranscribe}
						// Nothing to retry on a media with no audio track: the run would
						// fail on the same missing track every time.
						disabled={!canTranscribe || isTranscribing || silentMedia}
					>
						{paneBusyLabel ?? ts("transcript.transcribeNow")}
					</button>
				</div>
			</Pane>
		);
	}

	return (
		<div className={`${styles.pane} ${styles.isActive}`}>
			<header className={styles.paneHead}>
				<h2>{ts("transcript.title")}</h2>
			</header>
			<div className={styles.paneBody}>
				{sections.map((section, idx) => (
					<TranscriptClipBlock
						key={section.clip.id}
						index={idx}
						section={section}
						busy={busyAssetIds.includes(section.clip.assetId)}
						busyLabel={
							transcriptionBusyLabel(transcriptions?.[section.clip.assetId], transcriptionLabel) ??
							undefined
						}
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
//
// `memo` matters here: this renders one DOM node per transcript word, and its
// parent now re-renders on every playhead tick (~60×/s during playback). The only
// prop that actually moves with the playhead is `cueWordId`, which changes at word
// boundaries — a few times per second, not sixty. Without the memo, every frame
// would re-render the entire word stream, and React commits all pending updates in
// one pass, so that cost would land on the playhead's own commit too.
const TranscriptClipBlock = memo(function TranscriptClipBlock({
	index,
	section,
	busy,
	busyLabel,
	cueWordId,
	onSeek,
	onAddTrimRange,
	onRemoveTrimRange,
}: {
	index: number;
	section: ClipSection;
	busy: boolean;
	busyLabel?: string;
	cueWordId: string | null;
	onSeek: (sec: number) => void;
	onAddTrimRange: (target: TrimTarget, startSec: number, endSec: number, reason: string) => void;
	onRemoveTrimRange: (trimId: string) => void;
}) {
	const ts = useScopedT("settings");
	const { clip, asset, words } = section;
	// Memoised: `TranscriptWord` renders once per word, so a fresh object literal here
	// would break referential equality for the whole stream on every parent render.
	const trimTarget = useMemo<TrimTarget>(
		() => ({ assetId: clip.assetId, clipId: clip.id }),
		[clip.assetId, clip.id],
	);
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
			pendingCaretWordIdRef.current = keptRange[0].id;
			const startSec = Math.min(...keptRange.map((w) => w.word.startSec));
			const endSec = Math.max(...keptRange.map((w) => w.word.endSec));
			onAddTrimRange(
				trimTarget,
				startSec,
				endSec,
				`Skip ${formatMs(startSec * 1000)}-${formatMs(endSec * 1000)} from ${clip.assetId}.`,
			);
		},
		[busy, clip.assetId, trimTarget, onAddTrimRange],
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
				const cw = words.find((w) => w.id === wordId);
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
			const fromIdx = words.findIndex((w) => w.id === anchorId);
			const toIdx = words.findIndex((w) => w.id === focusId);
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
			// Inserts are blocked to keep the projection stable: every run of text
			// here maps back to a `transcript.words` entry by id, and free text has
			// no id to land on. Deletion is fine because it goes through
			// `cutNativeSelection`, which resolves the selection to word ids first.
			//
			// This used to defer to `SourceTranscriptModal`, deleted with the v3
			// media pane — it never got past read-only, so it was never the answer
			// it was cited as. Editing a word's TEXT therefore has no in-app path
			// today. Adding one means a word-level mutation alongside
			// `skipWordRange`, reached from here; lifting this guard on its own
			// would only desynchronise the DOM from `words`.
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
			const cw = words.find((w) => w.id === wordEl.dataset.wordId);
			if (!cw) return;
			// `onSeek` takes RAW TIMELINE seconds (its other callers pass `timelineStartSec`;
			// `handleSeek` forwards `isSource: false`), but a word's times are the ASSET's
			// source seconds. Shift by this clip's offset — a raw clip is identity between
			// source and raw time apart from where it sits on the ruler. Passing the source
			// value straight through sent every click in a clip that doesn't start at ruler 0
			// backwards into whichever clip covers that raw moment; it only looked right on a
			// single clip at the head of the timeline, where the two coordinates coincide.
			onSeek(clip.timelineStartSec + (cw.word.startSec - clip.sourceStartSec));
		},
		[onSeek, words, clip.timelineStartSec, clip.sourceStartSec],
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
						{ts("transcript.clipLabel", { index: index + 1 })} · {sourceRangeLabel}
					</span>
				</span>
				{/* A block whose transcript is being regenerated is read-only — say it,
				    rather than letting the word stream look live and drop the edits. */}
				{busy ? (
					<span
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 5,
							flexShrink: 0,
							font: "500 11px/1 var(--font-body)",
							color: "var(--accent)",
						}}
					>
						<Loader2 size={12} className="animate-spin" />
						{busyLabel ?? ts("transcript.transcribing")}
					</span>
				) : null}
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
					{busy ? (busyLabel ?? ts("transcript.transcribing")) : ts("transcript.noClipTranscript")}
				</p>
			) : (
				<div
					ref={editorRef}
					role="textbox"
					tabIndex={0}
					contentEditable={!busy}
					aria-busy={busy}
					aria-readonly={busy}
					suppressContentEditableWarning
					spellCheck={false}
					aria-label={ts("transcript.editorAria", { filename })}
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
						// Read-only while its transcript is being regenerated: the cursor
						// and the wash are what stop it from reading as an editor that
						// ignores you (see the `busy` note on TranscriptPane).
						cursor: busy ? "progress" : "text",
						opacity: busy ? 0.6 : 1,
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
							key={cw.id}
							cw={cw}
							isCue={cw.id === cueWordId}
							target={trimTarget}
							onRestore={removeTrimRun}
							onAddTrimRange={onAddTrimRange}
						/>
					))}
				</div>
			)}
		</span>
	);
});

// One word inside the editable block. Kept words render plain; removed
// words (inside a skip range) render red+strikethrough with a hover bin.
// `isCue` highlights the word the playback head is currently inside with
// an accent underline (matches axcut's `word.transcript-word.cue` rule).
//
// `memo` for the same reason as `TranscriptClipBlock`, one level down — and it
// is the level that actually decides the cost. The block's memo assumes
// `cueWordId` moves "a few times per second, not sixty", which holds for
// playback at 1x and NOT for a scrub: dragging the playhead crosses many words
// per frame, so `cueWordId` changes on essentially every frame and the block
// re-renders. Without a memo here that meant re-rendering one component per
// transcript word, every frame. Measured over a 40-frame scrub in jsdom:
// 19.6 ms/frame at 100 words, 132.6 ms at 4501 (a real 30-minute recording) —
// the cost was simply proportional to transcript length. With the memo only
// the two words whose `isCue` actually flipped re-render.
//
// This holds because every other prop is referentially stable across a
// playhead tick: `cw` comes from the memoised `sections`, `target` from a
// `useMemo`, and both callbacks from `useCallback`s that do not depend on time.
const TranscriptWord = memo(function TranscriptWord({
	cw,
	isCue,
	target,
	onRestore,
	onAddTrimRange,
}: {
	cw: ClipWord;
	isCue: boolean;
	target: TrimTarget;
	onRestore: (run: TrimRun) => void;
	onAddTrimRange: (target: TrimTarget, startSec: number, endSec: number, reason: string) => void;
}) {
	const ts = useScopedT("settings");
	const [hover, setHover] = useState(false);
	const removed = !cw.kept;

	if (isSilenceWord(cw.word)) {
		const durationSec = cw.word.endSec - cw.word.startSec;
		const duration = durationSec.toFixed(1);
		const label = ts("transcript.silence", { duration });
		if (removed) {
			return (
				<button
					type="button"
					contentEditable={false}
					data-word-id={cw.id}
					data-silence="true"
					title={ts("transcript.restoreSilence", { duration })}
					aria-label={ts("transcript.restoreSilence", { duration })}
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
				data-word-id={cw.id}
				data-silence="true"
				title={ts("transcript.trimSilence", { duration })}
				aria-label={ts("transcript.trimSilence", { duration })}
				onClick={(e) => {
					e.stopPropagation();
					onAddTrimRange(
						target,
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
			data-word-id={cw.id}
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
					title={ts("transcript.restoreWord", { word: cw.word.text })}
					aria-label={ts("transcript.restoreWord", { word: cw.word.text })}
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
});

// ─── Caret / selection helpers ────────────────────────────────────
// Ponytail port of axcut's findCollapsedDeletionWordId. The non-collapsed
// path uses findWordId directly (a range selection's endpoints already
// identify the boundary words — no boundary heuristic needed).
//
// Every id here is a `ClipWord.id` (clip-scoped) read straight off `data-word-id`, and
// every lookup is confined to ONE block's `editor` element — so these stay correct
// whatever the ids look like. They must never parse an id: the `clipId:wordId` shape is
// `clipWordId`'s business alone.

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
	const skippedIds = new Set(words.filter((w) => !w.kept).map((w) => w.id));

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

	// The caret sits BETWEEN words — which is where `restoreCaretBeforeWord` parks it after
	// every cut (`setStartBefore` collapses to (editor, index-of-word)), so this is the
	// state the user is in while holding Backspace. Walk outward in the direction of travel
	// and take the first word that is STILL KEPT.
	//
	// Skipping the already-trimmed ones is the whole point: a struck-through word has
	// nothing left to remove, so resolving to it made `skipWordRange` drop it as not-kept
	// and the keystroke did nothing at all. The user had to click somewhere else to carry
	// on cutting — right after a cut, since the caret is parked before the word that was
	// just removed. A previous guard here tried to special-case that by returning the
	// already-trimmed word it had just rejected, which is the no-op it meant to avoid (and
	// was byte-for-byte what the walk below already returned, so it never changed anything).
	const isKept = (wordId: string | null): wordId is string => !!wordId && !skippedIds.has(wordId);
	const candidates =
		direction === "backward" ? childNodes.slice(0, offset).reverse() : childNodes.slice(offset);
	for (const candidate of candidates) {
		const wordId = findWordId(candidate) ?? findDescendantWordId(candidate);
		if (isKept(wordId)) return wordId;
	}
	// Fallback for a caret in some wrapper node whose children aren't the word spans: locate
	// it by document order instead. Same rule — nearest kept word in the direction of travel.
	const range = globalThis.document.createRange();
	range.setStart(editor, 0);
	range.setEnd(node, clampRangeOffset(node, offset));
	const before: HTMLElement[] = [];
	const after: HTMLElement[] = [];
	for (const wordNode of wordNodes) {
		(range.comparePoint(wordNode, 0) <= 0 ? before : after).push(wordNode);
	}
	const pool = direction === "backward" ? [...before].reverse() : after;
	return pool.find((wordNode) => isKept(wordNode.dataset.wordId ?? null))?.dataset.wordId ?? null;
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

// ─── Fit a clip ────────────────────────────────────────────────────

/**
 * The patch behind the action.
 *
 * There is no inverse. It was a toggle once, and the OFF branch restored the shipped defaults
 * — which was already a guess dressed as a memory, since nothing stored what the user had
 * before. Undo does that job properly, and the three sliders it writes sit directly below the
 * button, so "put it back" was never missing; it was being modelled twice.
 */
export function fitClipPatch(nativeToken: AspectRatio): EditorSettingsPatch {
	return { padding: 0, borderRadius: 0, shadowIntensity: 0, aspectRatio: nativeToken };
}

/**
 * The catalog key for a count, by CLDR plural category.
 *
 * `translate` interpolates and nothing else, so each form is its own key. Selecting by
 * category rather than by `count === 1` is what makes French say "0 clip" — and, more to the
 * point, what lets a locale carry more than two forms at all: Russian needs "клипа" for 2–4
 * and "клипов" for 5+, so mapping everything that is not `one` onto a single plural produced
 * "2 клипов", which is simply wrong rather than merely coarse.
 *
 * Falls back to `fitClipMany` for any category a locale has not authored, so adding a form is
 * a catalog change and never a code change. Arabic still needs its `two`, `few` and `many`
 * forms — it has six categories and I could not verify the grammar, so it is deliberately
 * left on the fallback rather than filled in with a guess.
 */
function pluralKey(locale: string, count: number): string {
	const category = new Intl.PluralRules(locale).select(count);
	return category === "one"
		? "effects.fitClipOne"
		: `effects.fitClip${category === "few" ? "Few" : "Many"}`;
}

// ─── Video Effects ─────────────────────────────────────────────────

/**
 * One pane for everything that shapes the composition.
 *
 * Background and Effects used to be two facets, and four of Effects' five controls were
 * background controls in disguise: the blur blurs the background, the shadow falls ON the
 * background, and roundness and padding exist only to let it show through. So a user who
 * wanted no background at all opened "Background", found nothing but wallpapers, and filed
 * #84. The split had no seam to sit on — it just hid the answer in the tab that doesn't say
 * "background".
 *
 * Merged, the sections read as what they are: pick a background, decide how the recording
 * sits on it, then the one control that is about neither.
 */
export function VideoEffectsPane() {
	const ts = useScopedT("settings");
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();
	const document = useProjectStore((s) => s.document);

	// Same source the ratio picker reads, so "fill frame" and the ORIGINAL section of that menu
	// can never disagree about what shape the footage is. Already sorted by clip count then by
	// pixel area, so [0] is "the shape most of this timeline is in" with no heuristic of ours.
	const nativeFormats = useMemo(() => (document ? collectNativeFormats(document) : []), [document]);
	const [fitMenuOpen, setFitMenuOpen] = useState(false);
	const [ratioMenuOpen, setRatioMenuOpen] = useState(false);
	const { locale } = useI18n();
	const clipCountLabel = (count: number) => ts(pluralKey(locale, count), { count });

	// Le rayon natif = rayon de base de la fixture (~24px @1920) × cette échelle. Diviser la
	// valeur px de l'UI par ce même rayon de base fait que le coin natif ≈ les px affichés
	// (au lieu de plafonner à ~24px comme avec /64).
	const NATIVE_SCREEN_BASE_RADIUS_PX = 24;
	// La synchro initiale de ces params vit dans NativeCompositorOverlay
	// (`pushAllNativeParams`) : l'inspecteur n'affiche qu'un panneau a la fois, donc
	// un effet de montage ici ne poussait rien tant que ce panneau precis n'avait pas
	// ete ouvert. Les handlers par controle ci-dessous poussent toujours leurs diffs.

	const applyFitClip = (token: AspectRatio) => {
		const patch = fitClipPatch(token);
		void set(patch);
		if (isNativeCompositorActive()) {
			setNativeParam("padding", 0);
			setNativeParam("roundness", 0);
			setNativeParam("shadow", 0);
		}
	};

	return (
		<Pane
			title={ts("effects.title")}
			icon={<Sliders size={14} />}
			// Two complete sentences, one per merged half, rather than a third string to
			// translate 13 times — both already exist in every locale and neither is a
			// fragment of the other, so joining them survives translation and RTL alike.
			helpText={`${ts("background.help")} ${ts("effects.help")}`}
		>
			<BackgroundSection />
			<div className={styles.sectionHead}>
				<span className={styles.sectionLabel}>{ts("effects.frame")}</span>
				{/* #84: "how do I turn the background off". The honest answer was four settings
				    in three places, so nobody found it. This is that answer as one control.

				    An ACTION, not a state, and not one setting among the four below either — it
				    overwrites all of them at once, which is why it rides the section header
				    instead of joining the list. The nearest thing it has to a peer is a reset
				    button, except it resets to a TARGET state rather than to the initial one.

				    It was a switch first, and a switch has room for one outcome while a timeline
				    with several shapes has one per shape — so it took the majority silently.
				    Making the choice explicit as a row of chips then failed on its own terms:
				    the chips read `683:384` and `64:27`, and ten of them do not fit. So: a
				    button that does the thing, and a list to pick from when there is more than
				    one thing it could do. Rows lead with the RESOLUTION, which is what a user
				    recognises about their own footage. */}
				<Popover open={fitMenuOpen} onOpenChange={setFitMenuOpen}>
					<PopoverTrigger asChild>
						<button
							type="button"
							className={styles.sectionAction}
							disabled={!hasDocument || nativeFormats.length === 0}
							onClick={(e) => {
								// One shape means no decision to delegate: act, do not ask.
								if (nativeFormats.length <= 1) {
									e.preventDefault();
									applyFitClip(nativeFormats[0].token);
								}
							}}
						>
							{ts("effects.fitClip")}
						</button>
					</PopoverTrigger>
					<PopoverContent
						align="center"
						sideOffset={6}
						collisionPadding={12}
						animated={false}
						className="w-auto border-0 bg-transparent p-0 shadow-none"
					>
						<div className={styles.actionMenu} role="menu" aria-label={ts("effects.fitClip")}>
							{nativeFormats.map((format) => (
								<button
									type="button"
									role="menuitem"
									key={format.token}
									className={styles.actionMenuRow}
									onClick={() => {
										setFitMenuOpen(false);
										applyFitClip(format.token);
									}}
								>
									<span className={styles.actionMenuMain}>
										{format.width} × {format.height}
									</span>
									<span className={styles.actionMenuMeta}>{format.token}</span>
									<span className={styles.actionMenuCount}>{clipCountLabel(format.clipCount)}</span>
								</button>
							))}
						</div>
					</PopoverContent>
				</Popover>
			</div>
			{/* The output shape moved here from the timeline toolbar. It is the one setting the
			    other three depend on — padding, roundness and shadow only mean anything against
			    a known frame — and among Trim / Speed / Zoom / transport it read as a playback
			    control rather than as the shape of what gets exported. Its old placement was
			    incidental: it arrived inside 1f25410b, a commit about per-clip crop export and
			    a HUD redesign, and no decision record ever argued for it. */}
			<div className={styles.paneRow}>
				<span className={styles.label}>{ts("effects.format")}</span>
				<Popover open={ratioMenuOpen} onOpenChange={setRatioMenuOpen}>
					<PopoverTrigger asChild>
						<button
							type="button"
							className={styles.rowAction}
							disabled={!hasDocument}
							aria-label={ts("effects.format")}
						>
							{/* `getAspectRatioLabel` hardcodes English "Original" for the legacy
							    `"native"` value, which is still reachable: the v5→v6 migration only
							    bakes it into a concrete token once clip dimensions are known, and
							    leaves it alone until then. The group header below is localized, so
							    without this the two would disagree in twelve locales. */}
							{settings.aspectRatio === "native"
								? ts("effects.formatOriginal")
								: getAspectRatioLabel(settings.aspectRatio)}
							<ChevronDown size={11} />
						</button>
					</PopoverTrigger>
					<PopoverContent
						align="end"
						sideOffset={6}
						collisionPadding={12}
						animated={false}
						className="w-auto border-0 bg-transparent p-0 shadow-none"
					>
						<div className={styles.actionMenu} role="menu" aria-label={ts("effects.format")}>
							{ASPECT_RATIO_PRESETS.map((ratio) => (
								<button
									type="button"
									role="menuitem"
									key={ratio}
									className={`${styles.actionMenuRow}${
										ratio === settings.aspectRatio ? ` ${styles.isActive}` : ""
									}`}
									onClick={() => {
										setRatioMenuOpen(false);
										void set({ aspectRatio: ratio });
									}}
								>
									<span className={styles.actionMenuMain}>{ratio}</span>
								</button>
							))}
							{/* The timeline's own shapes stay listed here, and NOT only behind "fit":
							    that action also zeroes the frame styling, so without these rows there
							    would be no way to export at the footage's native shape while keeping a
							    padded, rounded look. */}
							{nativeFormats.length > 0 ? (
								<>
									<div className={styles.actionMenuGroup}>{ts("effects.formatOriginal")}</div>
									{nativeFormats.map((format) => (
										<button
											type="button"
											role="menuitem"
											key={`native-${format.token}`}
											className={`${styles.actionMenuRow}${
												format.token === settings.aspectRatio ? ` ${styles.isActive}` : ""
											}`}
											onClick={() => {
												setRatioMenuOpen(false);
												void set({ aspectRatio: format.token });
											}}
										>
											{/* Token leads and the pixel size rides on the right, exactly as this
											    menu read in the timeline toolbar — here the row names an output
											    FORMAT, so the ratio is the identity. (The "fit" menu leads with
											    the resolution instead, because there a row names a clip.) */}
											<span className={styles.actionMenuMain}>{format.token}</span>
											<span className={styles.actionMenuCount}>
												{`${format.width}×${format.height}`}
												{nativeFormats.length > 1 ? ` · ${format.clipCount}` : ""}
											</span>
										</button>
									))}
								</>
							) : null}
						</div>
					</PopoverContent>
				</Popover>
			</div>
			<div className={styles.sliderGrid}>
				<SliderCell
					label={ts("effects.shadow")}
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
					label={ts("effects.roundness")}
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
					label={ts("effects.padding")}
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
			{/* Alone in its section, and correctly so: this blurs the RECORDING as it moves
			    (zooms, layout changes) — see `effects.motion_blur` driving the tap count in
			    frame_geometry.rs. It is the one control here that never touches the
			    background, so it does not belong under "Frame" either. */}
			<div className={styles.sectionLabel}>{ts("effects.motion")}</div>
			<div className={styles.sliderGrid}>
				<SliderCell
					label={ts("effects.motionBlur")}
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
			</div>
		</Pane>
	);
}

// ─── Layout (webcam) ──────────────────────────────────────────────

const WEBCAM_PRESETS = [
	{ value: "picture-in-picture", labelKey: "layout.pictureInPicture" },
	{ value: "dual-frame", labelKey: "layout.dualFrame" },
	{ value: "vertical-stack", labelKey: "layout.verticalStack" },
	{ value: "no-webcam", labelKey: "layout.noWebcam" },
] as const;

// Webcam size (% of frame width) that maps to the native compositor's default PiP webcam
// (fixture a_side = 320px @ 1920 ≈ 16.7%). `webcamSizePreset / this` = the native size scale
// (1 = fixture default), so the slider reads as a direct multiplier on the shipped webcam.
const NATIVE_WEBCAM_BASE_PCT = 16.7;

const CAMERA_SHAPES: Array<{
	value: "rectangle" | "circle" | "square" | "rounded";
	labelKey: string;
	icon: ReactNode;
}> = [
	{
		value: "rectangle",
		labelKey: "layout.shapes.rectangle",
		icon: <rect x="3" y="6" width="18" height="12" rx="1" />,
	},
	{ value: "circle", labelKey: "layout.shapes.circle", icon: <circle cx="12" cy="12" r="9" /> },
	{
		value: "square",
		labelKey: "layout.shapes.square",
		icon: <rect x="4" y="4" width="16" height="16" rx="1" />,
	},
	{
		value: "rounded",
		labelKey: "layout.shapes.rounded",
		icon: <rect x="3" y="6" width="18" height="12" rx="6" />,
	},
];

// The camera-background control used to be gated on the platform: the mask is produced by the
// native compositor, and Linux carried the shader branch with nothing feeding it, so `fx.z`
// never left 0 there and the setting would have changed nothing. The Linux back-end now
// captures the frame and uploads the mask like the other two, so the gate had become a lie
// and is gone — all three platforms segment.
const CAMERA_BACKGROUND_MODES: Array<{
	value: "none" | "transparent" | "blur" | "custom";
	labelKey: string;
	icon: ReactNode;
}> = [
	{
		value: "none",
		labelKey: "layout.bgModes.none",
		icon: <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />,
	},
	{
		value: "transparent",
		labelKey: "layout.bgModes.transparent",
		icon: (
			<>
				<circle cx="12" cy="8" r="4" />
				<path d="M6 20v-2a6 6 0 0 1 12 0v2" />
			</>
		),
	},
	{
		value: "blur",
		labelKey: "layout.bgModes.blur",
		icon: (
			<>
				<circle cx="12" cy="12" r="9" strokeDasharray="2 2" />
				<circle cx="12" cy="12" r="4" />
			</>
		),
	},
	{
		value: "custom",
		labelKey: "layout.bgModes.custom",
		icon: (
			<>
				<rect x="3" y="3" width="18" height="18" rx="2" />
				<circle cx="8.5" cy="8.5" r="1.5" />
				<path d="m21 15-5-5L5 21" />
			</>
		),
	},
];

export function LayoutPane() {
	const canSegmentCamera = useCanSegmentCamera();
	const ts = useScopedT("settings");
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();
	const { pick: handlePickWebcamWallpaper, input: webcamWallpaperInput } = useWallpaperFileInput(
		(dataUrl) => set({ webcamWallpaper: dataUrl }),
	);
	const document = useProjectStore((s) => s.document);
	// A project can hold clips with no camera attached at all (plain imports or a
	// recording made without a webcam). Keep the saved camera preference for later, but
	// make the disabled control describe whether this project has any camera at all.
	//
	// The preset is global while the camera is per clip, so a MIXED project shows the
	// saved preset here while the playhead may sit over a camera-less clip — the
	// preview and the scene answer `hasCamera` per clip, this panel answers it for the
	// project. Deliberately `hasAnyClipWithCamera` (is a camera attached?) and not
	// `assetCameraSource` (attached AND visible): a hidden camera keeps its saved preset
	// on display, because this panel is the surface you would use to un-hide it.
	//
	// Memoised because the pane subscribes to the whole document, and `setLive` during a
	// slider drag replaces it every frame — this scan is O(clips x assets).
	const hasAnyCamera = useMemo(
		() => (document ? hasAnyClipWithCamera(document.assets, document.timeline.clips) : false),
		[document],
	);
	const effectiveLayoutPreset = resolveWebcamLayoutPreset(
		settings.webcamLayoutPreset,
		hasAnyCamera,
	);

	// Synchro initiale : cf. NativeCompositorOverlay (`pushAllNativeParams`).
	// the mask shape picker only makes sense for Picture-in-Picture.
	// Dual-frame (side-by-side) and vertical-stack (top/bottom) weld the camera
	// to the screen as one block — the mask is rectangular and sized off the
	// screen capture — so we hide those controls when the preset isn't PiP.
	const isPip = effectiveLayoutPreset === "picture-in-picture";
	// Same reason for "Shrink on zoom": shrinking the camera mid-zoom would tear a
	// hole in the block, so the block layouts force it off (see
	// `supportsWebcamReactiveZoom`) and the toggle is dropped rather than shown
	// as a control that does nothing.
	const supportsReactiveZoom = supportsWebcamReactiveZoom(effectiveLayoutPreset);
	const layoutControlsDisabled = !hasDocument || !hasAnyCamera;
	// The controls go dead and the preset reads "No Webcam", but the saved preference is
	// still on disk. Say so, otherwise the only signal the user gets is their setting
	// apparently having been thrown away.
	const helpText = hasDocument && !hasAnyCamera ? ts("layout.helpNoWebcam") : ts("layout.help");
	const webcamCrop = settings.webcamCropRegion;
	const cropZoomPct = Math.round(100 / webcamCrop.width);
	// Read straight off the pan, not back out of the rect. The rect cannot answer at 100%
	// zoom — it is the whole frame, so its offset is 0 whatever the user chose — and it gave
	// a drifting answer on the way there, because the offset gets squeezed toward the near
	// edge as the window grows while the picture itself does not move.
	const cropPan = settings.webcamCropPan;
	const cropPanX = cropPan.x * 100;
	const cropPanY = cropPan.y * 100;
	/** Rect from zoom and pan. `pan * (1 - size)` cannot leave the frame, so nothing clamps. */
	const cropRegionFor = (size: number, pan: { x: number; y: number }) => ({
		x: pan.x * (1 - size),
		y: pan.y * (1 - size),
		width: size,
		height: size,
	});
	const setCropZoom = (zoomPct: number) => {
		const size = 100 / Math.max(100, zoomPct);
		// A pure function of (pan, size): the pan is never re-derived from the rect this
		// writes, so dragging the zoom back and forth returns the framing it started from.
		setLive({ webcamCropRegion: cropRegionFor(size, cropPan) });
	};
	const setCropPan = (axis: "x" | "y", valuePct: number) => {
		const pan = { ...cropPan, [axis]: valuePct / 100 };
		// One patch for both, so a half-written pair can never reach disk.
		setLive({ webcamCropPan: pan, webcamCropRegion: cropRegionFor(webcamCrop.width, pan) });
	};
	return (
		<Pane title={ts("layout.title")} icon={<LayoutIcon size={14} />} helpText={helpText}>
			<div className={styles.sectionLabel}>{ts("layout.preset")}</div>
			<div className={styles.field}>
				<label htmlFor="layout-preset">{ts("layout.preset")}</label>
				<select
					id="layout-preset"
					value={effectiveLayoutPreset}
					disabled={layoutControlsDisabled}
					onChange={(e) =>
						void set({ webcamLayoutPreset: e.target.value as typeof settings.webcamLayoutPreset })
					}
				>
					{WEBCAM_PRESETS.map((p) => (
						<option key={p.value} value={p.value}>
							{ts(p.labelKey)}
						</option>
					))}
				</select>
			</div>
			<div className={styles.paneRow}>
				<span className={styles.label}>{ts("layout.mirrorWebcam")}</span>
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
			{supportsReactiveZoom ? (
				<div className={styles.paneRow}>
					<span className={styles.label}>{ts("layout.reactiveWebcam")}</span>
					<Toggle
						checked={settings.webcamReactiveZoom}
						disabled={layoutControlsDisabled}
						onChange={(v) => void set({ webcamReactiveZoom: v })}
					/>
				</div>
			) : null}
			{isPip ? (
				<>
					<div className={styles.sectionLabel}>{ts("layout.webcamShape")}</div>
					<div
						style={{
							display: "grid",
							// `minmax(0, 1fr)` et non `1fr`. `1fr` vaut `minmax(auto, 1fr)`,
							// donc la taille MINIMALE de la piste est `auto`, ce qui resout
							// pour chaque bouton a son minimum de contenu -- et « Rounded »
							// est un mot insecable. Quatre boutons a 64,83 px plus trois
							// gouttieres de 8 px reclamaient 283,3 px la ou le panneau n'en
							// offre que 234 : les pistes refusaient de retrecir et la grille
							// debordait, en coupant le dernier bouton. `minmax(0, ...)`
							// autorise la piste a passer sous son contenu.
							gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
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
										// Sans `minWidth: 0` le bouton garde son minimum de
										// contenu et rouvre le debordement que `minmax(0, 1fr)`
										// vient de fermer sur la piste.
										minWidth: 0,
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
									<span style={{ font: "500 11px/1 var(--font-body)" }}>{ts(shape.labelKey)}</span>
								</button>
							);
						})}
					</div>
				</>
			) : null}
			{isPip ? (
				<div className={styles.sliderGrid}>
					<div className={`${styles.sliderCell} ${styles.full}`}>
						<div className={styles.head}>
							<span className={styles.label}>{ts("layout.webcamSize")}</span>
							<span className={styles.val}>{Math.round(settings.webcamSizePreset)}%</span>
						</div>
						<input
							aria-label={ts("layout.webcamSize")}
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
			{/* Le seul contrôle de l'éditeur dont l'effet dépend d'un binaire optionnel : sans la
			    bibliothèque ONNX Runtime, le compositeur dessine la webcam telle quelle et le réglage
			    ne fait rien. On demande donc à la machine plutôt que de deviner depuis la plateforme —
			    `process.platform` se trompait dans les deux sens : il cachait le contrôle sur des
			    builds Linux capables de segmenter, et le montrait sur les Macs Intel, pour lesquels
			    l'amont ne publie aucun binaire ONNX. */}
			{canSegmentCamera ? (
				<>
					<div className={styles.sectionLabel}>{ts("layout.webcamBackground")}</div>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
							gap: 8,
							padding: "0 var(--sp-4) 12px",
						}}
					>
						{CAMERA_BACKGROUND_MODES.map((mode) => {
							const isActive = settings.webcamBackgroundMode === mode.value;
							return (
								<button
									type="button"
									key={mode.value}
									className={`${styles.cursorCell} ${isActive ? styles.isActive : ""}`}
									style={{
										flexDirection: "column",
										gap: 4,
										padding: 8,
										display: "flex",
										alignItems: "center",
										minWidth: 0,
									}}
									disabled={layoutControlsDisabled}
									onClick={() => {
										void set({ webcamBackgroundMode: mode.value });
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
										{mode.icon}
									</svg>
									<span style={{ font: "500 11px/1 var(--font-body)" }}>{ts(mode.labelKey)}</span>
								</button>
							);
						})}
					</div>
					{settings.webcamBackgroundMode === "blur" ? (
						<div className={styles.sliderGrid}>
							<SliderCell
								label={ts("layout.webcamBlurIntensity")}
								value={Math.round(settings.webcamBlurIntensity * 100)}
								min={0}
								max={100}
								suffix="%"
								disabled={layoutControlsDisabled}
								onChange={(next) => setLive({ webcamBlurIntensity: next / 100 })}
								onCommit={() => void commit()}
							/>
						</div>
					) : null}
					{settings.webcamBackgroundMode === "custom" ? (
						<div style={{ padding: "0 var(--sp-4) 12px" }}>
							<WallpaperPicker
								value={settings.webcamWallpaper}
								hasDocument={hasDocument && !layoutControlsDisabled}
								onChange={(url) => void set({ webcamWallpaper: url })}
								onLiveChange={(url) => setLive({ webcamWallpaper: url })}
								onCommit={commit}
								updateNativeBackground={false}
								onPickFile={handlePickWebcamWallpaper}
							/>
							{webcamWallpaperInput}
						</div>
					) : null}
				</>
			) : null}
			<div className={styles.sectionLabel}>{ts("layout.webcamFraming")}</div>
			<div className={styles.sliderGrid}>
				<SliderCell
					label={ts("layout.webcamCropZoom")}
					value={cropZoomPct}
					min={100}
					max={300}
					suffix="%"
					disabled={layoutControlsDisabled}
					onChange={setCropZoom}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label={ts("layout.webcamCropX")}
					value={cropPanX}
					min={0}
					max={100}
					suffix="%"
					disabled={layoutControlsDisabled || webcamCrop.width >= 0.999}
					onChange={(value) => setCropPan("x", value)}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label={ts("layout.webcamCropY")}
					value={cropPanY}
					min={0}
					max={100}
					suffix="%"
					disabled={layoutControlsDisabled || webcamCrop.height >= 0.999}
					onChange={(value) => setCropPan("y", value)}
					onCommit={() => void commit()}
				/>
			</div>
		</Pane>
	);
}

// ─── Audio ────────────────────────────────────────────────────────

export function AudioPane() {
	const ts = useScopedT("settings");
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();
	return (
		<Pane title={ts("audio.title")} icon={<AudioLines size={14} />} helpText={ts("audio.help")}>
			<div className={styles.sliderGrid}>
				<SliderCell
					label={ts("audio.outputGain")}
					value={settings.audioGainDb}
					min={-AUDIO_GAIN_DB_LIMIT}
					max={AUDIO_GAIN_DB_LIMIT}
					step={0.5}
					decimals={1}
					suffix=" dB"
					disabled={!hasDocument}
					onChange={(value) => setLive({ audioGainDb: value })}
					onCommit={() => void commit()}
				/>
			</div>
			<button
				type="button"
				className={styles.secondaryBtn}
				disabled={!hasDocument}
				onClick={() => void set({ audioGainDb: 0 })}
			>
				{ts("audio.reset")}
			</button>
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
	const ts = useScopedT("settings");
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();

	// Push cursor settings into the native compositor (initial + on view activation); the
	// handlers below push diffs live. Sizes are sent as direct scales (1 = fixture default).
	// Synchro initiale : cf. NativeCompositorOverlay (`pushAllNativeParams`).

	// Built-in "Default" plus each bundled theme. When arrow and pointer art
	// differ, both sprites are shown so a pack is not previewed as arrow-only.
	const cursorThemeOptions = useMemo(
		() => [
			{
				id: DEFAULT_CURSOR_THEME_ID,
				name: ts("cursor.themeDefault"),
				previewUrls: [defaultCursorPreviewUrl],
			},
			...CURSOR_THEMES.map((theme) => {
				const preview = themePickerPreviewAssets(theme);
				const urls = [
					preview.arrow ? safeAssetUrl(preview.arrow) : defaultCursorPreviewUrl,
					...(preview.pointer ? [safeAssetUrl(preview.pointer)] : []),
				];
				return {
					id: theme.id,
					name: theme.name,
					previewUrls: urls,
				};
			}),
		],
		[ts],
	);

	return (
		<Pane
			title={ts("cursor.title")}
			icon={<MousePointerClick size={14} />}
			helpText={ts("cursor.help")}
		>
			<div className={styles.paneRow}>
				<span className={styles.label}>{ts("cursor.show")}</span>
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
				<span className={styles.label}>{ts("cursor.clipToBounds")}</span>
				<Toggle
					checked={settings.cursor.clipToBounds}
					disabled={!hasDocument}
					onChange={(v) => void set({ cursor: { clipToBounds: v } })}
				/>
			</div>
			<div className={styles.sectionLabel}>{ts("cursor.theme")}</div>
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
							<span className={styles.cursorCellPreviews}>
								{option.previewUrls.map((url) => (
									<img
										key={url}
										src={url}
										alt=""
										width={option.previewUrls.length > 1 ? 14 : 20}
										height={option.previewUrls.length > 1 ? 14 : 20}
										draggable={false}
										style={{ objectFit: "contain", pointerEvents: "none" }}
									/>
								))}
							</span>
						</button>
					);
				})}
			</div>
			<div className={styles.sliderGrid}>
				<SliderCell
					label={ts("cursor.size")}
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
					label={ts("cursor.smoothing")}
					value={settings.cursor.smoothing * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => {
						setLive({ cursor: { smoothing: v / 100 } });
						if (isNativeCompositorActive()) {
							setNativeParam("cursorSmoothing", v / 100);
						}
					}}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label={ts("cursor.motionBlur")}
					value={settings.cursor.motionBlur * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => {
						setLive({ cursor: { motionBlur: v / 100 } });
						if (isNativeCompositorActive()) {
							setNativeParam("cursorMotionBlur", v / 100);
						}
					}}
					onCommit={() => void commit()}
				/>
				{/* Wayland gives an unprivileged process no way to observe mouse
				    buttons, so on Linux this slider provably cannot change a pixel
				    at any value — see `supportsCursorClickEffects`. Dropped rather
				    than shown as a control that does nothing, exactly as
				    "Shrink on zoom" is above. */}
				{supportsCursorClickEffects() ? (
					<SliderCell
						label={ts("cursor.clickBounce")}
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
				) : null}
			</div>
		</Pane>
	);
}

// ─── Timeline (trim waveform) ──────────────────────────────────────

// ─── primitives ───────────────────────────────────────────────────

/** La pilule on/off des panneaux — exportée pour que l'inspecteur V4 l'emploie au lieu d'une
 *  case à cocher système, qui jurait avec tout le reste. */
export function Toggle({
	checked,
	disabled,
	ariaLabel,
	onChange,
}: {
	checked: boolean;
	disabled?: boolean;
	/** The switch renders no text of its own, so a screen reader has nothing to announce
	 *  unless a caller names it. Optional only because the existing call sites predate it. */
	ariaLabel?: string;
	onChange: (next: boolean) => void;
}) {
	return (
		<button
			type="button"
			className={`${styles.toggle} ${checked ? styles.isOn : ""}`}
			aria-pressed={checked}
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		/>
	);
}

/** Le slider commun des panneaux — exporté pour que l'inspecteur V4 s'en serve au lieu de
 *  restyler un `<input type="range">` isolé qui ne ressemblait à rien de l'app. Il porte aussi
 *  la bonne cadence : `onChange` en direct, `onCommit` à la fin du geste. */
export function SliderCell({
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
	showValue = true,
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
	/** À passer `false` quand le libellé porte déjà la valeur (certaines chaînes i18n
	 *  l'interpolent), sans quoi elle s'affiche deux fois. */
	showValue?: boolean;
}) {
	return (
		<div className={styles.sliderCell}>
			<div className={styles.head}>
				<span className={styles.label}>{label}</span>
				{showValue ? (
					<span className={styles.val}>
						{value.toFixed(decimals)}
						{suffix}
					</span>
				) : null}
			</div>
			{/* The visible label is a <span>, not a <label htmlFor>, so without this the
			    input has no accessible name at all — a screen reader announces "slider",
			    and a test cannot tell two of them apart. That was survivable while a pane
			    held one slider; the webcam framing row makes it four. */}
			<input
				aria-label={label}
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
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
