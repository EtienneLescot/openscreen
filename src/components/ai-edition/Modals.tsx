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
import { toAxcutTranscriptDsl } from "@/lib/ai-edition/document/transcribe";
import type { AxcutClip, AxcutTranscript } from "@/lib/ai-edition/schema";
import { formatSeconds } from "@/lib/ai-edition/timeline/virtual-preview";
import styles from "./NewEditorShell.module.css";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";

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
						title="Close"
						aria-label="Close"
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
	const [query, setQuery] = useState("");
	const filtered = projects.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()));
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title="Open project"
			subtitle="Pick up an existing project or browse your files"
			wide
		>
			<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
				<FolderOpen size={14} style={{ color: "var(--muted)" }} />
				<input
					type="search"
					placeholder="Search projects…"
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
			<div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 12 }}>
				{filtered.length === 0 ? (
					<p style={{ color: "var(--muted)", fontSize: 12, padding: 16, textAlign: "center" }}>
						No projects match "{query}".
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
					to navigate ·{" "}
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
					to open
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
					Browse files…
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
	const [title, setTitle] = useState("Untitled project");
	const [template, setTemplate] = useState<Template>("blank");
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title="New project"
			subtitle="Choose a starting point and give it a name"
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
						Project name
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
						Starting point
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
							title="Blank project"
							desc="Empty timeline, ready to import"
							active={template === "blank"}
							onClick={() => setTemplate("blank")}
						/>
						<TemplateCell
							icon={<Crop size={18} />}
							title="Screen recording"
							desc="Start system capture"
							active={template === "screen-recording"}
							onClick={() => setTemplate("screen-recording")}
						/>
						<TemplateCell
							icon={<Plus size={18} />}
							title="Import media"
							desc="Video, audio, images from disk"
							active={template === "import"}
							onClick={() => setTemplate("import")}
						/>
						<TemplateCell
							icon={<Crop size={18} />}
							title="From template"
							desc="Predefined storyboard"
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
						Cancel
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={() => {
							onCreate(title.trim() || "Untitled project");
							onClose();
						}}
					>
						<Plus size={14} />
						Create project
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

interface CropModalProps extends BaseModalProps {
	initialRegion: CropRegion;
	onApply: (region: CropRegion) => void;
}

const CROP_RATIOS: Array<{ value: string; label: string; ratio: number | null }> = [
	{ value: "free", label: "Free", ratio: null },
	{ value: "16:9", label: "16:9", ratio: 16 / 9 },
	{ value: "9:16", label: "9:16", ratio: 9 / 16 },
	{ value: "1:1", label: "1:1", ratio: 1 },
	{ value: "4:3", label: "4:3", ratio: 4 / 3 },
	{ value: "3:4", label: "3:4", ratio: 3 / 4 },
	{ value: "21:9", label: "21:9", ratio: 21 / 9 },
];

function detectRatio(r: CropRegion): string {
	const candidates = CROP_RATIOS.filter((c) => c.ratio !== null);
	const ratio = r.width === 0 ? 0 : r.height / r.width;
	for (const c of candidates) {
		if (c.ratio === null) continue;
		if (Math.abs(ratio - c.ratio) < 0.01) return c.value;
	}
	return "free";
}

export function CropModal({ open, onClose, initialRegion, onApply }: CropModalProps) {
	const [xPct, setXPct] = useState(0);
	const [yPct, setYPct] = useState(0);
	const [wPct, setWPct] = useState(100);
	const [hPct, setHPct] = useState(100);
	const [ratio, setRatio] = useState("free");

	// ponytail: sync local form state to the document region every time the
	// modal opens. Doesn't run on every doc change — `open` is the trigger.
	useEffect(() => {
		if (!open) return;
		setXPct(Math.round(initialRegion.x * 100));
		setYPct(Math.round(initialRegion.y * 100));
		setWPct(Math.round(initialRegion.width * 100));
		setHPct(Math.round(initialRegion.height * 100));
		setRatio(detectRatio(initialRegion));
	}, [open, initialRegion]);

	const handleRatioChange = (next: string) => {
		setRatio(next);
		const candidate = CROP_RATIOS.find((c) => c.value === next);
		if (candidate?.ratio && wPct > 0) {
			const newH = Math.round(wPct * candidate.ratio);
			setHPct(Math.min(100, Math.max(1, newH)));
		}
	};

	const handleApply = () => {
		const next: CropRegion = {
			x: Math.max(0, Math.min(1, xPct / 100)),
			y: Math.max(0, Math.min(1, yPct / 100)),
			width: Math.max(0.01, Math.min(1, wPct / 100)),
			height: Math.max(0.01, Math.min(1, hPct / 100)),
		};
		onApply(next);
		onClose();
	};

	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title="Crop video"
			subtitle="Drag on each side to adjust the crop area"
		>
			<div
				style={{
					position: "relative",
					aspectRatio: "16 / 9",
					background: "linear-gradient(135deg, #16171d, #16171d)",
					borderRadius: "var(--r-md)",
					border: "1px solid var(--border)",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						position: "absolute",
						left: `${xPct}%`,
						top: `${yPct}%`,
						width: `${wPct}%`,
						height: `${hPct}%`,
						border: "1.5px solid var(--fg)",
						borderRadius: 4,
						boxShadow: "0 0 0 9999px var(--overlay-dark)",
						cursor: "move",
					}}
				/>
			</div>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(5, auto) 1fr auto",
					gap: 10,
					alignItems: "end",
				}}
			>
				<CropField label="X" value={xPct} onChange={setXPct} />
				<CropField label="Y" value={yPct} onChange={setYPct} />
				<CropField label="W" value={wPct} onChange={setWPct} />
				<CropField label="H" value={hPct} onChange={setHPct} />
				<div className={styles.field} style={{ minWidth: 96 }}>
					<label>Ratio</label>
					<select value={ratio} onChange={(e) => handleRatioChange(e.target.value)}>
						{CROP_RATIOS.map((r) => (
							<option key={r.value} value={r.value}>
								{r.label}
							</option>
						))}
					</select>
				</div>
				<span
					style={{
						font: "500 11px/1 var(--font-mono)",
						color: "var(--muted)",
						alignSelf: "center",
					}}
				>
					{wPct}% × {hPct}%
				</span>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnPrimary}`}
					style={{ height: 36, padding: "0 20px" }}
					onClick={handleApply}
				>
					Done
				</button>
			</div>
		</ModalShell>
	);
}

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
		<div className={styles.field}>
			<label>{label}</label>
			<input
				type="number"
				value={value}
				min={0}
				max={100}
				onChange={(e) => onChange(Number(e.target.value))}
			/>
		</div>
	);
}

export interface AssetMeta {
	label: string;
	durationSec?: number;
}

interface EditClipModalProps extends BaseModalProps {
	clip: AxcutClip | null;
	assetMeta: AssetMeta | null;
	videoSources: VideoSource[];
	onApply: (sourceStartSec: number, sourceEndSec: number) => void;
}

// Mirrors Axcut's ClipEditDialog: an embedded preview of just this clip plus
// a draggable dual-handle range over the asset's full source duration —
// replaces the old numeric-input-only form. Only the source range is
// editable here; the clip's timeline position is derived from resequencing
// (see useTimeline.updateClipSourceRange), same as every other clip op.
export function EditClipModal({
	open,
	onClose,
	clip,
	assetMeta,
	videoSources,
	onApply,
}: EditClipModalProps) {
	const trackRef = useRef<HTMLDivElement | null>(null);
	const [draftStart, setDraftStart] = useState(0);
	const [draftEnd, setDraftEnd] = useState(0);
	const [activeEdge, setActiveEdge] = useState<"start" | "end" | null>(null);

	// ponytail: sync local drag state to the clip every time the modal opens.
	// `open` is the trigger so external clip changes don't fight the user mid-edit.
	useEffect(() => {
		if (!open || !clip) return;
		setDraftStart(clip.sourceStartSec);
		setDraftEnd(clip.sourceEndSec ?? clip.sourceStartSec);
		setActiveEdge(null);
	}, [open, clip]);

	if (!clip) return null;

	const sourceDurationSec = Math.max(assetMeta?.durationSec ?? 0, clip.sourceEndSec ?? 0, 0.001);
	const durationSec = Math.max(0.001, draftEnd - draftStart);
	const hasChanges =
		Math.abs(draftStart - clip.sourceStartSec) > 0.001 ||
		Math.abs(draftEnd - (clip.sourceEndSec ?? 0)) > 0.001;
	const previewClip: AxcutClip = {
		...clip,
		id: `${clip.id}:edit-preview`,
		sourceStartSec: draftStart,
		sourceEndSec: draftEnd,
		timelineStartSec: 0,
		timelineEndSec: durationSec,
	};
	const clipSources = videoSources.filter((s) => s.id === clip.assetId);

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

	const handleReset = () => {
		setDraftStart(clip.sourceStartSec);
		setDraftEnd(clip.sourceEndSec ?? clip.sourceStartSec);
	};
	const handleApply = () => {
		onApply(draftStart, draftEnd);
		onClose();
	};

	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title="Edit clip"
			subtitle={assetMeta?.label ?? undefined}
			wide
		>
			<div
				style={{
					height: 220,
					marginBottom: 16,
					borderRadius: "var(--r-md)",
					overflow: "hidden",
					background: "var(--surface-2)",
				}}
			>
				<VirtualPreview videoSources={clipSources} clips={[previewClip]} />
			</div>

			<div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
				<RangeStat label="Start" value={formatSeconds(draftStart)} />
				<RangeStat label="End" value={formatSeconds(draftEnd)} />
				<RangeStat label="Duration" value={formatSeconds(durationSec)} />
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
						aria-label="Adjust clip start"
						title="Adjust clip start"
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
						aria-label="Adjust clip end"
						title="Adjust clip end"
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

			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					paddingTop: 16,
					marginTop: 16,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={handleReset}
					disabled={!hasChanges}
				>
					Reset
				</button>
				<div style={{ display: "flex", gap: 8 }}>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={handleApply}
						disabled={!hasChanges}
					>
						<Pencil size={14} />
						Apply
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

const ACTION_COPY: Record<UnsavedChangesModalProps["action"], { title: string; body: string }> = {
	close: {
		title: "Save changes before closing?",
		body: "Your project has unsaved changes. Save them now, discard them, or stay in the editor.",
	},
	new: {
		title: "Save changes before creating a new project?",
		body: "The current project has unsaved changes. Save them first, discard them, or cancel.",
	},
	open: {
		title: "Save changes before opening another project?",
		body: "The current project has unsaved changes. Save them first, discard them, or cancel.",
	},
	record: {
		title: "Save changes before starting a new recording?",
		body: "The current project has unsaved changes. Save them first, discard them, or cancel.",
	},
};

export function UnsavedChangesModal({
	open,
	onClose,
	action,
	busy,
	onChoose,
}: UnsavedChangesModalProps) {
	const copy = ACTION_COPY[action];
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
					The current project has not been saved to disk yet.
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
					Cancel
				</button>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={() => onChoose("discard")}
					disabled={busy}
				>
					Discard
				</button>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnPrimary}`}
					onClick={() => onChoose("save")}
					disabled={busy}
				>
					{busy ? "Saving…" : "Save & continue"}
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
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title="Insert source"
			subtitle={`Where to place "${assetLabel}" on the timeline?`}
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
					<strong>Add before</strong>
					<div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
						Insert the whole source before the target clip.
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
					<strong>Add after</strong>
					<div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
						Insert the whole source after the target clip.
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
					<strong>Split here and insert</strong>
					<div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
						Split the target clip at the drop point and insert the source in between.
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
		? "Generating"
		: isFailed
			? "Generation failed"
			: transcript
				? "Generated"
				: "Not generated yet";

	const transcriptBody = transcript
		? toAxcutTranscriptDsl(transcript, assetLabel || undefined, duration ?? undefined)
		: null;

	const playLabel = isPlaying ? "Pause" : "Play";

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
		<ModalShell open={open} onClose={onClose} title="Source Transcript" subtitle={assetLabel} wide>
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
							No preview available
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
							aria-label="Restart"
							title="Restart"
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
							aria-label="Fullscreen"
							title="Fullscreen"
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
								aria-label="Transcribing"
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
								Detected language: {detectedLanguage}
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
							Regenerate as
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
								aria-label="Regenerate as"
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
										{LANGUAGE_LABELS[code]}
									</option>
								))}
							</select>
							<button
								type="button"
								title="Regenerate"
								aria-label="Regenerate"
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
						? "Generation failed — pick a language and regenerate."
						: isTranscribing
							? "Transcribing…"
							: "Not generated yet — pick a language and click regenerate."}
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
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title="Auto captions"
			subtitle="Choose roughly how many words each caption shows at once. Timing is spread across the words in that phrase."
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
						Min words per caption
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
								{n} word{n === 1 ? "" : "s"}
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
						Max words per caption
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
								{n} word{n === 1 ? "" : "s"}
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
					Cancel
				</button>
				<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onGenerate}>
					Generate
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
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title="Conversation history"
			subtitle="Switch or create sessions"
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
					No conversations yet.
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
									{s.messageCount} msgs · {new Date(s.createdAt).toLocaleDateString()}
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
					Close
				</button>
			</div>
		</ModalShell>
	);
}
