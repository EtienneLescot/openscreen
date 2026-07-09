import {
	Captions as CaptionsIcon,
	ChevronRight,
	Crop as CropIcon,
	FileText,
	GitFork,
	Image as ImageIcon,
	Layout as LayoutIcon,
	MousePointer2,
	SlidersHorizontal,
} from "lucide-react";
import type { ComponentProps } from "react";
import {
	BackgroundPane,
	CursorPane,
	LayoutPane,
	TranscriptPane,
	VideoEffectsPane,
} from "../RightPanes";
import styles from "./EditorShellV4.module.css";

export type Facet =
	| "background"
	| "effects"
	| "layout"
	| "cursor"
	| "captions"
	| "chapters"
	| "transcript"
	| "crop";

const FACETS: Array<{ id: Facet; label: string; icon: typeof ImageIcon }> = [
	{ id: "background", label: "Background", icon: ImageIcon },
	{ id: "effects", label: "Effects", icon: SlidersHorizontal },
	{ id: "layout", label: "Layout", icon: LayoutIcon },
	{ id: "cursor", label: "Cursor", icon: MousePointer2 },
	{ id: "captions", label: "Captions", icon: CaptionsIcon },
	{ id: "chapters", label: "Chapters", icon: GitFork },
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
}

export function FloatingInspector({
	facet,
	open,
	onFacetChange,
	onToggleOpen,
	onCrop,
	onCaptions,
	transcriptProps,
}: FloatingInspectorProps) {
	const isTranscript = facet === "transcript";
	return (
		<div className={`${styles.inspectorWrap}${isTranscript ? ` ${styles.tall}` : ""}`}>
			{open ? (
				<div className={styles.inspector}>
					<FacetBody
						facet={facet}
						onCrop={onCrop}
						onCaptions={onCaptions}
						onCollapse={onToggleOpen}
						transcriptProps={transcriptProps}
					/>
				</div>
			) : null}
			<div className={styles.facetRail}>
				{FACETS.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						title={label}
						aria-label={label}
						aria-pressed={open && facet === id}
						onClick={() => {
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
	if (facet === "crop")
		return wrap(
			collapse,
			<SimpleFacet
				title="Crop"
				description="Reframe the recording — pick an aspect ratio and zoom into the region you want to keep."
				actionLabel="Open crop…"
				onAction={onCrop}
			/>,
		);
	// chapters
	return wrap(
		collapse,
		<SimpleFacet
			title="Chapters"
			description="Chapter markers help viewers jump around long recordings."
			emptyLabel="No chapters yet"
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
