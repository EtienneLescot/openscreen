import {
	ChevronDown,
	FileText,
	MessageSquare,
	Scissors,
	Timer,
	WandSparkles,
	ZoomIn,
} from "lucide-react";
import { useState } from "react";
import type { AnnotationRegion } from "@/components/video-editor/types";
import type { AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { ASPECT_RATIOS, type AspectRatio } from "@/utils/aspectRatioUtils";
import styles from "./NewEditorShell.module.css";
import { TimelinePane } from "./TimelinePane";

type RegionKind = "zoom" | "skip" | "annotation" | "speed";

interface RegionHandle {
	kind: RegionKind;
	id: string;
}

interface BottombarProps {
	clips: AxcutClip[];
	currentTimeSec: number;
	sourceDurationSec: number;
	onPreviewSource: (sec: number) => void;
	onReplaceTimeline: (
		intervals: Array<{ startSec: number; endSec: number }>,
		reason: string,
	) => void;
	// Region operations (from useTimeline)
	zoomRegions: AxcutDocument["zoomRanges"];
	skipRanges: AxcutDocument["timeline"]["skipRanges"];
	annotationRegions: AnnotationRegion[];
	speedRegions: Array<{ id: string; startMs: number; endMs: number; speed: number }>;
	selection: RegionHandle | null;
	hasDoc: boolean;
	onAddZoom: () => void;
	onAddSkip: () => void;
	onAddAnnotation: () => void;
	onAddSpeed: () => void;
	onSelectRegion: (kind: RegionKind, id: string) => void;
	onRemoveRegion: (kind: RegionKind, id: string) => void;
	onCaptions: () => void;
}

const RATIO_LABELS: Record<AspectRatio, string> = {
	"16:9": "16:9",
	"9:16": "9:16",
	"1:1": "1:1",
	"4:3": "4:3",
	"4:5": "4:5",
	"16:10": "16:10",
	"10:16": "10:16",
	native: "Original",
};

function formatMs(ms: number): string {
	const sec = ms / 1000;
	const m = Math.floor(sec / 60);
	const s = (sec % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

export function Bottombar({
	clips,
	currentTimeSec,
	sourceDurationSec,
	onPreviewSource,
	onReplaceTimeline,
	zoomRegions,
	annotationRegions,
	speedRegions,
	selection,
	hasDoc,
	onAddZoom,
	onAddSkip,
	onAddAnnotation,
	onAddSpeed,
	onSelectRegion,
	onRemoveRegion,
	onCaptions,
}: BottombarProps) {
	const { settings, set } = useEditorSettings();
	const [ratioOpen, setRatioOpen] = useState(false);
	return (
		<footer className={styles.bottombar} aria-label="Timeline and properties">
			<section
				style={{ minWidth: 0, display: "grid", gridTemplateRows: "auto 1fr auto", minHeight: 0 }}
			>
				<header className={styles.timelineHead}>
					<div className={styles.viewTools} role="toolbar" aria-label="View tools">
						<VtBtn label="Add zoom" title="Add zoom (Z)" onClick={onAddZoom} disabled={!hasDoc}>
							<ZoomIn size={17} />
						</VtBtn>
						<VtBtn
							label="Auto focus"
							title="Auto focus on for all zoom"
							on={settings.autoFocusAll}
							onClick={() => {
								void set({ autoFocusAll: !settings.autoFocusAll });
							}}
						>
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.75"
								strokeLinecap="round"
								strokeLinejoin="round"
								width={17}
								height={17}
							>
								<path d="M4 8V4h4" />
								<path d="M16 4h4v4" />
								<path d="M4 16v4h4" />
								<path d="M16 20h4v-4" />
								<path d="M6 12c1.5-2.2 3.6-3.4 6-3.4s4.5 1.2 6 3.4c-1.5 2.2-3.6 3.4-6 3.4S7.5 14.2 6 12z" />
								<circle cx="12" cy="12" r="1.6" />
							</svg>
						</VtBtn>
						<VtBtn label="Trim" title="Press T to add trim" onClick={onAddSkip} disabled={!hasDoc}>
							<Scissors size={17} />
						</VtBtn>
						<VtBtn
							label="Annotation"
							title="Press A to add annotation"
							onClick={onAddAnnotation}
							disabled={!hasDoc}
						>
							<MessageSquare size={17} />
						</VtBtn>
						<VtBtn
							label="Speed"
							title="Press S to add speed"
							onClick={onAddSpeed}
							disabled={!hasDoc}
						>
							<Timer size={17} />
						</VtBtn>
						<VtBtn label="Captions" title="Auto captions" onClick={onCaptions} disabled={!hasDoc}>
							<FileText size={17} />
						</VtBtn>
						<VtBtn label="Magic" title="Auto zoom suggestions" disabled>
							<WandSparkles size={17} />
						</VtBtn>
						<div style={{ position: "relative" }}>
							<button
								type="button"
								className={styles.ratio}
								onClick={() => setRatioOpen((v) => !v)}
								aria-haspopup="menu"
								aria-expanded={ratioOpen}
							>
								<span>{RATIO_LABELS[settings.aspectRatio]}</span>
								<ChevronDown size={10} className="caret" />
							</button>
							{ratioOpen ? (
								<div
									role="menu"
									style={{
										position: "absolute",
										top: "calc(100% + 4px)",
										left: 0,
										minWidth: 120,
										background: "var(--surface)",
										border: "1px solid var(--border)",
										borderRadius: "var(--r-md)",
										boxShadow: "var(--elev-pop)",
										padding: 4,
										zIndex: 60,
									}}
								>
									{ASPECT_RATIOS.map((r) => (
										<button
											type="button"
											key={r}
											role="menuitem"
											style={menuItemStyle(r === settings.aspectRatio)}
											disabled={!hasDoc}
											onClick={() => {
												void set({ aspectRatio: r });
												setRatioOpen(false);
											}}
										>
											{RATIO_LABELS[r]}
										</button>
									))}
								</div>
							) : null}
						</div>
					</div>
					<div className={styles.hintRow}>
						<span className={styles.hint}>
							<span className={styles.kbd}>Scroll</span>
							<span>Pan</span>
						</span>
						<span className={styles.hint}>
							<span className={styles.kbd}>Ctrl</span>
							<span className={styles.kbd}>+ Scroll</span>
							<span>Zoom</span>
						</span>
					</div>
				</header>
				<div className={styles.timelineBody}>
					{/* Region lane rows */}
					<div
						style={{
							padding: "4px var(--sp-4) 0",
							display: "flex",
							flexDirection: "column",
							gap: 4,
							flexShrink: 0,
						}}
					>
						{zoomRegions.length > 0 ? (
							<LaneRow
								label="Zoom"
								kind="zoom"
								items={zoomRegions.map((z) => ({
									id: z.id,
									startMs: z.startMs,
									endMs: z.endMs,
									label: `${getZoomLabel(z)}`,
								}))}
								selection={selection}
								onSelect={onSelectRegion}
								onRemove={onRemoveRegion}
							/>
						) : null}
						{annotationRegions.length > 0 ? (
							<LaneRow
								label="Annotations"
								kind="annotation"
								items={annotationRegions.map((a) => ({
									id: a.id,
									startMs: a.startMs,
									endMs: a.endMs,
									label: a.content?.slice(0, 30) || "Annotation",
								}))}
								selection={selection}
								onSelect={onSelectRegion}
								onRemove={onRemoveRegion}
							/>
						) : null}
						{speedRegions.length > 0 ? (
							<LaneRow
								label="Speed"
								kind="speed"
								items={speedRegions.map((s) => ({
									id: s.id,
									startMs: s.startMs,
									endMs: s.endMs,
									label: `${s.speed}×`,
								}))}
								selection={selection}
								onSelect={onSelectRegion}
								onRemove={onRemoveRegion}
							/>
						) : null}
					</div>
					<div className="timelinePaneWrap" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
						<TimelinePane
							clips={clips}
							currentTimeSec={currentTimeSec}
							sourceDurationSec={sourceDurationSec}
							onPreviewSource={onPreviewSource}
							onReplaceTimeline={onReplaceTimeline}
						/>
					</div>
				</div>
				<div className={styles.zoombar} role="group" aria-label="Zoom range">
					<div className={styles.zoomTrack}>
						<div className={styles.zoomFill} aria-hidden />
					</div>
				</div>
			</section>
		</footer>
	);
}

function VtBtn({
	label,
	title,
	onClick,
	on,
	disabled,
	children,
}: {
	label: string;
	title: string;
	onClick?: () => void;
	on?: boolean;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className={`${styles.vtBtn} ${on ? styles.isOn : ""}`}
			aria-label={label}
			aria-pressed={on}
			title={title}
			onClick={onClick}
			disabled={disabled}
		>
			{children}
		</button>
	);
}

function LaneRow({
	label,
	kind,
	items,
	selection,
	onSelect,
	onRemove,
}: {
	label: string;
	kind: RegionKind;
	items: Array<{ id: string; startMs: number; endMs: number; label: string }>;
	selection: RegionHandle | null;
	onSelect: (kind: RegionKind, id: string) => void;
	onRemove: (kind: RegionKind, id: string) => void;
}) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				height: 30,
			}}
		>
			<span
				style={{
					font: "600 10px/1 var(--font-mono)",
					color: "var(--meta)",
					letterSpacing: "0.04em",
					textTransform: "uppercase",
					minWidth: 48,
					flexShrink: 0,
				}}
			>
				{label}
			</span>
			{items.map((item) => {
				const isSel = selection?.kind === kind && selection?.id === item.id;
				return (
					<button
						type="button"
						key={item.id}
						onClick={() => onSelect(kind, item.id)}
						title={`${formatMs(item.startMs)}–${formatMs(item.endMs)}`}
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 6,
							padding: "3px 8px",
							borderRadius: "var(--r-md)",
							border: `1px solid ${isSel ? "var(--accent)" : "var(--border-soft)"}`,
							background: isSel ? "var(--accent-soft)" : "var(--surface-2)",
							color: isSel ? "var(--accent)" : "var(--fg-2)",
							font: "500 11px/1 var(--font-mono)",
							letterSpacing: "0.02em",
							cursor: "pointer",
							whiteSpace: "nowrap",
						}}
					>
						<span style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>
							{item.label}
						</span>
						<span style={{ color: "var(--meta)", fontSize: 10 }}>{formatMs(item.startMs)}</span>
						<button
							type="button"
							aria-label="Delete"
							title="Delete (Del)"
							onClick={(e) => {
								e.stopPropagation();
								onRemove(kind, item.id);
							}}
							style={{
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
								width: 16,
								height: 16,
								borderRadius: "var(--r-xs)",
								border: 0,
								background: "var(--danger-soft)",
								color: "var(--danger)",
								fontSize: 10,
								fontWeight: 600,
								cursor: "pointer",
								opacity: isSel ? 1 : 0,
							}}
						>
							×
						</button>
					</button>
				);
			})}
		</div>
	);
}

function getZoomLabel(z: { depth: number; customScale?: number }): string {
	if (z.customScale) return `${z.customScale.toFixed(1)}×`;
	const scales: Record<number, string> = {
		1: "1.25×",
		2: "1.5×",
		3: "1.8×",
		4: "2.2×",
		5: "3.5×",
		6: "5×",
	};
	return scales[z.depth] ?? "1.8×";
}

function menuItemStyle(active: boolean): React.CSSProperties {
	return {
		display: "block",
		width: "100%",
		textAlign: "left",
		padding: "6px 10px",
		border: 0,
		background: active ? "var(--accent-wash)" : "transparent",
		color: "var(--fg-2)",
		borderRadius: "var(--r-sm)",
		cursor: "pointer",
		font: "500 12px var(--font-body)",
	};
}
