import {
	ChevronDown,
	FileText,
	MessageSquare,
	Pencil,
	Scissors,
	Timer,
	WandSparkles,
	ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type { AnnotationRegion } from "@/components/video-editor/types";
import type { AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { suggestZoomRegions } from "@/lib/ai-edition/store/zoomSuggestions";
import { locateVirtualPosition } from "@/lib/ai-edition/timeline/virtual-preview";
import { ASPECT_RATIOS, type AspectRatio } from "@/utils/aspectRatioUtils";
import { EditClipModal } from "./Modals";
import styles from "./NewEditorShell.module.css";
import { type Span } from "./RegionTimeline";
import { TimelinePane } from "./TimelinePane";
import { TransportBar } from "./TransportBar";
import type { VideoSource } from "./VirtualPreview";

type RegionKind = "zoom" | "skip" | "annotation" | "speed";

interface RegionHandle {
	kind: RegionKind;
	id: string;
}

interface BottombarProps {
	clips: AxcutClip[];
	videoSources: VideoSource[];
	currentTimeSec: number;
	onSeek: (timelineSec: number) => void;
	zoomRegions: AxcutDocument["zoomRanges"];
	skipRanges: AxcutDocument["timeline"]["skipRanges"];
	annotationRegions: AnnotationRegion[];
	speedRegions: Array<{ id: string; startMs: number; endMs: number; speed: number }>;
	selection: RegionHandle | null;
	// F2.7 — full shift-click selection set, for multi-select highlighting.
	multiSelection?: RegionHandle[];
	hasDoc: boolean;
	onAddZoom: () => void;
	onAddAnnotation: () => void;
	onAddSpeed: () => void;
	// T15 — receives a setter so the parent's "T" keyboard shortcut can
	// call into our togglePlaceSkip (state lives here, body-class + Esc
	// handler live here). The Scissors button in this component calls
	// togglePlaceSkip directly.
	setTogglePlaceSkip?: (fn: () => void) => void;
	onSelectRegion: (kind: RegionKind, id: string, additive?: boolean) => void;
	onCaptions: () => void;
	// ponytail: the video transport now renders in this header (merged into
	// the same row as the zoom/cut/etc. tools) instead of under the preview
	// canvas — state lives in the parent shell (NewEditorShell), which also
	// owns the video element.
	playing: boolean;
	loop: boolean;
	onTogglePlay: () => void;
	onPrevClip: () => void;
	onNextClip: () => void;
	onToggleLoop: () => void;
	onExpand: () => void;
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

export function Bottombar({
	clips,
	videoSources,
	currentTimeSec,
	onSeek,
	zoomRegions,
	skipRanges,
	annotationRegions,
	speedRegions,
	selection,
	multiSelection,
	hasDoc,
	onAddZoom,
	onAddAnnotation,
	onAddSpeed,
	setTogglePlaceSkip,
	onSelectRegion,
	onCaptions,
	playing,
	loop,
	onTogglePlay,
	onPrevClip,
	onNextClip,
	onToggleLoop,
	onExpand,
}: BottombarProps) {
	const { settings, set } = useEditorSettings();
	const tl = useTimeline();
	const [ratioOpen, setRatioOpen] = useState(false);
	const ratioButtonRef = useRef<HTMLButtonElement | null>(null);
	// ponytail: `.bottombar` sets `overflow: hidden` to contain the timeline
	// lanes, which also clips any absolutely-positioned child that escapes
	// its box -- including this menu. Render it through a portal, positioned
	// from the button's live viewport rect, so it paints above everything
	// regardless of ancestor overflow/stacking.
	const [ratioMenuRect, setRatioMenuRect] = useState<{ left: number; bottom: number } | null>(null);
	useEffect(() => {
		if (!ratioOpen) return;
		const button = ratioButtonRef.current;
		if (!button) return;
		const rect = button.getBoundingClientRect();
		setRatioMenuRect({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
	}, [ratioOpen]);
	const [editClipTarget, setEditClipTarget] = useState<AxcutClip | null>(null);
	const firstClip = clips[0] ?? null;
	// T11 — viewport state lifted from TimelinePane so the navigator strip
	// can drive the same window. pxPerSec stays inside TimelinePane (it
	// depends on the viewport's measured width); Bottombar only owns the
	// logical window + zoom multiplier.
	const [zoom, setZoom] = useState(1);
	const [visibleStartSec, setVisibleStartSec] = useState(0);
	// T15 — Place-skip armed state. The Scissors (Trim) button toggles
	// this; the timeline pane shows the red preview marker and the cursor
	// becomes crosshair. Esc cancels. The preview is pinned to the
	// playhead the moment the mode is armed so the user sees the marker
	// right away (axcut's behavior).
	const [pendingCutPlacement, setPendingCutPlacement] = useState(false);
	const [pendingCutPreviewSec, setPendingCutPreviewSec] = useState<number | null>(null);
	const togglePlaceSkip = useCallback(() => {
		setPendingCutPlacement((active) => {
			if (active) {
				setPendingCutPreviewSec(null);
				return false;
			}
			setPendingCutPreviewSec(currentTimeSec);
			return true;
		});
	}, [currentTimeSec]);

	// F2.1 — Magic button: propose zoom regions over sustained speech
	// segments and append them to the document in one save.
	const applyZoomSuggestions = useCallback(async () => {
		const store = useProjectStore.getState();
		const doc = store.document;
		if (!doc) return;
		const suggestions = suggestZoomRegions(doc);
		if (suggestions.length === 0) {
			toast.info("No zoom suggestions found", {
				description: doc.transcripts.length
					? "No sustained speech segments without an existing zoom."
					: "Transcribe the recording first — suggestions come from the transcript.",
			});
			return;
		}
		try {
			await store.saveDocument({
				...doc,
				zoomRanges: [...doc.zoomRanges, ...suggestions] as AxcutDocument["zoomRanges"],
			});
			toast.success(
				`Added ${suggestions.length} zoom suggestion${suggestions.length === 1 ? "" : "s"}`,
			);
		} catch (err) {
			toast.error("Could not apply zoom suggestions", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, []);

	// T15 — body cursor + Esc-to-cancel while placing a cut. Lives here
	// (not in TimelinePane) because the state lives here.
	useEffect(() => {
		if (!pendingCutPlacement) {
			document.body.classList.remove("timeline-placing-cut");
			return;
		}
		document.body.classList.add("timeline-placing-cut");
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setPendingCutPlacement(false);
				setPendingCutPreviewSec(null);
			}
		};
		window.addEventListener("keydown", handleKey);
		return () => {
			document.body.classList.remove("timeline-placing-cut");
			window.removeEventListener("keydown", handleKey);
		};
	}, [pendingCutPlacement]);

	// ponytail: register our toggler with the parent (NewEditorShell)
	// so the "T" keyboard shortcut can call the same function the
	// Scissors button does. Uses an effect so re-renders (togglePlaceSkip
	// identity is stable but the ref it points to may change) always
	// see the latest implementation.
	useEffect(() => {
		setTogglePlaceSkip?.(togglePlaceSkip);
	}, [togglePlaceSkip, setTogglePlaceSkip]);

	const sourceDurationSec = Math.max(0.001, ...clips.map((c) => c.timelineEndSec));
	const visibleEndSec = Math.min(visibleStartSec + sourceDurationSec, sourceDurationSec);
	void visibleEndSec; // surfaced to the navigator (now inside TimelinePane)
	const handleRegionSpanChange = (id: string, span: Span) => {
		if (zoomRegions.some((z) => z.id === id)) void tl.updateZoomSpan(id, span.start, span.end);
		else if (speedRegions.some((s) => s.id === id))
			void tl.updateSpeedSpan(id, span.start, span.end);
		else if (skipRanges.some((s) => s.id === id)) {
			// ponytail: skip spans are edited in timeline (virtual) ms via the
			// same lane drag/resize as zoom/speed/annotation, but persisted in
			// source-time seconds (skipRangeSchema) — map back through the
			// clip the span resolves to.
			const startPos = locateVirtualPosition(clips, span.start / 1000);
			const endPos = locateVirtualPosition(clips, span.end / 1000);
			if (startPos && endPos) {
				void tl.updateSkipRange(id, startPos.sourceTimeSec, endPos.sourceTimeSec);
			}
		} else void tl.updateAnnotationSpan(id, span.start, span.end);
	};
	// ponytail: T10 removed the explicit onRemoveRegion prop (region
	// removal happens via the Del/Bksp shortcut wired in NewEditorShell).
	const editClipAsset = editClipTarget
		? (tl.assets.find((a) => a.id === editClipTarget.assetId) ?? null)
		: null;
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
						<VtBtn
							label="Trim"
							title={
								pendingCutPlacement
									? "Click on the timeline to place a 1s skip (Esc to cancel)"
									: "Arm the place-skip tool (T) — next click drops a 1s skip"
							}
							onClick={togglePlaceSkip}
							disabled={!hasDoc}
							on={pendingCutPlacement}
						>
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
						<VtBtn
							label="Magic"
							title="Auto zoom suggestions — propose zooms over sustained speech"
							disabled={!hasDoc}
							onClick={() => void applyZoomSuggestions()}
						>
							<WandSparkles size={17} />
						</VtBtn>
						<div style={{ position: "relative" }}>
							<button
								ref={ratioButtonRef}
								type="button"
								className={styles.ratio}
								onClick={() => setRatioOpen((v) => !v)}
								aria-haspopup="menu"
								aria-expanded={ratioOpen}
							>
								<span>{RATIO_LABELS[settings.aspectRatio]}</span>
								<ChevronDown size={10} className="caret" />
							</button>
							{ratioOpen && ratioMenuRect
								? createPortal(
										<div
											role="menu"
											style={{
												position: "fixed",
												left: ratioMenuRect.left,
												bottom: ratioMenuRect.bottom,
												minWidth: 120,
												background: "var(--surface)",
												border: "1px solid var(--border)",
												borderRadius: "var(--r-md)",
												boxShadow: "var(--elev-pop)",
												padding: 4,
												zIndex: 1000,
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
										</div>,
										document.body,
									)
								: null}
						</div>
					</div>
					<TransportBar
						playing={playing}
						loop={loop}
						currentTimeSec={currentTimeSec}
						clips={clips}
						onTogglePlay={onTogglePlay}
						onPrevClip={onPrevClip}
						onNextClip={onNextClip}
						onToggleLoop={onToggleLoop}
						onExpand={onExpand}
						onSeek={onSeek}
					/>
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
						<button
							type="button"
							className={styles.vtBtn}
							style={{
								marginLeft: 8,
								height: 28,
								width: "auto",
								padding: "0 10px",
								gap: 6,
								borderRadius: "var(--r-sm)",
							}}
							onClick={() => firstClip && setEditClipTarget(firstClip)}
							disabled={!firstClip}
							title={firstClip ? "Edit the first clip's in/out points" : "Add a clip first"}
							aria-label="Edit clip"
						>
							<Pencil size={14} />
							Edit clip…
						</button>
					</div>
				</header>
				<div className={styles.timelineBody}>
					{/* T10 — clip track + region lanes both live inside
					    TimelinePane's .timeline-canvas, so they share the
					    translateX(pan) and pxPerSec(zoom). Lanes-in-canvas,
					    not lanes-in-a-sibling-column. */}
					<div className="timelinePaneWrap" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
						<TimelinePane
							clips={clips}
							assets={tl.assets}
							skipRanges={skipRanges}
							zoomRegions={zoomRegions}
							annotationRegions={annotationRegions}
							speedRegions={speedRegions}
							regionSelection={selection}
							regionMultiSelection={multiSelection}
							currentTimeSec={currentTimeSec}
							selectedClipId={tl.clipSelection}
							onSelectClip={tl.selectClip}
							onSelectRegion={onSelectRegion}
							onSeek={onSeek}
							onInsertAsset={(assetId, index) => void tl.insertClipAt(assetId, index)}
							onMoveClip={(clipId, toIndex) => void tl.moveClip(clipId, toIndex)}
							onEditClip={(clip) => setEditClipTarget(clip)}
							onRemoveClip={(clipId) => void tl.removeClip(clipId)}
							onAddSkip={(assetId, s, e) => void tl.addSkipAt(assetId, s, e)}
							onRegionSpanChange={(id, span) => handleRegionSpanChange(id, span)}
							zoom={zoom}
							visibleStartSec={visibleStartSec}
							setZoom={setZoom}
							setVisibleStartSec={setVisibleStartSec}
							pendingCutPlacement={pendingCutPlacement}
							pendingCutPreviewSec={pendingCutPreviewSec}
							setPendingCutPreviewSec={setPendingCutPreviewSec}
							onCancelPlaceSkip={() => togglePlaceSkip()}
						/>
					</div>
				</div>
			</section>
			<EditClipModal
				open={editClipTarget !== null}
				onClose={() => setEditClipTarget(null)}
				clip={editClipTarget}
				assetMeta={
					editClipAsset
						? { label: editClipAsset.label, durationSec: editClipAsset.durationSec }
						: null
				}
				videoSources={videoSources}
				onApply={(sourceStartSec, sourceEndSec) => {
					if (editClipTarget) {
						void tl.updateClipSourceRange(editClipTarget.id, sourceStartSec, sourceEndSec);
					}
				}}
			/>
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
