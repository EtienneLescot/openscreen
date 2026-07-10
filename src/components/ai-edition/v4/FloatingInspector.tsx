import {
	Captions as CaptionsIcon,
	ChevronRight,
	Crop as CropIcon,
	FileText,
	Image as ImageIcon,
	Layout as LayoutIcon,
	MousePointer2,
	Scissors,
	SlidersHorizontal,
	Trash2,
	X,
	ZoomIn,
} from "lucide-react";
import type { ComponentProps } from "react";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { coalescedTrimGroups } from "@/lib/ai-edition/timeline/trim-mapping";
import {
	BackgroundPane,
	CursorPane,
	LayoutPane,
	TranscriptPane,
	VideoEffectsPane,
} from "../RightPanes";
import styles from "./EditorShellV4.module.css";

type TimelineApi = ReturnType<typeof useTimeline>;

export type Facet =
	| "background"
	| "effects"
	| "layout"
	| "cursor"
	| "captions"
	| "transcript"
	| "crop";

const FACETS: Array<{ id: Facet; label: string; icon: typeof ImageIcon }> = [
	{ id: "background", label: "Background", icon: ImageIcon },
	{ id: "effects", label: "Effects", icon: SlidersHorizontal },
	{ id: "layout", label: "Layout", icon: LayoutIcon },
	{ id: "cursor", label: "Cursor", icon: MousePointer2 },
	{ id: "captions", label: "Captions", icon: CaptionsIcon },
	{ id: "transcript", label: "Transcript", icon: FileText },
	{ id: "crop", label: "Crop", icon: CropIcon },
];

type TranscriptProps = ComponentProps<typeof TranscriptPane>;

interface FloatingInspectorProps {
	facet: Facet;
	open: boolean;
	onFacetChange: (facet: Facet) => void;
	onToggleOpen: () => void;
	onCrop: () => void;
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
	onCrop,
	onCaptions,
	transcriptProps,
	tl,
}: FloatingInspectorProps) {
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
							onCrop={onCrop}
							onCaptions={onCaptions}
							onCollapse={onToggleOpen}
							transcriptProps={transcriptProps}
						/>
					)}
				</div>
			) : null}
			<div className={styles.facetRail}>
				{FACETS.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						title={label}
						aria-label={label}
						aria-pressed={!selection && open && facet === id}
						onClick={() => {
							// Switching facets while an element is selected should show
							// the facet, not leave the selection pane on top of it.
							if (selection) tl.clearSelection();
							// Crop has no useful "settings" pane of its own — jump straight
							// to the crop modal instead of routing through FacetBody's
							// now-removed intermediate "Open crop…" pane.
							if (id === "crop") {
								onCrop();
								return;
							}
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
			</div>
		</div>
	);
}

function paneHeader(icon: React.ReactNode, title: string, onClose: () => void) {
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
				title="Close"
				aria-label="Close"
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
				{paneHeader(<ZoomIn size={15} />, "Zoom", onClose)}
				<div style={bodyStyle}>
					{paneRow(
						"Zoom level",
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
						Reset focus point
					</button>
					<button type="button" onClick={deleteAndClose} style={deleteBtnStyle}>
						<Trash2 size={14} />
						Delete zoom
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
				{paneHeader(<ZoomIn size={15} />, "Speed", onClose)}
				<div style={bodyStyle}>
					{paneRow(
						"Playback speed",
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
						Delete speed region
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
				{paneHeader(<FileText size={15} />, "Annotation", onClose)}
				<div style={bodyStyle}>
					<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
						<span style={{ fontSize: 12.5, color: "var(--fg-2)", fontWeight: 500 }}>Text</span>
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
						"Color",
						<div style={{ display: "flex", gap: 6 }}>
							{colors.map((c) => (
								<button
									key={c}
									type="button"
									title={c}
									aria-label={`Set color ${c}`}
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
						Delete annotation
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
			{paneHeader(<Scissors size={15} />, "Trim", onClose)}
			<div style={bodyStyle}>
				<p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--muted)" }}>
					{durationSec.toFixed(1)}s of source media hidden from the edited timeline.
				</p>
				<button type="button" onClick={deleteTrimGroup} style={deleteBtnStyle}>
					<Trash2 size={14} />
					Restore (delete trim)
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
	onCrop,
	onCaptions,
	onCollapse,
	transcriptProps,
}: {
	facet: Facet;
	onCrop: () => void;
	onCaptions: () => void;
	onCollapse: () => void;
	transcriptProps: TranscriptProps;
}) {
	// A small collapse affordance floated over the reused pane header.
	const collapse = (
		<button
			type="button"
			title="Collapse inspector"
			aria-label="Collapse inspector"
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
	if (facet === "captions")
		return wrap(
			collapse,
			<SimpleFacet
				title="Captions"
				description="Generate word-timed captions from the transcript and drop them onto the timeline."
				actionLabel="Generate captions"
				onAction={onCaptions}
			/>,
		);
	// crop: the rail button bypasses FacetBody and opens CropModal directly
	// (see the facet rail's onClick above) — this is a defensive fallback for
	// the unlikely case `facet` state is ever "crop" without going through
	// the rail.
	return wrap(
		collapse,
		<SimpleFacet
			title="Crop"
			description="Reframe the recording — pick an aspect ratio and zoom into the region you want to keep."
			actionLabel="Open crop…"
			onAction={onCrop}
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
