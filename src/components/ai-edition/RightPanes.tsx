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
} from "lucide-react";
import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import defaultCursorPreviewUrl from "@/assets/cursors/Cursor=Default.svg";
import type { AxcutClip, AxcutTranscript } from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { getAssetPath } from "@/lib/assetPath";
import { CURSOR_THEMES, DEFAULT_CURSOR_THEME_ID } from "@/lib/cursor/cursorThemes";
import { resolveImageWallpaperUrl, WALLPAPER_PATHS } from "@/lib/wallpaper";
import styles from "./NewEditorShell.module.css";
import { TranscriptEditor } from "./TranscriptEditor";

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

// ponytail: keep the gradient palette small and curated — every block renders
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
	const { settings, set, hasDocument } = useEditorSettings();
	const [tab, setTab] = useState<"image" | "color" | "gradient">("image");
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const customUrls = useMemoCustomWallpapers(settings.wallpaper);

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
			)}
		</Pane>
	);
}

// ponytail: keep the user's last data: URL after they switch tabs so the Image
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
		if (next) onPick(next);
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
						onClick={() => onPick(c)}
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

export function TranscriptPane({
	transcript,
	clips,
	currentTimeSec,
	onSeek,
	onDropWordRange,
	onTranscribe,
	canTranscribe,
	isTranscribing,
}: {
	transcript: AxcutTranscript | null;
	clips: AxcutClip[];
	currentTimeSec: number;
	onSeek: (sec: number) => void;
	onDropWordRange: (start: number, end: number) => void;
	onTranscribe: () => void;
	canTranscribe: boolean;
	isTranscribing: boolean;
}) {
	if (!transcript) {
		return (
			<Pane
				title="Current transcription"
				icon={<FileText size={14} />}
				helpText="The transcript of the spoken words, generated on-device by Whisper. Click a word to seek; select a range to cut it from the timeline."
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
						No transcript yet
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
				<TranscriptEditor
					transcript={transcript}
					clips={clips}
					currentTimeSec={currentTimeSec}
					onSeek={onSeek}
					onDropWordRange={onDropWordRange}
				/>
			</div>
		</div>
	);
}

// ─── Video Effects ─────────────────────────────────────────────────

export function VideoEffectsPane() {
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();
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
					onChange={(v) => void set({ showBlur: v })}
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
					onChange={(v) => setLive({ motionBlurAmount: v / 100 })}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Shadow"
					value={settings.shadowIntensity * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => setLive({ shadowIntensity: v / 100 })}
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
					onChange={(v) => setLive({ borderRadius: v })}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Padding"
					value={settings.padding}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => setLive({ padding: v })}
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
	// ponytail: the mask shape picker only makes sense for Picture-in-Picture.
	// Dual-frame (side-by-side) and vertical-stack (top/bottom) hardcode a
	// rectangle in the legacy layout math, so we hide those controls when the
	// preset isn't PiP.
	const isPip = settings.webcamLayoutPreset === "picture-in-picture";
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
					disabled={!hasDocument}
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
					disabled={!hasDocument}
					onChange={(v) => void set({ webcamMirrored: v })}
				/>
			</div>
			<div className={styles.paneRow}>
				<span className="label">Shrink on zoom</span>
				<Toggle
					checked={settings.webcamReactiveZoom}
					disabled={!hasDocument}
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
									disabled={!hasDocument}
									onClick={() => void set({ webcamMaskShape: shape.value })}
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
							disabled={!hasDocument}
							onChange={(e) => setLive({ webcamSizePreset: Number(e.target.value) })}
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
					onChange={(v) => void set({ cursor: { show: v } })}
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
					onChange={(v) => setLive({ cursor: { size: v / 10 } })}
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
					onChange={(v) => setLive({ cursor: { clickBounce: v / 10 } })}
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

// ponytail: legacy color wheel / hue track styling was a cosmetic placeholder —
// the active BackgroundColorTab uses real pickers (color input + hex text) so
// the static style helpers are no longer needed.
