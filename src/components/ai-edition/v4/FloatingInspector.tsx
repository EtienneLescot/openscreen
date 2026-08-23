import {
	AudioLines,
	Captions as CaptionsIcon,
	ChevronRight,
	FileText,
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
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { parseCustomPlaybackSpeedInput } from "@/components/video-editor/customPlaybackSpeed";
import {
	MAX_PLAYBACK_SPEED,
	SPEED_OPTIONS,
	ZOOM_DEPTH_SCALES,
} from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import {
	hasTextBackground,
	setTextBackgroundColor,
	textBackgroundColor,
	toggleTextBackground,
} from "@/lib/ai-edition/annotations/background";
import {
	type AnnotationTextAnimation,
	TEXT_ANIMATION_VALUES,
} from "@/lib/ai-edition/annotations/textAnimation";
import type { AxcutAnnotationRegion, AxcutClip } from "@/lib/ai-edition/schema";
import { rafCoalesce } from "@/lib/ai-edition/store/rafCoalesce";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import { coalescedTrimGroups } from "@/lib/ai-edition/timeline/trim-mapping";
import { CaptionsPane } from "../CaptionsPane";
import { ColorField } from "../ColorField";
import {
	AudioPane,
	CursorPane,
	LayoutPane,
	SliderCell,
	Toggle,
	TranscriptPane,
	VideoEffectsPane,
} from "../RightPanes";
import styles from "./EditorShellV4.module.css";

type TimelineApi = ReturnType<typeof useTimeline>;

export type Facet = "effects" | "layout" | "audio" | "cursor" | "captions" | "transcript";

const FACETS: Array<{ id: Facet; labelKey: string; icon: typeof SlidersHorizontal }> = [
	// Background is a SECTION of this facet now, not a facet of its own — see
	// VideoEffectsPane for why the split had nowhere to sit.
	{ id: "effects", labelKey: "effects.title", icon: SlidersHorizontal },
	{ id: "layout", labelKey: "layout.title", icon: LayoutIcon },
	{ id: "audio", labelKey: "audio.title", icon: AudioLines },
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
	transcriptProps,
	tl,
}: FloatingInspectorProps) {
	const ts = useScopedT("settings");
	const te = useScopedT("editor");
	const [clipPickerOpen, setClipPickerOpen] = useState(false);
	const clipPickerRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!clipPickerOpen) return;
		const onDocMouseDown = (e: MouseEvent) => {
			if (clipPickerRef.current && !clipPickerRef.current.contains(e.target as Node)) {
				setClipPickerOpen(false);
			}
		};
		document.addEventListener("mousedown", onDocMouseDown);
		return () => document.removeEventListener("mousedown", onDocMouseDown);
	}, [clipPickerOpen]);
	const selection = tl.selection;
	const effectiveOpen = open || selection !== null;
	return (
		<div className={styles.inspectorWrap}>
			{effectiveOpen ? (
				<div className={styles.inspector}>
					{selection ? (
						<SelectionPane tl={tl} onClose={() => tl.clearSelection()} />
					) : (
						<FacetBody facet={facet} onCollapse={onToggleOpen} transcriptProps={transcriptProps} />
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
				<div ref={clipPickerRef} style={{ position: "relative" }}>
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
				// Le corps défile sous l'en-tête : sans ça, l'en-tête se comprime avec lui.
				flexShrink: 0,
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

type AnnotationKind = AxcutAnnotationRegion["type"];
type ArrowDirectionKind = NonNullable<AxcutAnnotationRegion["figureData"]>["arrowDirection"];

/** Les huit directions de `ArrowSvgs.tsx`, dans l'ordre où elles y sont définies. */
const ARROW_DIRECTIONS: ArrowDirectionKind[] = [
	"up",
	"down",
	"left",
	"right",
	"up-right",
	"up-left",
	"down-right",
	"down-left",
];

/** Défauts du schéma, pour compléter un `blurData` absent sans écraser ce qui existe. */
const BLUR_DEFAULTS = {
	type: "mosaic",
	shape: "rectangle",
	color: "white",
	intensity: 12,
	blockSize: 12,
} as const;

/**
 * Patch à appliquer quand l'utilisateur change le type d'une annotation.
 *
 * `content` est un slot UNIQUE partagé par le texte et l'image : la zone de saisie y écrit, et le
 * rendu d'image y lit une data URL. Changer de type sans déplacer la valeur déversait donc le
 * base64 de l'image, souvent plusieurs mégaoctets, dans le champ texte. Chaque contenu est rangé
 * dans son slot typé (`textContent` / `imageContent`) en sortant et restauré en entrant, si bien
 * qu'un aller-retour entre deux types ne perd rien.
 */
function convertAnnotationKind(
	region: AxcutAnnotationRegion,
	next: AnnotationKind,
): Partial<AxcutAnnotationRegion> {
	if (region.type === next) return {};
	const parked: Partial<AxcutAnnotationRegion> =
		region.type === "text"
			? { textContent: region.content ?? "" }
			: region.type === "image"
				? { imageContent: region.content ?? "" }
				: {};
	// Flèche et flou n'ont pas de contenu : on vide `content` plutôt que d'y laisser traîner le
	// texte ou le base64 du type précédent.
	const restored =
		next === "text"
			? (region.textContent ?? "")
			: next === "image"
				? (region.imageContent ?? "")
				: "";
	return { ...parked, type: next, content: restored };
}

const ZOOM_DEPTHS = [1, 2, 3, 4, 5, 6] as const;
// The ladder the shared editor already ships (`SPEED_OPTIONS`), plus 1× so the select can
// express "back to normal". It stops at 5×; the free field in `SpeedControl` is what reaches
// `MAX_PLAYBACK_SPEED`.
const SPEED_PRESETS = [1, ...SPEED_OPTIONS.map((option) => option.speed)].sort((a, b) => a - b);

/**
 * Preset select + free numeric field, the speed UX this editor already had translations for
 * (`settings.speed.customPlaybackSpeed` / `maxSpeedError` / `previewFrameSteppingHint`, shipped
 * in all 13 locales) but no longer any control for: the V4 shell replaced the panel that hosted
 * it with a preset-only `<select>` capped at 3×, while the underlying capability goes to
 * `MAX_PLAYBACK_SPEED` (100×). Only the control was missing, so this rewires it rather than
 * adding anything new.
 */
export function SpeedControl({
	region,
	tl,
}: {
	region: { id: string; speed: number };
	tl: Pick<TimelineApi, "updateSpeedValue">;
}) {
	const ts = useScopedT("settings");
	// "" means the field is idle and the select is showing the truth. A non-empty draft is
	// uncommitted text; it's cleared on commit so the placeholder tracks the live speed again.
	const [draft, setDraft] = useState("");

	const commitDraft = () => {
		const result = parseCustomPlaybackSpeedInput(draft);
		if (result.status === "valid") {
			void tl.updateSpeedValue(region.id, result.speed);
		} else if (result.status === "too-fast") {
			toast.error(ts("speed.maxSpeedError", { max: MAX_PLAYBACK_SPEED }));
		}
		// Anything else (empty, unparseable, below the floor) just reverts to the live value
		// rather than guessing at an intent.
		setDraft("");
	};

	// A custom speed matches no preset, so surface it as its own option — otherwise the select
	// would fall back to rendering its first entry and misreport the region.
	const options = SPEED_PRESETS.includes(region.speed)
		? SPEED_PRESETS
		: [...SPEED_PRESETS, region.speed].sort((a, b) => a - b);

	return (
		<>
			{paneRow(
				ts("speed.playbackSpeed"),
				<select
					value={region.speed}
					onChange={(e) => void tl.updateSpeedValue(region.id, Number(e.target.value))}
					style={selectStyle}
				>
					{options.map((speed) => (
						<option key={speed} value={speed}>
							{speed}×
						</option>
					))}
				</select>,
			)}
			{paneRow(
				ts("speed.customPlaybackSpeed"),
				<input
					type="text"
					inputMode="decimal"
					placeholder={`${region.speed}×`}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commitDraft}
					// Enter blurs, and the blur handler commits — one path, so a keyboard commit
					// can't apply the same draft twice.
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
					}}
					style={{ ...selectStyle, width: 84, textAlign: "right" }}
				/>,
			)}
			{/* No hint past 16×. There is nothing for the user to do about it and nothing that
			    changes in what they get: the export renders the true speed either way. The note
			    that used to sit here described the legacy editor's frame-stepped, silent preview,
			    which is not this one. */}
		</>
	);
}

function SelectionPane({ tl, onClose }: { tl: TimelineApi; onClose: () => void }) {
	const ts = useScopedT("settings");
	const tt = useScopedT("timeline");
	const tc = useScopedT("common");
	const te = useScopedT("editor");
	// Read here rather than threading it through: the zoom pane is the only consumer, and the
	// toggle that writes it lives in the timeline toolbar, not on this component's path.
	const { settings } = useEditorSettings();
	const autoFocusAll = settings.autoFocusAll;
	// Mise à jour en direct regroupée à une par frame. `updateAnnotationLive` remplace le document
	// dans le store, donc chaque appel fait reconstruire et re-sérialiser toute la scène avant de
	// la pousser au natif : c'est le juste prix une fois par image, mais un `<input type="color">`
	// émet un événement par pixel de glissement et saturait le thread. La référence garde la
	// dernière fonction du store sans recréer le coalesceur, dont l'état en attente doit survivre
	// aux rendus.
	const liveUpdateRef = useRef(tl.updateAnnotationLive);
	liveUpdateRef.current = tl.updateAnnotationLive;
	const liveUpdate = useMemo(
		() =>
			rafCoalesce((id: string, patch: Partial<AxcutAnnotationRegion>) =>
				liveUpdateRef.current(id, patch),
			),
		[],
	);
	/** Fin de geste : on applique la dernière valeur en attente AVANT d'enregistrer, sinon la
	 *  frame en vol serait perdue et le disque garderait l'avant-dernière couleur. */
	const commitAnnotation = () => {
		liveUpdate.flush();
		void tl.commitAnnotationChange();
	};
	const selection = tl.selection;
	if (!selection) return null;

	const deleteAndClose = () => {
		void tl.removeRegion(selection.kind, selection.id);
		onClose();
	};

	// Le panneau découpe son contenu (coins arrondis + flou), donc un corps sans ascenseur perd
	// silencieusement ce qui dépasse — c'est ce qui arrivait au pane d'annotation, le plus haut de
	// tous, dès qu'on réduisait la fenêtre. L'en-tête reste fixe, le corps défile, comme les
	// panneaux de facette (cf. `.paneBody` de NewEditorShell).
	const bodyStyle: React.CSSProperties = {
		padding: "16px",
		display: "flex",
		flexDirection: "column",
		gap: 16,
		flex: "1 1 auto",
		minHeight: 0,
		overflowY: "auto",
		overflowX: "hidden",
		overscrollBehavior: "contain",
		scrollbarWidth: "thin",
		scrollbarColor: "var(--border) transparent",
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
									{/* La table, pas une formule : ce libellé annonçait « 2.0× » là où la pastille de la
									    timeline affiche « 1.80× » et où le rendu applique 1.8. */}
									{ZOOM_DEPTH_SCALES[d]}×
								</option>
							))}
						</select>,
					)}
					{paneRow(
						ts("zoom.threeD.title"),
						<select
							value={region.rotationPreset ?? "none"}
							onChange={(e) =>
								void tl.updateZoomRotation(
									region.id,
									// "none" is the absence of a preset, not a fourth preset — the schema field
									// is optional and `migrate.ts` drops it when falsy.
									e.target.value === "none"
										? undefined
										: (e.target.value as "iso" | "left" | "right"),
								)
							}
							style={selectStyle}
						>
							<option value="none">{ts("zoom.threeD.none")}</option>
							<option value="iso">{ts("zoom.threeD.preset.iso")}</option>
							<option value="left">{ts("zoom.threeD.preset.left")}</option>
							<option value="right">{ts("zoom.threeD.preset.right")}</option>
						</select>,
					)}
					{paneRow(
						ts("zoom.focusMode.title"),
						// While the global toggle is on it OVERRIDES every region, so the control shows
						// the effective mode ("auto") and goes read-only rather than lying about a
						// per-region value that currently has no effect. The region's own `focusMode` is
						// never written by the toggle — that is what makes each zoom snap back to its
						// previous value the moment the toggle goes off.
						<select
							value={autoFocusAll ? "auto" : (region.focusMode ?? "manual")}
							disabled={autoFocusAll}
							onChange={(e) =>
								void tl.updateZoomFocusMode(region.id, e.target.value as "manual" | "auto")
							}
							style={
								autoFocusAll ? { ...selectStyle, opacity: 0.5, cursor: "not-allowed" } : selectStyle
							}
						>
							<option value="manual">{ts("zoom.focusMode.manual")}</option>
							<option value="auto">{ts("zoom.focusMode.auto")}</option>
						</select>,
					)}
					{autoFocusAll || region.focusMode === "auto" ? (
						// Auto resamples the focus from cursor telemetry every frame, so there is no fixed
						// point to reset and no gimbal on the canvas (ZoomFocusOverlay bows out) — the
						// reset button would be a no-op. When the global toggle is what forced auto, say
						// so, and say where to turn it off.
						<p style={{ margin: 0, font: "400 11px/1.45 var(--font-sans)", color: "var(--fg-2)" }}>
							{ts(
								autoFocusAll ? "zoom.focusMode.lockedDisclaimer" : "zoom.focusMode.autoDescription",
							)}
						</p>
					) : (
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
					)}
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
					<SpeedControl region={region} tl={tl} />
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
		const hasBackground = hasTextBackground(region.style);
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(
					<FileText size={15} />,
					tt("labels.annotationItem"),
					onClose,
					tc("actions.close"),
				)}
				<div style={bodyStyle}>
					{/* Type switch. Only text annotations could ever be created, so image, arrow and
					    blur were unreachable even though the compositor renders all four and every
					    label here already shipped translated. Converting keeps the span and box, so
					    a mistake costs one more click rather than redrawing the region. */}
					{paneRow(
						ts("annotation.type"),
						<select
							value={region.type}
							onChange={(e) => {
								tl.updateAnnotationLive(
									region.id,
									convertAnnotationKind(region, e.target.value as AnnotationKind),
								);
								void tl.commitAnnotationChange();
							}}
							style={selectStyle}
						>
							<option value="text">{ts("annotation.typeText")}</option>
							<option value="image">{ts("annotation.typeImage")}</option>
							<option value="figure">{ts("annotation.typeArrow")}</option>
							<option value="blur">{ts("annotation.typeBlur")}</option>
						</select>,
					)}
					{region.type === "text" ? (
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							<span style={{ fontSize: 12.5, color: "var(--fg-2)", fontWeight: 500 }}>
								{ts("annotation.textContent")}
							</span>
							<textarea
								value={region.content ?? ""}
								placeholder={ts("annotation.textPlaceholder")}
								onChange={(e) => tl.updateAnnotationLive(region.id, { content: e.target.value })}
								onBlur={commitAnnotation}
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
					) : null}
					{region.type === "image" ? (
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							{/* Read as a data URL, which is what the renderer expects: `content` holds
							    "Separate storage for image data URL" (types.ts) and both the preview
							    overlay and the compositor read it from there. */}
							<label
								style={{ ...secondaryBtnStyle, textAlign: "center", cursor: "pointer" }}
								htmlFor={`ann-img-${region.id}`}
							>
								{ts("annotation.uploadImage")}
							</label>
							<input
								id={`ann-img-${region.id}`}
								type="file"
								accept="image/jpeg,image/png,image/gif,image/webp"
								style={{ display: "none" }}
								onChange={(e) => {
									const file = e.target.files?.[0];
									if (!file) return;
									if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
										toast.error(ts("annotation.imageFormatsOnly"));
										return;
									}
									const reader = new FileReader();
									reader.onload = () => {
										tl.updateAnnotationLive(region.id, { content: String(reader.result) });
										void tl.commitAnnotationChange();
										toast.success(ts("annotation.imageUploadSuccess"));
									};
									reader.readAsDataURL(file);
								}}
							/>
							<span style={{ font: "400 11px/1.4 var(--font-sans)", color: "var(--fg-2)" }}>
								{ts("annotation.supportedFormats")}
							</span>
						</div>
					) : null}
					{region.type === "figure" ? (
						<>
							{paneRow(
								ts("annotation.arrowDirection"),
								<select
									value={region.figureData?.arrowDirection ?? "right"}
									onChange={(e) => {
										tl.updateAnnotationLive(region.id, {
											figureData: {
												...(region.figureData ?? { color: "#34B27B", strokeWidth: 4 }),
												arrowDirection: e.target.value as ArrowDirectionKind,
											},
										});
										void tl.commitAnnotationChange();
									}}
									style={selectStyle}
								>
									{ARROW_DIRECTIONS.map((d) => (
										<option key={d} value={d}>
											{d}
										</option>
									))}
								</select>,
							)}
							{paneRow(
								ts("annotation.arrowColor"),
								<ColorField
									label={ts("annotation.arrowColor")}
									value={region.figureData?.color ?? "#34B27B"}
									onChange={(next) =>
										liveUpdate(region.id, {
											figureData: {
												...(region.figureData ?? { arrowDirection: "right", strokeWidth: 4 }),
												color: next,
											},
										})
									}
									onCommit={commitAnnotation}
								/>,
							)}
							<SliderCell
								label={ts("annotation.strokeWidth", {
									width: region.figureData?.strokeWidth ?? 4,
								})}
								value={region.figureData?.strokeWidth ?? 4}
								min={1}
								max={20}
								onChange={(next) =>
									tl.updateAnnotationLive(region.id, {
										figureData: {
											...(region.figureData ?? { arrowDirection: "right", color: "#34B27B" }),
											strokeWidth: next,
										},
									})
								}
								onCommit={() => void tl.commitAnnotationChange()}
								// Le libellé i18n interpole déjà « : 11px » ; sans ça on lisait « 11px11 ».
								showValue={false}
							/>
						</>
					) : null}
					{region.type === "blur" ? (
						<>
							{paneRow(
								ts("annotation.blurType"),
								<select
									value={region.blurData?.type ?? "mosaic"}
									onChange={(e) => {
										tl.updateAnnotationLive(region.id, {
											blurData: {
												...(region.blurData ?? BLUR_DEFAULTS),
												type: e.target.value as "blur" | "mosaic",
											},
										});
										void tl.commitAnnotationChange();
									}}
									style={selectStyle}
								>
									<option value="blur">{ts("annotation.blurTypeBlur")}</option>
									<option value="mosaic">{ts("annotation.blurTypeMosaic")}</option>
								</select>,
							)}
							{paneRow(
								ts("annotation.blurShape"),
								<select
									value={region.blurData?.shape ?? "rectangle"}
									onChange={(e) => {
										tl.updateAnnotationLive(region.id, {
											blurData: {
												...(region.blurData ?? BLUR_DEFAULTS),
												shape: e.target.value as "rectangle" | "oval" | "freehand",
											},
										});
										void tl.commitAnnotationChange();
									}}
									style={selectStyle}
								>
									<option value="rectangle">{ts("annotation.blurShapeRectangle")}</option>
									<option value="oval">{ts("annotation.blurShapeOval")}</option>
									{/* Le tracé libre n'est plus proposé à la création : sa saisie était cassée et
									    le rendu ne couvrait que la boîte englobante. Un outil de confidentialité
									    à moitié fiable vaut moins que pas d'outil, parce qu'on lui fait confiance.
									    L'option reste visible pour une annotation qui l'utilise déjà, avec la
									    phrase qui dit ce que le rendu en fait — plutôt que de la faire disparaître
									    d'un projet existant. */}
									{region.blurData?.shape === "freehand" ? (
										<option value="freehand">{ts("annotation.blurShapeFreehand")}</option>
									) : null}
								</select>,
							)}
							{region.blurData?.shape === "freehand" ? (
								// Say it rather than let the user discover it: the compositor masks the
								// bounding box for a freehand shape, deliberately over-covering instead
								// of leaving anything the user marked private visible in the export.
								<p
									style={{
										margin: 0,
										font: "400 11px/1.45 var(--font-sans)",
										color: "var(--fg-2)",
									}}
								>
									{te("inspector.freehandRendersAsBox")}
								</p>
							) : null}
						</>
					) : null}
					{region.type === "text"
						? paneRow(
								ts("annotation.size"),
								<input
									type="number"
									min={8}
									max={200}
									step={1}
									// Le nombre saisi vaut « pixels à 1080 » (cf. annotationScale.ts) : preview et
									// rendu le multiplient tous deux par la hauteur de leur boîte, donc ce champ
									// veut dire la même chose des deux côtés.
									value={region.style?.fontSize ?? 32}
									onChange={(e) =>
										tl.updateAnnotationLive(region.id, {
											style: { ...region.style, fontSize: Number(e.target.value) },
										})
									}
									onBlur={commitAnnotation}
									style={{ ...selectStyle, width: 84, textAlign: "right" }}
								/>,
							)
						: null}
					{region.type === "text"
						? paneRow(
								ts("annotation.background"),
								<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
									{/* La pastille montre la couleur mémorisée même fond éteint : c'est celle que
									    le rallumage rendra, et un noir affiché à la place mentirait. Choisir une
									    couleur allume le fond, sinon le sélecteur n'aurait aucun effet visible. */}
									<ColorField
										label={ts("annotation.background")}
										value={textBackgroundColor(region.style)}
										onChange={(next) =>
											liveUpdate(region.id, {
												style: setTextBackgroundColor(region.style, next),
											})
										}
										onCommit={commitAnnotation}
									/>
									{/* Une bascule plutôt qu'un bouton « effacer » : avoir un fond ou non est un
									    état, pas une action. La pilule des panneaux, pas une case système. */}
									<Toggle
										checked={hasBackground}
										onChange={(next) => {
											tl.updateAnnotationLive(region.id, {
												style: toggleTextBackground(region.style, next),
											});
											void tl.commitAnnotationChange();
										}}
									/>
								</div>,
							)
						: null}
					{region.type === "text"
						? paneRow(
								ts("textAnimation.title"),
								// Les sept animations existaient : nommées dans le schéma, traduites dans les
								// treize langues, transportées jusqu'au compositeur — et injouables, faute de
								// ce sélecteur.
								<select
									aria-label={ts("textAnimation.selectAnimation")}
									value={region.style?.textAnimation ?? "none"}
									onChange={(e) => {
										tl.updateAnnotationLive(region.id, {
											style: {
												...region.style,
												textAnimation: e.target.value as AnnotationTextAnimation,
											},
										});
										void tl.commitAnnotationChange();
									}}
									style={selectStyle}
								>
									{TEXT_ANIMATION_VALUES.map((value) => (
										<option key={value} value={value}>
											{ts(`textAnimation.${value === "slide-left" ? "slideLeft" : value}`)}
										</option>
									))}
								</select>,
							)
						: null}
					{region.type === "text"
						? paneRow(
								ts("annotation.color"),
								<ColorField
									label={ts("annotation.color")}
									value={region.style?.color ?? "#ffffff"}
									onChange={(next) =>
										liveUpdate(region.id, {
											style: { ...region.style, color: next },
										})
									}
									onCommit={commitAnnotation}
								/>,
							)
						: null}
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
				{paneHeader(
					<Maximize2 size={15} />,
					tt("labels.cameraFullscreen"),
					onClose,
					tc("actions.close"),
				)}
				<div style={bodyStyle}>
					<p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--muted)" }}>
						{te("inspector.cameraFullscreenDescription")}
					</p>
					<button type="button" onClick={deleteAndClose} style={deleteBtnStyle}>
						<Trash2 size={14} />
						{te("inspector.deleteRegion")}
					</button>
				</div>
			</div>
		);
	}

	// trim — a trim ventilated across a clip boundary is 2+ DSL rows that render
	// as one coalesced pill (see V4Timeline's trimPills), so the DURATION shown has to be
	// the group's, not the clicked row's. Deleting no longer needs the same expansion here:
	// `removeRegion` drops the whole pill for every kind (`dropTrimPillsByIds`), which is
	// what this pane used to have to arrange for itself.
	const trimGroup = coalescedTrimGroups(tl.trimRanges, tl.clips).find((g) =>
		g.ids.includes(selection.id),
	);
	if (!trimGroup) return null;
	const durationSec = Math.max(0, trimGroup.end - trimGroup.start);
	const deleteTrimGroup = () => {
		void tl.removeRegion("trim", selection.id);
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
	onCollapse,
	transcriptProps,
}: {
	facet: Facet;
	onCollapse: () => void;
	transcriptProps: TranscriptProps;
}) {
	const te = useScopedT("editor");
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

	if (facet === "effects") return wrap(collapse, <VideoEffectsPane />);
	if (facet === "layout") return wrap(collapse, <LayoutPane />);
	if (facet === "audio") return wrap(collapse, <AudioPane />);
	if (facet === "cursor") return wrap(collapse, <CursorPane />);
	if (facet === "transcript") return wrap(collapse, <TranscriptPane {...transcriptProps} />);
	return wrap(collapse, <CaptionsPane />);
}

function wrap(collapse: React.ReactNode, body: React.ReactNode) {
	return (
		<div style={{ position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
			{collapse}
			{body}
		</div>
	);
}
