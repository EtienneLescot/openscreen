import {
	AlertTriangle,
	Crop,
	FolderOpen,
	FolderPlus,
	Loader2,
	Maximize2,
	Pencil,
	Plus,
	RefreshCw,
	RotateCcw,
	Triangle,
	X,
} from "lucide-react";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { CropRegion } from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import { toAxcutTranscriptDsl } from "@/lib/ai-edition/document/transcribe";
import type { AxcutClip, AxcutTranscript } from "@/lib/ai-edition/schema";
import { formatSeconds } from "@/lib/ai-edition/timeline/virtual-preview";
import styles from "./NewEditorShell.module.css";
import type { VideoSource } from "./VirtualPreview";

// ponytail: keep the UI's language list literal in one place. Mirrors
// `transcriptLanguageSchema` in schema/index.ts; if the schema gains a
// language, add it here too.
const REGEN_LANGUAGES = [
	"auto",
	"en",
	"fr",
	"de",
	"es",
	"it",
	"pt",
	"nl",
	"ja",
	"ko",
	"zh",
] as const;

type TranscriptLanguage = (typeof REGEN_LANGUAGES)[number];

const LANGUAGE_LABELS: Record<TranscriptLanguage, string> = {
	auto: "Auto",
	en: "EN",
	fr: "FR",
	de: "DE",
	es: "ES",
	it: "IT",
	pt: "PT",
	nl: "NL",
	ja: "JA",
	ko: "KO",
	zh: "ZH",
};

function formatTc(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
	const m = Math.floor(sec / 60);
	const s = sec - m * 60;
	return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

interface BaseModalProps {
	open: boolean;
	onClose: () => void;
}

function useEscape(open: boolean, onClose: () => void) {
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);
}

export function ModalShell({
	open,
	onClose,
	title,
	subtitle,
	wide,
	children,
}: BaseModalProps & {
	title: string;
	subtitle?: string;
	wide?: boolean;
	children: ReactNode;
}) {
	const tc = useScopedT("common");
	useEscape(open, onClose);
	if (!open) return null;
	return (
		<div
			className={`${styles.modal} ${open ? styles.isOpen : ""}`}
			role="dialog"
			aria-modal="true"
			aria-labelledby="modal-title"
		>
			<div className={styles.modalBackdrop} aria-hidden onClick={onClose} />
			<div className={`${styles.modalCard} ${wide ? styles.wide : ""}`}>
				<header className={styles.modalHead}>
					<div>
						<h2 id="modal-title">{title}</h2>
						{subtitle ? <p>{subtitle}</p> : null}
					</div>
					<button
						type="button"
						className={styles.closeBtn}
						onClick={onClose}
						title={tc("actions.close")}
						aria-label={tc("actions.close")}
					>
						<X size={18} />
					</button>
				</header>
				<div className={styles.modalBody}>{children}</div>
			</div>
		</div>
	);
}

interface ProjectItem {
	id: string;
	title: string;
	updatedAt: string;
}

interface OpenProjectModalProps extends BaseModalProps {
	projects: ProjectItem[];
	activeProjectId: string | null;
	onSelect: (id: string) => void;
	onBrowse: () => void;
}

export function OpenProjectModal({
	open,
	onClose,
	projects,
	activeProjectId,
	onSelect,
	onBrowse,
}: OpenProjectModalProps) {
	const t = useScopedT("editor");
	const [query, setQuery] = useState("");
	const filtered = projects.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()));
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t("openProjectDialog.title")}
			subtitle={t("openProjectDialog.subtitle")}
			wide
		>
			<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
				<FolderOpen size={14} style={{ color: "var(--muted)" }} />
				<input
					type="search"
					placeholder={t("openProjectDialog.searchPlaceholder")}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					style={{
						flex: 1,
						height: 36,
						padding: "0 12px",
						border: "1px solid var(--border)",
						borderRadius: "var(--r-md)",
						background: "var(--surface)",
						color: "var(--fg)",
						font: "400 13px/1 var(--font-body)",
						outline: "none",
					}}
				/>
			</div>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					gap: 2,
					marginBottom: 12,
					// Cap the list so the footer's "Browse files" button stays visible
					// instead of being pushed below the fold when there are many projects;
					// the list scrolls internally.
					maxHeight: "48vh",
					overflowY: "auto",
					scrollbarWidth: "thin",
					scrollbarColor: "var(--border-hi) transparent",
				}}
			>
				{filtered.length === 0 ? (
					<p style={{ color: "var(--muted)", fontSize: 12, padding: 16, textAlign: "center" }}>
						{t("openProjectDialog.noMatches", { query })}
					</p>
				) : (
					filtered.map((p) => {
						const isActive = p.id === activeProjectId;
						return (
							<button
								type="button"
								key={p.id}
								onClick={() => {
									onSelect(p.id);
									onClose();
								}}
								style={{
									display: "grid",
									gridTemplateColumns: "36px 1fr auto",
									alignItems: "center",
									gap: 12,
									padding: "10px 12px",
									border: "none",
									borderRadius: "var(--r-md)",
									background: isActive ? "var(--accent-wash)" : "transparent",
									boxShadow: isActive ? "inset 0 0 0 1px var(--accent)" : "none",
									color: "var(--fg)",
									cursor: "pointer",
									textAlign: "left",
									font: "inherit",
								}}
							>
								<div
									style={{
										width: 36,
										height: 36,
										borderRadius: "var(--r-sm)",
										background: "linear-gradient(135deg, var(--brand-lo), var(--brand))",
										display: "grid",
										placeItems: "center",
										color: "var(--accent-on)",
									}}
								>
									<FolderOpen size={18} />
								</div>
								<div style={{ minWidth: 0 }}>
									<div
										style={{
											font: "500 13px/1.3 var(--font-body)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										}}
									>
										{p.title}
									</div>
									<div
										style={{
											font: "400 11px/1.4 var(--font-mono)",
											color: "var(--muted)",
											marginTop: 2,
										}}
									>
										id: {p.id.slice(0, 8)}
									</div>
								</div>
								<span
									style={{
										font: "400 11px/1 var(--font-mono)",
										color: "var(--meta)",
										whiteSpace: "nowrap",
									}}
								>
									{new Date(p.updatedAt).toLocaleDateString()}
								</span>
							</button>
						);
					})
				)}
			</div>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					paddingTop: 12,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<span style={{ fontSize: 12, color: "var(--muted)" }}>
					<kbd
						style={{
							font: "500 11px/1 var(--font-mono)",
							padding: "2px 6px",
							borderRadius: 4,
							background: "var(--surface-2)",
							border: "1px solid var(--border)",
							color: "var(--fg)",
						}}
					>
						↑↓
					</kbd>{" "}
					{t("openProjectDialog.navigateHint")}{" "}
					<kbd
						style={{
							font: "500 11px/1 var(--font-mono)",
							padding: "2px 6px",
							borderRadius: 4,
							background: "var(--surface-2)",
							border: "1px solid var(--border)",
							color: "var(--fg)",
						}}
					>
						Enter
					</kbd>{" "}
					{t("openProjectDialog.openHint")}
				</span>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={() => {
						onBrowse();
						onClose();
					}}
				>
					<FolderOpen size={14} />
					{t("openProjectDialog.browseFiles")}
				</button>
			</div>
		</ModalShell>
	);
}

type Template = "blank" | "screen-recording" | "import" | "template";

interface NewProjectModalProps extends BaseModalProps {
	onCreate: (title: string) => void;
}

export function NewProjectModal({ open, onClose, onCreate }: NewProjectModalProps) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	const [title, setTitle] = useState(t("newProjectDialog.defaultTitle"));
	const [template, setTemplate] = useState<Template>("blank");
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t("newProjectDialog.title")}
			subtitle={t("newProjectDialog.subtitle")}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
				<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					<label
						htmlFor="np-name"
						style={{
							font: "500 11px/1 var(--font-body)",
							textTransform: "uppercase",
							letterSpacing: "0.06em",
							color: "var(--muted)",
						}}
					>
						{t("newProjectDialog.nameLabel")}
					</label>
					<input
						id="np-name"
						type="text"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						style={{
							height: 36,
							padding: "0 12px",
							border: "1px solid var(--border)",
							borderRadius: "var(--r-md)",
							background: "var(--surface)",
							color: "var(--fg)",
							font: "400 13px/1 var(--font-body)",
						}}
					/>
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					<label
						style={{
							font: "500 11px/1 var(--font-body)",
							textTransform: "uppercase",
							letterSpacing: "0.06em",
							color: "var(--muted)",
						}}
					>
						{t("newProjectDialog.startingPointLabel")}
					</label>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(2, 1fr)",
							gap: 8,
						}}
					>
						<TemplateCell
							icon={<FolderPlus size={18} />}
							title={t("newProjectDialog.templates.blankTitle")}
							desc={t("newProjectDialog.templates.blankDesc")}
							active={template === "blank"}
							onClick={() => setTemplate("blank")}
						/>
						<TemplateCell
							icon={<Crop size={18} />}
							title={t("newProjectDialog.templates.screenRecordingTitle")}
							desc={t("newProjectDialog.templates.screenRecordingDesc")}
							active={template === "screen-recording"}
							onClick={() => setTemplate("screen-recording")}
						/>
						<TemplateCell
							icon={<Plus size={18} />}
							title={t("mediaStage.importMedia")}
							desc={t("newProjectDialog.templates.importMediaDesc")}
							active={template === "import"}
							onClick={() => setTemplate("import")}
						/>
						<TemplateCell
							icon={<Crop size={18} />}
							title={t("newProjectDialog.templates.fromTemplateTitle")}
							desc={t("newProjectDialog.templates.fromTemplateDesc")}
							active={template === "template"}
							onClick={() => setTemplate("template")}
						/>
					</div>
				</div>

				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						gap: 8,
						paddingTop: 12,
						borderTop: "1px solid var(--border-soft)",
					}}
				>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={onClose}
					>
						{tc("actions.cancel")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={() => {
							onCreate(title.trim() || t("newProjectDialog.defaultTitle"));
							onClose();
						}}
					>
						<Plus size={14} />
						{t("newProjectDialog.create")}
					</button>
				</div>
			</div>
		</ModalShell>
	);
}

function TemplateCell({
	icon,
	title,
	desc,
	active,
	onClick,
}: {
	icon: ReactNode;
	title: string;
	desc: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-start",
				gap: 8,
				padding: 12,
				border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
				borderRadius: "var(--r-md)",
				background: active ? "var(--accent-wash)" : "var(--surface)",
				boxShadow: active ? "0 0 0 1px var(--accent)" : "none",
				color: "var(--fg)",
				cursor: "pointer",
				textAlign: "left",
				font: "inherit",
			}}
		>
			<span
				style={{
					width: 36,
					height: 36,
					borderRadius: "var(--r-sm)",
					background: active ? "var(--accent)" : "var(--surface-2)",
					color: active ? "var(--accent-on)" : "var(--muted)",
					display: "grid",
					placeItems: "center",
				}}
			>
				{icon}
			</span>
			<span style={{ font: "500 13px/1.3 var(--font-body)" }}>{title}</span>
			<span style={{ font: "400 11px/1.4 var(--font-body)", color: "var(--muted)" }}>{desc}</span>
		</button>
	);
}

// `ratio` is width/height (matches the label directly: "16:9" → 16/9 means
// a region 16 units wide for every 9 tall).
const CROP_RATIOS: Array<{ value: string; label: string; ratio: number | null }> = [
	{ value: "free", label: "Free", ratio: null },
	{ value: "16:9", label: "16:9", ratio: 16 / 9 },
	{ value: "9:16", label: "9:16", ratio: 9 / 16 },
	{ value: "1:1", label: "1:1", ratio: 1 },
	{ value: "4:3", label: "4:3", ratio: 4 / 3 },
	{ value: "3:4", label: "3:4", ratio: 3 / 4 },
	{ value: "21:9", label: "21:9", ratio: 21 / 9 },
];

// `region.width`/`region.height` are fractions of the source frame, not a
// visual aspect ratio — a region that's 100% wide and 56.25% tall on a 16:9
// source renders as a 16:9 rectangle on screen, not a "1 : 0.5625" one. The
// actual on-screen ratio is the fraction ratio scaled by the source video's
// own pixel aspect ratio, so detecting/applying a preset must go through
// `videoAspectRatio` (source width/height in pixels) in both directions.
function detectRatio(r: CropRegion, videoAspectRatio: number): string {
	const candidates = CROP_RATIOS.filter((c) => c.ratio !== null);
	if (r.height === 0) return "free";
	const visualRatio = (r.width / r.height) * videoAspectRatio;
	for (const c of candidates) {
		if (c.ratio === null) continue;
		if (Math.abs(visualRatio - c.ratio) / c.ratio < 0.02) return c.value;
	}
	return "free";
}

// Largest crop rectangle (percentages of the frame) whose fraction-space ratio
// is `fr` (= width/height, already converted from the visual ratio through the
// source's pixel aspect ratio), centered on whichever axis has slack. One
// dimension fills the frame; the other is derived so the result never overflows.
function centeredFitPct(fr: number): { x: number; y: number; w: number; h: number } {
	if (!(fr > 0)) return { x: 0, y: 0, w: 100, h: 100 };
	if (fr >= 1) {
		const h = 100 / fr;
		return { x: 0, y: (100 - h) / 2, w: 100, h };
	}
	const w = 100 * fr;
	return { x: (100 - w) / 2, y: 0, w, h: 100 };
}

const MIN_PCT = 4;
const clampPct = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type ResizeEdges = { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean };

function CropField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number;
	onChange: (n: number) => void;
}) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
			<label
				style={{
					font: "600 10px/1 var(--font-mono)",
					letterSpacing: "0.04em",
					textTransform: "uppercase",
					color: "var(--muted)",
				}}
			>
				{label}
			</label>
			<input
				type="number"
				value={value}
				min={0}
				max={100}
				onChange={(e) => onChange(Number(e.target.value))}
				style={{
					width: "100%",
					padding: "8px 10px",
					font: "500 14px/1 var(--font-mono)",
					color: "var(--fg-2)",
					background: "var(--surface)",
					border: "1px solid var(--border)",
					borderRadius: 6,
					outline: "none",
				}}
			/>
		</div>
	);
}

export interface AssetMeta {
	label: string;
	durationSec?: number;
}

const IDENTITY_CROP: CropRegion = { x: 0, y: 0, width: 1, height: 1 };

interface EditClipModalProps extends BaseModalProps {
	clip: AxcutClip | null;
	assetMeta: AssetMeta | null;
	videoSources: VideoSource[];
	/** `cropRegion` is `undefined` when the crop section wasn't touched (Reset
	 * back to the clip's stored value) — the caller can skip the write in that
	 * case — and `null` when the user explicitly reset it to "no crop". */
	onApply: (sourceStartSec: number, sourceEndSec: number, cropRegion?: CropRegion | null) => void;
}

// Mirrors Axcut's ClipEditDialog: an embedded preview of just this clip plus
// a draggable dual-handle range over the asset's full source duration —
// replaces the old numeric-input-only form. Trim range AND crop are both
// per-clip and both edited here (see clipSchema.cropRegion / useTimeline's
// updateClipSourceRange + updateClipCrop) — crop used to be a document-wide
// setting behind its own facet-rail button; it's a framing choice for one
// piece of footage, so it belongs with the rest of this clip's edits.
export function EditClipModal({
	open,
	onClose,
	clip,
	assetMeta,
	videoSources,
	onApply,
}: EditClipModalProps) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	const ts = useScopedT("settings");
	const trackRef = useRef<HTMLDivElement | null>(null);
	const [draftStart, setDraftStart] = useState(0);
	const [draftEnd, setDraftEnd] = useState(0);
	const [activeEdge, setActiveEdge] = useState<"start" | "end" | null>(null);

	// Crop draft — percentages (0-100), same shape/units CropModal used to
	// keep locally before it was folded in here.
	const [cropXPct, setCropXPct] = useState(0);
	const [cropYPct, setCropYPct] = useState(0);
	const [cropWPct, setCropWPct] = useState(100);
	const [cropHPct, setCropHPct] = useState(100);
	const [cropRatio, setCropRatio] = useState("free");
	const [cropTouched, setCropTouched] = useState(false);
	// Source video's real pixel aspect ratio (width/height) — needed to convert
	// between a preset's visual ratio (e.g. 16/9) and the crop region's
	// fraction-of-frame width/height. 16/9 is just a placeholder until the
	// crop <video>'s real metadata loads (see the effect below).
	const [videoAspectRatio, setVideoAspectRatio] = useState(16 / 9);
	const cropFrameRef = useRef<HTMLDivElement | null>(null);
	const cropVideoRef = useRef<HTMLVideoElement | null>(null);

	// ponytail: sync local drag state to the clip every time the modal opens.
	// `open` is the trigger so external clip changes don't fight the user mid-edit.
	useEffect(() => {
		if (!open || !clip) return;
		setDraftStart(clip.sourceStartSec);
		setDraftEnd(clip.sourceEndSec ?? clip.sourceStartSec);
		setActiveEdge(null);
		const region = clip.cropRegion ?? IDENTITY_CROP;
		setCropXPct(Math.round(region.x * 100));
		setCropYPct(Math.round(region.y * 100));
		setCropWPct(Math.round(region.width * 100));
		setCropHPct(Math.round(region.height * 100));
		setCropTouched(false);
	}, [open, clip]);

	// Re-detect the active ratio preset whenever the stored region or the
	// video's real aspect ratio changes — the latter only becomes accurate
	// once the crop <video>'s metadata loads (see the effect below), so this
	// re-runs a beat after the sync-on-open effect above with the real value.
	// Skipped once the user starts touching the crop so it doesn't fight
	// their own free-form edits.
	useEffect(() => {
		if (!open || !clip || cropTouched) return;
		const region = clip.cropRegion ?? IDENTITY_CROP;
		setCropRatio(detectRatio(region, videoAspectRatio));
	}, [open, clip, videoAspectRatio, cropTouched]);

	// Crop preview: a paused still frame is enough to judge a crop (mirrors
	// the standalone CropModal this replaced) — seek once per open to the
	// clip's original in-point, not on every trim drag.
	useEffect(() => {
		if (!open || !clip) return;
		const v = cropVideoRef.current;
		if (!v) return;
		const seek = () => {
			v.pause();
			if (Number.isFinite(clip.sourceStartSec)) v.currentTime = clip.sourceStartSec;
			if (v.videoWidth > 0 && v.videoHeight > 0) {
				setVideoAspectRatio(v.videoWidth / v.videoHeight);
			}
		};
		if (v.readyState >= 1) seek();
		else v.addEventListener("loadedmetadata", seek, { once: true });
		return () => v.removeEventListener("loadedmetadata", seek);
	}, [open, clip]);

	if (!clip) return null;

	const sourceDurationSec = Math.max(assetMeta?.durationSec ?? 0, clip.sourceEndSec ?? 0, 0.001);
	const durationSec = Math.max(0.001, draftEnd - draftStart);
	const hasTrimChanges =
		Math.abs(draftStart - clip.sourceStartSec) > 0.001 ||
		Math.abs(draftEnd - (clip.sourceEndSec ?? 0)) > 0.001;
	const hasChanges = hasTrimChanges || cropTouched;
	const clipSources = videoSources.filter((s) => s.id === clip.assetId);
	const cropPreviewSource = clipSources[0] ?? null;

	const startDrag = (edge: "start" | "end", event: ReactPointerEvent<HTMLButtonElement>) => {
		const track = trackRef.current;
		if (!track) return;
		event.preventDefault();
		event.stopPropagation();
		const widthPx = Math.max(1, track.clientWidth);
		const startClientX = event.clientX;
		const startDraftStart = draftStart;
		const startDraftEnd = draftEnd;
		setActiveEdge(edge);
		const move = (moveEvent: PointerEvent) => {
			const deltaSec = ((moveEvent.clientX - startClientX) / widthPx) * sourceDurationSec;
			if (edge === "start") {
				setDraftStart(Math.min(Math.max(startDraftStart + deltaSec, 0), startDraftEnd - 0.05));
			} else {
				setDraftEnd(
					Math.max(Math.min(startDraftEnd + deltaSec, sourceDurationSec), startDraftStart + 0.05),
				);
			}
		};
		const end = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			setActiveEdge(null);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end, { once: true });
	};

	const handleCropRatioChange = (next: string) => {
		setCropTouched(true);
		setCropRatio(next);
		const candidate = CROP_RATIOS.find((c) => c.value === next);
		// "Free" keeps whatever the user currently has; a preset snaps the crop to
		// the largest centered rectangle of that exact ratio (and, via the locked
		// field/handle logic below, keeps every later edit at that ratio).
		if (!candidate?.ratio) return;
		const fit = centeredFitPct(candidate.ratio / videoAspectRatio);
		setCropXPct(Math.round(fit.x));
		setCropYPct(Math.round(fit.y));
		setCropWPct(Math.round(fit.w));
		setCropHPct(Math.round(fit.h));
	};

	// Fraction-space width/height ratio the crop is locked to while a preset is
	// active (null for "Free"). Numeric fields and resize handles both honor it so
	// the user can move/scale the crop but never change its aspect ratio.
	const activePresetRatio = CROP_RATIOS.find((c) => c.value === cropRatio)?.ratio ?? null;
	const lockedFractionRatio = activePresetRatio ? activePresetRatio / videoAspectRatio : null;

	// Ratio-aware numeric field setters. With a preset active, changing one side
	// derives the other (and clamps both to the frame); "Free" edits each axis
	// independently. All keep the rectangle inside the frame.
	const applyCropX = (v: number) => {
		setCropTouched(true);
		setCropXPct(Math.round(clampPct(v, 0, 100 - cropWPct)));
	};
	const applyCropY = (v: number) => {
		setCropTouched(true);
		setCropYPct(Math.round(clampPct(v, 0, 100 - cropHPct)));
	};
	const applyCropW = (v: number) => {
		setCropTouched(true);
		if (lockedFractionRatio) {
			let w = clampPct(v, MIN_PCT, 100 - cropXPct);
			let h = w / lockedFractionRatio;
			if (h > 100 - cropYPct) {
				h = 100 - cropYPct;
				w = h * lockedFractionRatio;
			}
			setCropWPct(Math.round(w));
			setCropHPct(Math.round(h));
		} else {
			setCropWPct(Math.round(clampPct(v, MIN_PCT, 100 - cropXPct)));
		}
	};
	const applyCropH = (v: number) => {
		setCropTouched(true);
		if (lockedFractionRatio) {
			let h = clampPct(v, MIN_PCT, 100 - cropYPct);
			let w = h * lockedFractionRatio;
			if (w > 100 - cropXPct) {
				w = 100 - cropXPct;
				h = w / lockedFractionRatio;
			}
			setCropWPct(Math.round(w));
			setCropHPct(Math.round(h));
		} else {
			setCropHPct(Math.round(clampPct(v, MIN_PCT, 100 - cropYPct)));
		}
	};

	// Drag the whole crop region (keeps size, moves x/y).
	const startCropMove = (e: ReactPointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const el = cropFrameRef.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		const startX = e.clientX;
		const startY = e.clientY;
		const start = { x: cropXPct, y: cropYPct, w: cropWPct, h: cropHPct };
		setCropTouched(true);
		const move = (ev: PointerEvent) => {
			const dxPct = ((ev.clientX - startX) / r.width) * 100;
			const dyPct = ((ev.clientY - startY) / r.height) * 100;
			setCropXPct(Math.round(clampPct(start.x + dxPct, 0, 100 - start.w)));
			setCropYPct(Math.round(clampPct(start.y + dyPct, 0, 100 - start.h)));
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	// Drag one of the 8 edge/corner handles to resize. When a fixed ratio is
	// active, the opposite dimension follows to keep width/height locked.
	const startCropResize = (edges: ResizeEdges) => (e: ReactPointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const el = cropFrameRef.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		const startX = e.clientX;
		const startY = e.clientY;
		const start = { x: cropXPct, y: cropYPct, w: cropWPct, h: cropHPct };
		// Fraction-space ratio the resize is locked to (null for "Free").
		const fr = lockedFractionRatio;
		setCropTouched(true);
		const move = (ev: PointerEvent) => {
			const dxPct = ((ev.clientX - startX) / r.width) * 100;
			const dyPct = ((ev.clientY - startY) / r.height) * 100;
			let { x, y, w, h } = start;
			if (edges.left) {
				const nx = clampPct(start.x + dxPct, 0, start.x + start.w - MIN_PCT);
				w = start.w - (nx - start.x);
				x = nx;
			}
			if (edges.right) {
				w = clampPct(start.w + dxPct, MIN_PCT, 100 - start.x);
			}
			if (edges.top) {
				const ny = clampPct(start.y + dyPct, 0, start.y + start.h - MIN_PCT);
				h = start.h - (ny - start.y);
				y = ny;
			}
			if (edges.bottom) {
				h = clampPct(start.h + dyPct, MIN_PCT, 100 - start.y);
			}
			if (fr) {
				// Locked ratio: the crop stays a fixed shape anchored at the corner the
				// user isn't dragging. The dragged size is capped at the largest rect of
				// this ratio that fits from that anchor — so it's simply sized to fit,
				// never placed out of frame. (A crop can't leave the frame, so there is
				// no out-of-bounds state to correct after the fact.)
				const fixedLeft = !edges.left; // the x-edge that stays put
				const fixedTop = !edges.top; // the y-edge that stays put
				const anchorX = fixedLeft ? start.x : start.x + start.w;
				const anchorY = fixedTop ? start.y : start.y + start.h;
				const roomW = fixedLeft ? 100 - anchorX : anchorX;
				const roomH = fixedTop ? 100 - anchorY : anchorY;
				// Which axis the pointer drives; the other is derived from the ratio.
				const drivenByHeight = (edges.top || edges.bottom) && !(edges.left || edges.right);
				let nextW = Math.min(drivenByHeight ? h * fr : w, roomW, roomH * fr);
				nextW = Math.max(MIN_PCT, nextW);
				let nextH = nextW / fr;
				if (nextH < MIN_PCT) {
					nextH = MIN_PCT;
					nextW = nextH * fr;
				}
				w = nextW;
				h = nextH;
				x = fixedLeft ? anchorX : anchorX - w;
				y = fixedTop ? anchorY : anchorY - h;
			}
			setCropXPct(Math.round(x));
			setCropYPct(Math.round(y));
			setCropWPct(Math.round(w));
			setCropHPct(Math.round(h));
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	const cropHandleStyle = (pos: React.CSSProperties): React.CSSProperties => ({
		position: "absolute",
		width: 10,
		height: 10,
		borderRadius: 3,
		background: "var(--fg)",
		border: "1px solid var(--overlay-dark)",
		...pos,
	});

	const handleReset = () => {
		setDraftStart(clip.sourceStartSec);
		setDraftEnd(clip.sourceEndSec ?? clip.sourceStartSec);
		const region = clip.cropRegion ?? IDENTITY_CROP;
		setCropXPct(Math.round(region.x * 100));
		setCropYPct(Math.round(region.y * 100));
		setCropWPct(Math.round(region.width * 100));
		setCropHPct(Math.round(region.height * 100));
		setCropRatio(detectRatio(region, videoAspectRatio));
		setCropTouched(false);
	};
	const handleApply = () => {
		const nextCrop: CropRegion = {
			x: Math.max(0, Math.min(1, cropXPct / 100)),
			y: Math.max(0, Math.min(1, cropYPct / 100)),
			width: Math.max(0.01, Math.min(1, cropWPct / 100)),
			height: Math.max(0.01, Math.min(1, cropHPct / 100)),
		};
		const isIdentity =
			nextCrop.x === 0 && nextCrop.y === 0 && nextCrop.width === 1 && nextCrop.height === 1;
		onApply(draftStart, draftEnd, cropTouched ? (isIdentity ? null : nextCrop) : undefined);
		onClose();
	};

	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t("editClipDialog.title")}
			subtitle={assetMeta?.label ?? undefined}
			wide
		>
			<div
				ref={cropFrameRef}
				style={{
					position: "relative",
					width: "100%",
					height: 230,
					maxWidth: 409,
					margin: "0 auto 14px",
					flexShrink: 0,
					background: "#0a0b0e",
					borderRadius: "var(--r-md)",
					border: "1px solid var(--border)",
					overflow: "hidden",
				}}
			>
				{cropPreviewSource ? (
					<video
						ref={cropVideoRef}
						src={cropPreviewSource.src}
						muted
						playsInline
						style={{
							position: "absolute",
							inset: 0,
							width: "100%",
							height: "100%",
							objectFit: "contain",
							background: "#000",
						}}
					/>
				) : null}
				<div
					style={{
						position: "absolute",
						left: `${cropXPct}%`,
						top: `${cropYPct}%`,
						width: `${cropWPct}%`,
						height: `${cropHPct}%`,
						border: "1.5px solid var(--fg)",
						borderRadius: 4,
						boxShadow: "0 0 0 9999px var(--overlay-dark)",
						cursor: "move",
					}}
					onPointerDown={startCropMove}
				>
					<div
						onPointerDown={startCropResize({ left: true, top: true })}
						style={cropHandleStyle({ left: -5, top: -5, cursor: "nwse-resize" })}
					/>
					<div
						onPointerDown={startCropResize({ right: true, top: true })}
						style={cropHandleStyle({ right: -5, top: -5, cursor: "nesw-resize" })}
					/>
					<div
						onPointerDown={startCropResize({ left: true, bottom: true })}
						style={cropHandleStyle({ left: -5, bottom: -5, cursor: "nesw-resize" })}
					/>
					<div
						onPointerDown={startCropResize({ right: true, bottom: true })}
						style={cropHandleStyle({ right: -5, bottom: -5, cursor: "nwse-resize" })}
					/>
					<div
						onPointerDown={startCropResize({ top: true })}
						style={cropHandleStyle({ left: "50%", top: -5, marginLeft: -5, cursor: "ns-resize" })}
					/>
					<div
						onPointerDown={startCropResize({ bottom: true })}
						style={cropHandleStyle({
							left: "50%",
							bottom: -5,
							marginLeft: -5,
							cursor: "ns-resize",
						})}
					/>
					<div
						onPointerDown={startCropResize({ left: true })}
						style={cropHandleStyle({ top: "50%", left: -5, marginTop: -5, cursor: "ew-resize" })}
					/>
					<div
						onPointerDown={startCropResize({ right: true })}
						style={cropHandleStyle({
							top: "50%",
							right: -5,
							marginTop: -5,
							cursor: "ew-resize",
						})}
					/>
				</div>
			</div>

			<div style={{ flexShrink: 0 }}>
				<div style={{ display: "flex", gap: 24, marginBottom: 10 }}>
					<RangeStat label={t("editClipDialog.start")} value={formatSeconds(draftStart)} />
					<RangeStat label={t("editClipDialog.end")} value={formatSeconds(draftEnd)} />
					<RangeStat label={t("editClipDialog.duration")} value={formatSeconds(durationSec)} />
				</div>

				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						font: "500 10px/1.4 var(--font-mono)",
						color: "var(--muted)",
						marginBottom: 4,
					}}
				>
					<span>0:00.0</span>
					<span>{formatSeconds(sourceDurationSec)}</span>
				</div>
				<div
					ref={trackRef}
					style={{
						position: "relative",
						height: 32,
						flexShrink: 0,
						background: "var(--surface-2)",
						borderRadius: "var(--r-sm)",
					}}
				>
					<div
						style={{
							position: "absolute",
							inset: 0,
							width: `${(draftStart / sourceDurationSec) * 100}%`,
							background: "var(--overlay-dark)",
							borderRadius: "var(--r-sm) 0 0 var(--r-sm)",
						}}
					/>
					<div
						className={activeEdge ? styles.editClipRangeDragging : undefined}
						style={{
							position: "absolute",
							top: 0,
							bottom: 0,
							left: `${(draftStart / sourceDurationSec) * 100}%`,
							width: `${Math.max(0.5, (durationSec / sourceDurationSec) * 100)}%`,
							background: "var(--accent-wash)",
							border: "1px solid var(--accent)",
							borderRadius: "var(--r-sm)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
						}}
					>
						<button
							type="button"
							onPointerDown={(e) => startDrag("start", e)}
							aria-label={t("editClipDialog.adjustStart")}
							title={t("editClipDialog.adjustStart")}
							style={{
								position: "absolute",
								left: -6,
								top: 0,
								bottom: 0,
								width: 12,
								cursor: "ew-resize",
								background: "var(--accent)",
								border: 0,
								borderRadius: 3,
								padding: 0,
							}}
						/>
						<span
							style={{
								font: "500 11px/1.4 var(--font-mono)",
								color: "var(--accent-on)",
								pointerEvents: "none",
								whiteSpace: "nowrap",
							}}
						>
							{formatSeconds(draftStart)}–{formatSeconds(draftEnd)}
						</span>
						<button
							type="button"
							onPointerDown={(e) => startDrag("end", e)}
							aria-label={t("editClipDialog.adjustEnd")}
							title={t("editClipDialog.adjustEnd")}
							style={{
								position: "absolute",
								right: -6,
								top: 0,
								bottom: 0,
								width: 12,
								cursor: "ew-resize",
								background: "var(--accent)",
								border: 0,
								borderRadius: 3,
								padding: 0,
							}}
						/>
					</div>
					<div
						style={{
							position: "absolute",
							top: 0,
							bottom: 0,
							right: 0,
							width: `${Math.max(0, ((sourceDurationSec - draftEnd) / sourceDurationSec) * 100)}%`,
							background: "var(--overlay-dark)",
							borderRadius: "0 var(--r-sm) var(--r-sm) 0",
						}}
					/>
				</div>
			</div>

			<div
				style={{
					paddingTop: 8,
					marginTop: 8,
					flexShrink: 0,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(4, 1fr) 1.2fr auto",
						gap: 10,
						alignItems: "end",
					}}
				>
					<CropField label={t("cropDialog.fieldX")} value={cropXPct} onChange={applyCropX} />
					<CropField label={t("cropDialog.fieldY")} value={cropYPct} onChange={applyCropY} />
					<CropField label={t("cropDialog.fieldW")} value={cropWPct} onChange={applyCropW} />
					<CropField label={t("cropDialog.fieldH")} value={cropHPct} onChange={applyCropH} />
					<div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 110 }}>
						<label
							style={{
								font: "600 10px/1 var(--font-mono)",
								letterSpacing: "0.04em",
								textTransform: "uppercase",
								color: "var(--muted)",
							}}
						>
							{ts("crop.ratio")}
						</label>
						<select
							value={cropRatio}
							onChange={(e) => handleCropRatioChange(e.target.value)}
							style={{
								width: "100%",
								padding: "8px 10px",
								font: "500 13px/1 var(--font-body)",
								color: "var(--fg-2)",
								background: "var(--surface)",
								border: "1px solid var(--border)",
								borderRadius: 6,
								outline: "none",
							}}
						>
							{CROP_RATIOS.map((r) => (
								<option key={r.value} value={r.value}>
									{r.value === "free" ? ts("crop.free") : r.label}
								</option>
							))}
						</select>
					</div>
					<span
						style={{
							font: "500 11px/1 var(--font-mono)",
							color: "var(--muted)",
							alignSelf: "center",
							whiteSpace: "nowrap",
						}}
					>
						{cropWPct}% × {cropHPct}%
					</span>
				</div>
			</div>

			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					paddingTop: 10,
					marginTop: 10,
					flexShrink: 0,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={handleReset}
					disabled={!hasChanges}
				>
					{t("editClipDialog.reset")}
				</button>
				<div style={{ display: "flex", gap: 8 }}>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={onClose}
					>
						{tc("actions.cancel")}
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={handleApply}
						disabled={!hasChanges}
					>
						<Pencil size={14} />
						{t("editClipDialog.apply")}
					</button>
				</div>
			</div>
		</ModalShell>
	);
}

function RangeStat({ label, value }: { label: string; value: string }) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
			<strong style={{ font: "600 15px/1.2 var(--font-mono)", color: "var(--fg)" }}>{value}</strong>
			<small style={{ font: "500 10px/1.4 var(--font-body)", color: "var(--muted)" }}>
				{label}
			</small>
		</div>
	);
}

export type UnsavedChoice = "save" | "discard" | "cancel";

interface UnsavedChangesModalProps extends BaseModalProps {
	action: "close" | "new" | "open" | "record";
	busy?: boolean;
	onChoose: (choice: UnsavedChoice) => void;
}

export function UnsavedChangesModal({
	open,
	onClose,
	action,
	busy,
	onChoose,
}: UnsavedChangesModalProps) {
	const td = useScopedT("dialogs");
	const tc = useScopedT("common");
	const titleKeys: Record<UnsavedChangesModalProps["action"], string> = {
		close: "modal.closeTitle",
		new: "modal.newTitle",
		open: "modal.openTitle",
		record: "modal.recordTitle",
	};
	const copy = {
		title: td(titleKeys[action]),
		body: action === "close" ? td("modal.closeBody") : td("modal.sharedBody"),
	};
	return (
		<ModalShell open={open} onClose={onClose} title={copy.title} subtitle={copy.body}>
			<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
				<span
					style={{
						display: "grid",
						placeItems: "center",
						width: 32,
						height: 32,
						borderRadius: 8,
						background: "var(--warn-soft)",
						color: "var(--warn)",
					}}
				>
					<AlertTriangle size={16} />
				</span>
				<div
					style={{
						font: "500 12px var(--font-body)",
						color: "var(--fg-2)",
					}}
				>
					{td("modal.notSavedYet")}
				</div>
			</div>
			<div
				style={{
					display: "flex",
					justifyContent: "flex-end",
					gap: 8,
					paddingTop: 12,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={() => onChoose("cancel")}
					disabled={busy}
				>
					{tc("actions.cancel")}
				</button>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={() => onChoose("discard")}
					disabled={busy}
				>
					{td("modal.discard")}
				</button>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnPrimary}`}
					onClick={() => onChoose("save")}
					disabled={busy}
				>
					{busy ? td("modal.saving") : td("modal.saveAndContinue")}
				</button>
			</div>
		</ModalShell>
	);
}

export interface InsertSourceModalProps extends BaseModalProps {
	assetLabel: string;
	canAddBefore: boolean;
	canAddAfter: boolean;
	canSplit: boolean;
	onAddBefore: () => void;
	onAddAfter: () => void;
	onSplit: () => void;
}

export function InsertSourceModal({
	open,
	onClose,
	assetLabel,
	canAddBefore,
	canAddAfter,
	canSplit,
	onAddBefore,
	onAddAfter,
	onSplit,
}: InsertSourceModalProps) {
	const t = useScopedT("editor");
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t("insertSourceDialog.title")}
			subtitle={t("insertSourceDialog.subtitle", { assetLabel })}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				<button
					type="button"
					disabled={!canAddBefore}
					onClick={onAddBefore}
					style={{
						padding: "12px 16px",
						border: "1px solid var(--border)",
						borderRadius: 10,
						background: "var(--surface)",
						color: "var(--fg-2)",
						font: "500 13px/1.2 var(--font-body)",
						cursor: canAddBefore ? "pointer" : "not-allowed",
						textAlign: "left",
						opacity: canAddBefore ? 1 : 0.5,
					}}
				>
					<strong>{t("insertSourceDialog.addBefore")}</strong>
					<div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
						{t("insertSourceDialog.addBeforeDesc")}
					</div>
				</button>
				<button
					type="button"
					disabled={!canAddAfter}
					onClick={onAddAfter}
					style={{
						padding: "12px 16px",
						border: "1px solid var(--border)",
						borderRadius: 10,
						background: "var(--surface)",
						color: "var(--fg-2)",
						font: "500 13px/1.2 var(--font-body)",
						cursor: canAddAfter ? "pointer" : "not-allowed",
						textAlign: "left",
						opacity: canAddAfter ? 1 : 0.5,
					}}
				>
					<strong>{t("insertSourceDialog.addAfter")}</strong>
					<div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
						{t("insertSourceDialog.addAfterDesc")}
					</div>
				</button>
				<button
					type="button"
					disabled={!canSplit}
					onClick={onSplit}
					style={{
						padding: "12px 16px",
						border: "1px solid var(--border)",
						borderRadius: 10,
						background: "var(--surface)",
						color: "var(--fg-2)",
						font: "500 13px/1.2 var(--font-body)",
						cursor: canSplit ? "pointer" : "not-allowed",
						textAlign: "left",
						opacity: canSplit ? 1 : 0.5,
					}}
				>
					<strong>{t("insertSourceDialog.split")}</strong>
					<div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
						{t("insertSourceDialog.splitDesc")}
					</div>
				</button>
			</div>
		</ModalShell>
	);
}

export interface SourceTranscriptModalProps extends BaseModalProps {
	assetLabel: string;
	assetPath: string;
	tcFormatted: string;
	transcript: AxcutTranscript | null;
	isTranscribing: boolean;
	isFailed: boolean;
	onRegenerate: (language: TranscriptLanguage) => void;
}

export function SourceTranscriptModal({
	open,
	onClose,
	assetLabel,
	assetPath,
	tcFormatted,
	transcript,
	isTranscribing,
	isFailed,
	onRegenerate,
}: SourceTranscriptModalProps) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [playTime, setPlayTime] = useState(0);
	const [duration, setDuration] = useState<number | null>(null);
	const [regenLang, setRegenLang] = useState<TranscriptLanguage>(
		(transcript?.language as TranscriptLanguage) ?? "auto",
	);

	// ponytail: sync the language picker to whatever the stored transcript was
	// generated with. Avoids surprising the user with a different selection on
	// every open after a regenerate.
	useEffect(() => {
		if (open) setRegenLang((transcript?.language as TranscriptLanguage) ?? "auto");
	}, [open, transcript?.language]);

	useEffect(() => {
		if (!open) {
			setIsPlaying(false);
			setPlayTime(0);
			setDuration(null);
			const v = videoRef.current;
			if (v) {
				v.pause();
				v.currentTime = 0;
			}
		}
	}, [open]);

	const detectedLanguage =
		transcript?.language && transcript.language !== "auto" ? transcript.language : null;

	const statusLabel = isTranscribing
		? t("mediaStage.generating")
		: isFailed
			? t("mediaStage.generationFailed")
			: transcript
				? t("mediaStage.generated")
				: t("mediaStage.notGeneratedYet");

	const transcriptBody = transcript
		? toAxcutTranscriptDsl(transcript, assetLabel || undefined, duration ?? undefined)
		: null;

	const playLabel = isPlaying ? tc("playback.pause") : tc("playback.play");

	const togglePlay = () => {
		const v = videoRef.current;
		if (!v) return;
		if (v.paused) {
			void v.play();
		} else {
			v.pause();
		}
	};

	const restart = () => {
		const v = videoRef.current;
		if (!v) return;
		v.currentTime = 0;
		setPlayTime(0);
	};

	const requestFullscreen = () => {
		const v = videoRef.current;
		if (!v) return;
		void v.requestFullscreen?.();
	};

	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t("mediaStage.sourceTranscript")}
			subtitle={assetLabel}
			wide
		>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "minmax(220px, 320px) 1fr",
					gap: 14,
				}}
			>
				<div
					style={{
						position: "relative",
						aspectRatio: "16 / 9",
						borderRadius: "var(--r-md)",
						overflow: "hidden",
						background: "linear-gradient(135deg, #16171d, #16171d)",
						border: "1px solid var(--border)",
					}}
				>
					{assetPath ? (
						<video
							ref={videoRef}
							src={toFileUrl(assetPath)}
							style={{
								width: "100%",
								height: "100%",
								objectFit: "contain",
								background: "#16171d",
							}}
							preload="metadata"
							onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
							onTimeUpdate={(e) => setPlayTime(e.currentTarget.currentTime)}
							onPlay={() => setIsPlaying(true)}
							onPause={() => setIsPlaying(false)}
							onEnded={() => setIsPlaying(false)}
						/>
					) : (
						<div
							style={{
								width: "100%",
								height: "100%",
								display: "grid",
								placeItems: "center",
								color: "var(--muted)",
								font: "500 12px var(--font-body)",
							}}
						>
							{t("mediaStage.noPreviewAvailable")}
						</div>
					)}
					<div
						style={{
							position: "absolute",
							left: 0,
							right: 0,
							bottom: 0,
							display: "flex",
							alignItems: "center",
							gap: 8,
							padding: "8px 10px",
							background: "linear-gradient(180deg, transparent, rgba(22,23,29,.55))",
							color: "#fff",
						}}
					>
						<button
							type="button"
							aria-label={playLabel}
							title={playLabel}
							onClick={togglePlay}
							style={{
								background: "transparent",
								border: 0,
								color: "inherit",
								cursor: "pointer",
								padding: 2,
								borderRadius: 4,
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
							}}
						>
							{isPlaying ? (
								<span style={{ display: "inline-flex", gap: 2 }}>
									<span
										style={{
											width: 4,
											height: 12,
											background: "currentColor",
											borderRadius: 1,
										}}
									/>
									<span
										style={{
											width: 4,
											height: 12,
											background: "currentColor",
											borderRadius: 1,
										}}
									/>
								</span>
							) : (
								<Triangle size={12} fill="currentColor" style={{ transform: "rotate(0deg)" }} />
							)}
						</button>
						<button
							type="button"
							aria-label={t("mediaStage.restart")}
							title={t("mediaStage.restart")}
							onClick={restart}
							style={{
								background: "transparent",
								border: 0,
								color: "inherit",
								cursor: "pointer",
								padding: 2,
								borderRadius: 4,
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
							}}
						>
							<RotateCcw size={13} />
						</button>
						<button
							type="button"
							aria-label={tc("playback.fullscreen")}
							title={tc("playback.fullscreen")}
							onClick={requestFullscreen}
							style={{
								background: "transparent",
								border: 0,
								color: "inherit",
								cursor: "pointer",
								padding: 2,
								borderRadius: 4,
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
							}}
						>
							<Maximize2 size={13} />
						</button>
						<span
							style={{
								marginLeft: "auto",
								font: "500 12px/1 var(--font-mono)",
								display: "inline-flex",
								alignItems: "baseline",
								gap: 4,
							}}
						>
							<strong>{formatTc(playTime)}</strong>
							<i style={{ fontStyle: "normal", opacity: 0.55, margin: "0 2px" }}>/</i>
							<span style={{ opacity: 0.8 }}>{duration ? formatTc(duration) : tcFormatted}</span>
						</span>
						{isTranscribing ? (
							<span
								style={{
									width: 8,
									height: 8,
									borderRadius: "50%",
									background: "var(--accent)",
									boxShadow: "0 0 0 3px var(--accent-soft)",
									marginLeft: 6,
								}}
								aria-label={t("mediaStage.transcribing")}
							/>
						) : (
							<span
								style={{
									width: 8,
									height: 8,
									borderRadius: "50%",
									background: isFailed ? "var(--danger)" : "var(--danger)",
									boxShadow: isFailed
										? "0 0 0 3px var(--danger-soft)"
										: "0 0 0 3px rgba(239, 68, 68, 0.2)",
									marginLeft: 6,
								}}
								aria-hidden
							/>
						)}
					</div>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
					<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
						<span
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 6,
								padding: "6px 12px",
								borderRadius: 999,
								background: isFailed ? "var(--danger-soft)" : "var(--success-soft)",
								color: isFailed ? "var(--danger)" : "var(--success)",
								font: "500 12px var(--font-body)",
								border: `1px solid color-mix(in srgb, ${isFailed ? "var(--danger)" : "var(--success)"} 22%, transparent)`,
							}}
						>
							{isTranscribing ? (
								<Loader2 size={11} className="animate-spin" />
							) : (
								<span
									style={{
										width: 7,
										height: 7,
										borderRadius: "50%",
										background: isFailed ? "var(--danger)" : "var(--success)",
									}}
								/>
							)}
							{statusLabel}
						</span>
						{detectedLanguage ? (
							<span
								style={{
									display: "inline-flex",
									alignItems: "center",
									padding: "6px 12px",
									borderRadius: 999,
									background: "var(--success-soft)",
									color: "var(--success)",
									font: "500 12px var(--font-body)",
									border: "1px solid color-mix(in srgb, var(--success) 22%, transparent)",
								}}
							>
								{t("mediaStage.detectedLanguage", { language: detectedLanguage })}
							</span>
						) : null}
					</div>
					<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
						<label
							style={{
								font: "500 12px/1 var(--font-body)",
								color: "var(--muted)",
							}}
						>
							{t("mediaStage.regenerateAs")}
						</label>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr auto",
								gap: 8,
								alignItems: "center",
							}}
						>
							<select
								aria-label={t("mediaStage.regenerateAs")}
								value={regenLang}
								disabled={isTranscribing}
								onChange={(e) => setRegenLang(e.target.value as TranscriptLanguage)}
								style={{
									width: "100%",
									padding: "10px 12px",
									borderRadius: "var(--r-md)",
									border: "1px solid var(--border)",
									background: "var(--surface)",
									color: "var(--fg)",
									font: "500 13px var(--font-body)",
								}}
							>
								{REGEN_LANGUAGES.map((code) => (
									<option key={code} value={code}>
										{code === "auto" ? t("mediaStage.auto") : LANGUAGE_LABELS[code]}
									</option>
								))}
							</select>
							<button
								type="button"
								title={t("mediaStage.regenerate")}
								aria-label={t("mediaStage.regenerate")}
								disabled={isTranscribing}
								onClick={() => onRegenerate(regenLang)}
								style={{
									width: 38,
									height: 38,
									borderRadius: "var(--r-md)",
									border: "1px solid var(--border)",
									background: "var(--surface)",
									color: "var(--fg)",
									cursor: isTranscribing ? "not-allowed" : "pointer",
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									opacity: isTranscribing ? 0.6 : 1,
								}}
							>
								{isTranscribing ? (
									<Loader2 size={15} className="animate-spin" />
								) : (
									<RefreshCw size={15} />
								)}
							</button>
						</div>
					</div>
				</div>
			</div>
			{transcriptBody ? (
				<pre
					style={{
						margin: 0,
						padding: "14px 16px",
						borderRadius: "var(--r-md)",
						border: "1px solid var(--border)",
						background: "var(--surface-warm)",
						font: "400 12px/1.55 var(--font-mono)",
						color: "var(--fg)",
						whiteSpace: "pre",
						overflow: "auto",
						maxHeight: "38vh",
					}}
				>
					{transcriptBody}
				</pre>
			) : (
				<div
					style={{
						padding: 32,
						textAlign: "center",
						color: "var(--muted)",
						font: "500 13px var(--font-body)",
						border: "1px dashed var(--border)",
						borderRadius: "var(--r-md)",
					}}
				>
					{isFailed
						? t("mediaStage.generationFailedHint")
						: isTranscribing
							? t("mediaStage.transcribingEllipsis")
							: t("mediaStage.notGeneratedHint")}
				</div>
			)}
		</ModalShell>
	);
}

interface CaptionsModalProps extends BaseModalProps {
	minWords: number;
	maxWords: number;
	onMinWords: (n: number) => void;
	onMaxWords: (n: number) => void;
	onGenerate: () => void;
}

export function AutoCaptionsModal({
	open,
	onClose,
	minWords,
	maxWords,
	onMinWords,
	onMaxWords,
	onGenerate,
}: CaptionsModalProps) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t("autoCaptions.dialogTitle")}
			subtitle={t("autoCaptions.dialogDescription")}
		>
			<div style={{ display: "flex", gap: 12 }}>
				<div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
					<label
						style={{
							font: "500 11px/1 var(--font-body)",
							textTransform: "uppercase",
							letterSpacing: "0.06em",
							color: "var(--muted)",
						}}
					>
						{t("autoCaptions.minWords")}
					</label>
					<select
						value={minWords}
						onChange={(e) => onMinWords(Number(e.target.value))}
						style={{
							padding: "8px 10px",
							border: "1px solid var(--border)",
							borderRadius: "6px",
							background: "var(--surface)",
							color: "var(--fg-2)",
							font: "500 13px var(--font-body)",
						}}
					>
						{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
							<option key={n} value={n}>
								{t("autoCaptions.wordsCount", { count: n })}
							</option>
						))}
					</select>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
					<label
						style={{
							font: "500 11px/1 var(--font-body)",
							textTransform: "uppercase",
							letterSpacing: "0.06em",
							color: "var(--muted)",
						}}
					>
						{t("autoCaptions.maxWords")}
					</label>
					<select
						value={maxWords}
						onChange={(e) => onMaxWords(Number(e.target.value))}
						style={{
							padding: "8px 10px",
							border: "1px solid var(--border)",
							borderRadius: "6px",
							background: "var(--surface)",
							color: "var(--fg-2)",
							font: "500 13px var(--font-body)",
						}}
					>
						{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
							<option key={n} value={n} disabled={n < minWords}>
								{t("autoCaptions.wordsCount", { count: n })}
							</option>
						))}
					</select>
				</div>
			</div>
			<div
				style={{
					display: "flex",
					justifyContent: "flex-end",
					gap: 8,
					paddingTop: 12,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<button type="button" className={`${styles.btn} ${styles.btnSecondary}`} onClick={onClose}>
					{tc("actions.cancel")}
				</button>
				<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onGenerate}>
					{t("autoCaptions.generate")}
				</button>
			</div>
		</ModalShell>
	);
}

export interface ChatHistoryModalProps extends BaseModalProps {
	sessions: Array<{ id: string; title: string; messageCount: number; createdAt: string }>;
	activeSessionId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
}

export function ChatHistoryModal({
	open,
	onClose,
	sessions,
	activeSessionId,
	onSelect,
	onNew: _onNew,
}: ChatHistoryModalProps) {
	void _onNew;
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t("chat.historyDialog.title")}
			subtitle={t("chat.historyDialog.subtitle")}
		>
			{sessions.length === 0 ? (
				<div
					style={{
						padding: 16,
						textAlign: "center",
						color: "var(--muted)",
						font: "500 13px var(--font-body)",
					}}
				>
					{t("chat.historyDialog.empty")}
				</div>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
					{sessions.map((s) => {
						const isActive = s.id === activeSessionId;
						return (
							<button
								type="button"
								key={s.id}
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									padding: "10px 12px",
									border: `1px solid ${isActive ? "var(--accent)" : "var(--border-soft)"}`,
									borderRadius: 8,
									background: isActive ? "var(--accent-wash)" : "var(--surface)",
									color: "var(--fg-2)",
									cursor: "pointer",
									font: "500 13px var(--font-body)",
									textAlign: "left",
									width: "100%",
								}}
								onClick={() => {
									onSelect(s.id);
									onClose();
								}}
							>
								<span style={{ fontWeight: isActive ? 600 : 500 }}>{s.title}</span>
								<span style={{ font: "500 11px/1 var(--font-mono)", color: "var(--muted)" }}>
									{t("chat.historyDialog.msgsCount", {
										count: s.messageCount,
										date: new Date(s.createdAt).toLocaleDateString(),
									})}
								</span>
							</button>
						);
					})}
				</div>
			)}
			<div
				style={{
					display: "flex",
					justifyContent: "flex-end",
					gap: 8,
					paddingTop: 12,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<button type="button" className={`${styles.btn} ${styles.btnSecondary}`} onClick={onClose}>
					{tc("actions.close")}
				</button>
			</div>
		</ModalShell>
	);
}
