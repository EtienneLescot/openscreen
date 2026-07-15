import {
	Captions as CaptionsIcon,
	ChevronRight,
	FileText,
	Image as ImageIcon,
	Layout as LayoutIcon,
	Maximize2,
	MousePointer2,
	Pencil,
	Scissors,
	SlidersHorizontal,
	Trash2,
	X,
	ZoomIn,
} from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { coalescedTrimGroups } from "@/lib/ai-edition/timeline/trim-mapping";
import { formatSeconds } from "@/lib/ai-edition/timeline/virtual-preview";
import {
	BackgroundPane,
	CursorPane,
	LayoutPane,
	TranscriptPane,
	VideoEffectsPane,
} from "../RightPanes";
import styles from "./EditorShellV4.module.css";

type TimelineApi = ReturnType<typeof useTimeline>;

export type Facet = "background" | "effects" | "layout" | "cursor" | "captions" | "transcript";

const FACETS: Array<{ id: Facet; labelKey: string; icon: typeof ImageIcon }> = [
	{ id: "background", labelKey: "background.title", icon: ImageIcon },
	{ id: "effects", labelKey: "effects.title", icon: SlidersHorizontal },
	{ id: "layout", labelKey: "layout.title", icon: LayoutIcon },
	{ id: "cursor", labelKey: "cursor.title", icon: MousePointer2 },
	{ id: "captions", labelKey: "facets.captions", icon: CaptionsIcon },
	{ id: "transcript", labelKey: "facets.transcript", icon: FileText },
];

type TranscriptProps = ComponentProps<typeof TranscriptPane>;

interface FloatingInspectorProps {
	facet: Facet;
	open: boolean;
	onFacetChange: (facet: Facet) => void;
	onToggleOpen: () => void;
	/** Clips on the timeline, for the "Edit clip" picker — crop + trim now live
	 * per-clip (see clipSchema.cropRegion) instead of behind a document-wide
	 * facet, so this button opens EditClipModal directly instead of routing
	 * through a facet body. */
	clips: AxcutClip[];
	onEditClip: (clip: AxcutClip) => void;
	onCaptions: () => void;
	transcriptProps: TranscriptProps;
	/** Drives the selected-element settings pane (zoom/speed/annotation/trim) —
	 * takes over the inspector, forcing it open, whenever a timeline region is
	 * selected. Clicking elsewhere on the timeline clears the selection
	 * (see V4Timeline's empty-area click handler) which closes this pane. */
	tl: TimelineApi;
}

export function FloatingInspector({
	facet,
	open,
	onFacetChange,
	onToggleOpen,
	clips,
	onEditClip,
	onCaptions,
	transcriptProps,
	tl,
}: FloatingInspectorProps) {
	const ts = useScopedT("settings");
	const te = useScopedT("editor");
	const [clipPickerOpen, setClipPickerOpen] = useState(false);
	const selection = tl.selection;
	const effectiveOpen = open || selection !== null;
	return (
		<div className={styles.inspectorWrap}>
			{effectiveOpen ? (
				<div className={styles.inspector}>
					{selection ? (
						<SelectionPane tl={tl} onClose={() => tl.clearSelection()} />
					) : (
						<FacetBody
							facet={facet}
							onCaptions={onCaptions}
							onCollapse={onToggleOpen}
							transcriptProps={transcriptProps}
						/>
					)}
				</div>
			) : null}
			<div className={styles.facetRail}>
				{FACETS.map(({ id, labelKey, icon: Icon }) => (
					<button
						key={id}
						type="button"
						title={ts(labelKey)}
						aria-label={ts(labelKey)}
						aria-pressed={!selection && open && facet === id}
						onClick={() => {
							// Switching facets while an element is selected should show
							// the facet, not leave the selection pane on top of it.
							if (selection) tl.clearSelection();
							if (facet === id && open) {
								onToggleOpen();
							} else {
								onFacetChange(id);
							}
						}}
					>
						<Icon size={17} />
					</button>
				))}
				<div style={{ position: "relative" }}>
					<button
						type="button"
						title={te("editClipDialog.title")}
						aria-label={te("editClipDialog.title")}
						aria-haspopup={clips.length > 1 ? "menu" : undefined}
						aria-expanded={clips.length > 1 ? clipPickerOpen : undefined}
						onClick={() => {
							if (selection) tl.clearSelection();
							if (clips.length === 0) return;
							if (clips.length === 1) {
								onEditClip(clips[0]);
								return;
							}
							setClipPickerOpen((v) => !v);
						}}
					>
						<Pencil size={17} />
					</button>
					{clipPickerOpen && clips.length > 1 ? (
						<div
							role="menu"
							aria-label={te("editClipDialog.pickClipTitle")}
							style={{
								position: "absolute",
								top: 0,
								right: "calc(100% + 8px)",
								minWidth: 200,
								maxHeight: 320,
								overflowY: "auto",
								background: "var(--surface-1)",
								border: "1px solid var(--border)",
								borderRadius: 12,
								boxShadow: "var(--elev-pop)",
								backdropFilter: "blur(18px)",
								padding: 6,
								zIndex: 30,
							}}
						>
							<p
								style={{
									margin: "4px 8px 6px",
									fontSize: 11,
									fontWeight: 600,
									textTransform: "uppercase",
									letterSpacing: "0.04em",
									color: "var(--muted)",
								}}
							>
								{te("editClipDialog.pickClipTitle")}
							</p>
							{clips.map((clip, index) => (
								<button
									key={clip.id}
									type="button"
									role="menuitem"
									onClick={() => {
										setClipPickerOpen(false);
										onEditClip(clip);
									}}
									style={{
										display: "flex",
										flexDirection: "column",
										alignItems: "flex-start",
										width: "100%",
										padding: "7px 8px",
										border: "none",
										borderRadius: 8,
										background: "transparent",
										color: "var(--fg)",
										cursor: "pointer",
										textAlign: "left",
									}}
								>
									<span style={{ font: "600 12.5px var(--font-display)" }}>
										{te("editClipDialog.clipLabel", { index: index + 1 })}
									</span>
									<span style={{ font: "500 11px var(--font-mono)", color: "var(--muted)" }}>
										{formatSeconds(clip.timelineStartSec)}–{formatSeconds(clip.timelineEndSec)}
									</span>
								</button>
							))}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

function paneHeader(icon: React.ReactNode, title: string, onClose: () => void, closeLabel: string) {
	return (
		<header
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "14px 16px 12px",
				borderBottom: "1px solid var(--border-soft)",
			}}
		>
			<span style={{ display: "grid", placeItems: "center", color: "var(--muted)" }}>{icon}</span>
			<h2
				style={{
					margin: 0,
					flex: 1,
					fontSize: 14,
					fontWeight: 600,
					color: "var(--fg-emphasis)",
					letterSpacing: "-0.01em",
				}}
			>
				{title}
			</h2>
			<button
				type="button"
				title={closeLabel}
				aria-label={closeLabel}
				onClick={onClose}
				style={{
					width: 26,
					height: 26,
					display: "grid",
					placeItems: "center",
					borderRadius: 8,
					color: "var(--muted)",
					background: "transparent",
					border: 0,
					cursor: "pointer",
				}}
			>
				<X size={15} />
			</button>
		</header>
	);
}

function paneRow(label: string, control: React.ReactNode) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 10,
			}}
		>
			<span style={{ fontSize: 12.5, color: "var(--fg-2)", fontWeight: 500 }}>{label}</span>
			{control}
		</div>
	);
}

const ZOOM_DEPTHS = [1, 2, 3, 4, 5, 6] as const;
const SPEED_VALUES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function SelectionPane({ tl, onClose }: { tl: TimelineApi; onClose: () => void }) {
	const ts = useScopedT("settings");
	const tt = useScopedT("timeline");
	const tc = useScopedT("common");
	const te = useScopedT("editor");
	const selection = tl.selection;
	if (!selection) return null;

	const deleteAndClose = () => {
		void tl.removeRegion(selection.kind, selection.id);
		onClose();
	};

	const bodyStyle: React.CSSProperties = {
		padding: "16px",
		display: "flex",
		flexDirection: "column",
		gap: 16,
	};
	const deleteBtnStyle: React.CSSProperties = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 7,
		padding: "9px 14px",
		borderRadius: 10,
		border: "1px solid var(--danger)",
		background: "var(--danger-soft)",
		color: "var(--danger)",
		font: "600 13px var(--font-display)",
		cursor: "pointer",
	};

	if (selection.kind === "zoom") {
		const region = tl.zoomRegions.find((z) => z.id === selection.id);
		if (!region) return null;
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(<ZoomIn size={15} />, tt("labels.zoom"), onClose, tc("actions.close"))}
				<div style={bodyStyle}>
					{paneRow(
						ts("zoom.level"),
						<select
							value={region.depth}
							onChange={(e) =>
								void tl.updateZoomDepth(region.id, Number(e.target.value) as 1 | 2 | 3 | 4 | 5 | 6)
							}
							style={selectStyle}
						>
							{ZOOM_DEPTHS.map((d) => (
								<option key={d} value={d}>
									{(d / 2 + 0.5).toFixed(1)}×
								</option>
							))}
						</select>,
					)}
					<button
						type="button"
						onClick={() => {
							tl.updateZoomFocusLive(region.id, { cx: 0.5, cy: 0.5 });
							void tl.commitZoomFocus();
						}}
						style={secondaryBtnStyle}
					>
						{te("inspector.resetFocusPoint")}
					</button>
					<button type="button" onClick={deleteAndClose} style={deleteBtnStyle}>
						<Trash2 size={14} />
						{ts("zoom.deleteZoom")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "speed") {
		const region = tl.speedRegions.find((s) => s.id === selection.id);
		if (!region) return null;
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(<ZoomIn size={15} />, tt("labels.speed"), onClose, tc("actions.close"))}
				<div style={bodyStyle}>
					{paneRow(
						ts("speed.playbackSpeed"),
						<select
							value={region.speed}
							onChange={(e) => void tl.updateSpeedValue(region.id, Number(e.target.value))}
							style={selectStyle}
						>
							{SPEED_VALUES.map((s) => (
								<option key={s} value={s}>
									{s}×
								</option>
							))}
						</select>,
					)}
					<button type="button" onClick={deleteAndClose} style={deleteBtnStyle}>
						<Trash2 size={14} />
						{ts("speed.deleteRegion")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "annotation") {
		const region = tl.annotationRegions.find((a) => a.id === selection.id);
		if (!region) return null;
		const colors = ["#ffffff", "#0f172a", "#10b981", "#f59e0b", "#f43f5e", "#6366f1"];
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(
					<FileText size={15} />,
					tt("labels.annotationItem"),
					onClose,
					tc("actions.close"),
				)}
				<div style={bodyStyle}>
					<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
						<span style={{ fontSize: 12.5, color: "var(--fg-2)", fontWeight: 500 }}>
							{ts("annotation.textContent")}
						</span>
						<textarea
							value={region.content ?? ""}
							onChange={(e) => tl.updateAnnotationLive(region.id, { content: e.target.value })}
							onBlur={() => void tl.commitAnnotationChange()}
							rows={2}
							style={{
								resize: "vertical",
								padding: "8px 10px",
								borderRadius: 9,
								border: "1px solid var(--border)",
								background: "var(--surface)",
								color: "var(--fg)",
								font: "500 13px var(--font-display)",
							}}
						/>
					</div>
					{paneRow(
						ts("annotation.color"),
						<div style={{ display: "flex", gap: 6 }}>
							{colors.map((c) => (
								<button
									key={c}
									type="button"
									title={c}
									aria-label={te("inspector.setColor", { color: c })}
									aria-pressed={region.style?.color === c}
									onClick={() => {
										tl.updateAnnotationLive(region.id, {
											style: { ...region.style, color: c },
										});
										void tl.commitAnnotationChange();
									}}
									style={{
										width: 22,
										height: 22,
										borderRadius: "50%",
										background: c,
										border:
											region.style?.color === c
												? "2px solid var(--accent)"
												: "1px solid var(--border-hi)",
										cursor: "pointer",
									}}
								/>
							))}
						</div>,
					)}
					<button type="button" onClick={deleteAndClose} style={deleteBtnStyle}>
						<Trash2 size={14} />
						{ts("annotation.deleteAnnotation")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "cameraFullscreen") {
		const region = tl.cameraFullscreenRegions.find((c) => c.id === selection.id);
		if (!region) return null;
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(<Maximize2 size={15} />, "Full Camera", onClose, tc("actions.close"))}
				<div style={bodyStyle}>
					<p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--muted)" }}>
						While this region plays, the webcam grows to (almost) fill the frame and eases back at
						the end. Drag the region's edges on the timeline to change when it starts and how long
						it lasts.
					</p>
					<button type="button" onClick={deleteAndClose} style={deleteBtnStyle}>
						<Trash2 size={14} />
						Delete region
					</button>
				</div>
			</div>
		);
	}

	// trim — a trim ventilated across a clip boundary is 2+ DSL rows that render
	// as one coalesced pill (see V4Timeline's trimPills); the inspector must
	// resolve the clicked id back to its whole group so the shown duration and
	// the delete button act on all of it, not just the one row that was clicked.
	const trimGroup = coalescedTrimGroups(tl.trimRanges, tl.clips).find((g) =>
		g.ids.includes(selection.id),
	);
	if (!trimGroup) return null;
	const durationSec = Math.max(0, trimGroup.end - trimGroup.start);
	const deleteTrimGroup = () => {
		void tl.removeRegions(trimGroup.ids.map((id) => ({ kind: "trim" as const, id })));
		onClose();
	};
	return (
		<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
			{paneHeader(<Scissors size={15} />, tt("labels.trim"), onClose, tc("actions.close"))}
			<div style={bodyStyle}>
				<p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--muted)" }}>
					{te("inspector.trimHiddenDuration", { duration: durationSec.toFixed(1) })}
				</p>
				<button type="button" onClick={deleteTrimGroup} style={deleteBtnStyle}>
					<Trash2 size={14} />
					{te("inspector.restoreDeleteTrim")}
				</button>
			</div>
		</div>
	);
}

const selectStyle: React.CSSProperties = {
	height: 32,
	padding: "0 8px",
	borderRadius: 8,
	border: "1px solid var(--border)",
	background: "var(--surface)",
	color: "var(--fg)",
	font: "500 12.5px var(--font-display)",
};

const secondaryBtnStyle: React.CSSProperties = {
	padding: "9px 14px",
	borderRadius: 10,
	border: "1px solid var(--border-hi)",
	background: "var(--surface-2)",
	color: "var(--fg-2)",
	font: "600 13px var(--font-display)",
	cursor: "pointer",
};

function FacetBody({
	facet,
	onCaptions,
	onCollapse,
	transcriptProps,
}: {
	facet: Facet;
	onCaptions: () => void;
	onCollapse: () => void;
	transcriptProps: TranscriptProps;
}) {
	const te = useScopedT("editor");
	const ts = useScopedT("settings");
	// A small collapse affordance floated over the reused pane header.
	const collapse = (
		<button
			type="button"
			title={te("inspector.collapseInspector")}
			aria-label={te("inspector.collapseInspector")}
			onClick={onCollapse}
			style={{
				position: "absolute",
				top: 12,
				right: 12,
				width: 26,
				height: 26,
				display: "grid",
				placeItems: "center",
				borderRadius: 8,
				color: "var(--muted)",
				background: "var(--surface-1)",
				border: 0,
				cursor: "pointer",
				zIndex: 5,
			}}
		>
			<ChevronRight size={15} />
		</button>
	);

	if (facet === "background") return wrap(collapse, <BackgroundPane />);
	if (facet === "effects") return wrap(collapse, <VideoEffectsPane />);
	if (facet === "layout") return wrap(collapse, <LayoutPane />);
	if (facet === "cursor") return wrap(collapse, <CursorPane />);
	if (facet === "transcript") return wrap(collapse, <TranscriptPane {...transcriptProps} />);
	return wrap(
		collapse,
		<SimpleFacet
			title={ts("facets.captions")}
			description={te("inspector.captionsDescription")}
			actionLabel={te("inspector.generateCaptions")}
			onAction={onCaptions}
		/>,
	);
}

function wrap(collapse: React.ReactNode, body: React.ReactNode) {
	return (
		<div style={{ position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
			{collapse}
			{body}
		</div>
	);
}

function SimpleFacet({
	title,
	description,
	actionLabel,
	onAction,
	emptyLabel,
}: {
	title: string;
	description: string;
	actionLabel?: string;
	onAction?: () => void;
	emptyLabel?: string;
}) {
	return (
		<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
			<header
				style={{
					display: "flex",
					alignItems: "center",
					padding: "14px 16px 12px",
					borderBottom: "1px solid var(--border-soft)",
				}}
			>
				<h2
					style={{
						margin: 0,
						fontSize: 14,
						fontWeight: 600,
						color: "var(--fg-emphasis)",
						letterSpacing: "-0.01em",
					}}
				>
					{title}
				</h2>
			</header>
			<div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 14 }}>
				<p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--muted)" }}>
					{description}
				</p>
				{emptyLabel ? (
					<div
						style={{
							padding: "20px 16px",
							border: "1px dashed var(--border-hi)",
							borderRadius: 12,
							textAlign: "center",
							color: "var(--muted)",
							fontSize: 12,
						}}
					>
						{emptyLabel}
					</div>
				) : null}
				{actionLabel && onAction ? (
					<button
						type="button"
						onClick={onAction}
						style={{
							padding: "10px 14px",
							borderRadius: 10,
							border: "1px solid var(--accent)",
							background: "var(--accent)",
							color: "#fff",
							font: "600 13px var(--font-display)",
							cursor: "pointer",
						}}
					>
						{actionLabel}
					</button>
				) : null}
			</div>
		</div>
	);
}
