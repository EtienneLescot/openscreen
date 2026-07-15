import {
	ChevronDown,
	Clock,
	Loader2,
	Maximize2,
	MessageSquare,
	Pencil,
	Scissors,
	Sparkles,
	SplitSquareHorizontal,
	Trash2,
	Wand2,
	ZoomIn,
} from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fromFileUrl } from "@/components/video-editor/projectPersistence";
import { ZOOM_DEPTH_SCALES } from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import { useAudioPeaks } from "@/hooks/useAudioPeaks";
import { createId } from "@/lib/ai-edition/document/ids";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useChatPromptBus } from "@/lib/ai-edition/store/useChatPromptBus";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { ventilateSpanAcrossClips } from "@/lib/ai-edition/timeline/region-ventilation";
import {
	coalescedTrimGroups,
	resolveTimelineSpanToTrim,
	ventilateTimelineSpanToTrims,
} from "@/lib/ai-edition/timeline/trim-mapping";
import { buildAutoZoomSuggestions } from "@/lib/ai-edition/timeline/zoom-suggestions";
import { nativeBridgeClient } from "@/native/client";
import { ASPECT_RATIOS } from "@/utils/aspectRatioUtils";
import { TransportBar } from "../TransportBar";
import type { VideoSource } from "../VirtualPreview";
import styles from "./EditorShellV4.module.css";

// Well-crafted generic prompt for the AI "smart zooms + cuts" option — sent
// straight to the chat agent via the prompt-bus.
const AI_ENHANCE_PROMPT =
	"Automatically enhance this recording: (1) add smart zoom-ins on the moments where the cursor dwells or interacts with the UI, each focused on the cursor's location; and (2) cut the dead time — long pauses, silences, and idle stretches where nothing happens — to keep the pacing tight and natural. Apply the edits directly to the timeline.";

type TimelineApi = ReturnType<typeof useTimeline>;

const ASSET_MIME = "application/x-axcut-asset";

type ToolId = "cut" | "comment" | "speed";

function fmt(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) sec = 0;
	const m = Math.floor(sec / 60);
	const s = (sec % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

// Ruler tick labels sit on whole-second "nice" steps, so tenths are always
// ".0" noise — show clean M:SS (H:MM:SS past an hour) instead.
function fmtTick(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) sec = 0;
	const total = Math.round(sec);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const ss = String(total % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Real per-clip audio waveform, sliced from the underlying asset's decoded
// peaks (useAudioPeaks) down to this clip's [sourceStartSec, sourceEndSec]
// range. A separate component (not inline in the clips .map) so each clip
// gets its own hook call — useAudioPeaks caches by URL, so clips sharing an
// asset only decode once. Renders nothing while decoding or if the source has
// no audio track, so the clip pill just shows its label until peaks arrive.
function ClipWaveform({
	videoUrl,
	assetDurationSec,
	sourceStartSec,
	sourceEndSec,
}: {
	videoUrl: string | undefined;
	assetDurationSec: number | undefined;
	sourceStartSec: number;
	sourceEndSec: number;
}) {
	const peaks = useAudioPeaks(videoUrl);
	const bars = useMemo(() => {
		if (!peaks || peaks.length === 0 || !assetDurationSec) return null;
		const totalBlocks = Math.floor(peaks.length / 2);
		if (totalBlocks === 0) return null;
		const blocksPerSec = totalBlocks / assetDurationSec;
		const startBlock = Math.max(0, Math.floor(sourceStartSec * blocksPerSec));
		const endBlock = Math.min(totalBlocks, Math.ceil(sourceEndSec * blocksPerSec));
		const rangeBlocks = Math.max(1, endBlock - startBlock);
		// One bar per ~120ms of clip duration — dense enough to read as a
		// continuous waveform — but capped so a long recording doesn't spawn
		// thousands of DOM nodes in a single clip (a clip is at most ~the timeline
		// width on screen, so beyond a few hundred bars they're sub-pixel anyway).
		const barCount = Math.min(400, Math.max(20, Math.round((sourceEndSec - sourceStartSec) * 8)));
		const result: number[] = [];
		for (let i = 0; i < barCount; i++) {
			const blockStart = startBlock + Math.floor((i / barCount) * rangeBlocks);
			const blockEnd = Math.max(
				blockStart + 1,
				startBlock + Math.floor(((i + 1) / barCount) * rangeBlocks),
			);
			let amp = 0;
			for (let b = blockStart; b < blockEnd && b < totalBlocks; b++) {
				const lo = Math.abs(peaks[b * 2] ?? 0);
				const hi = Math.abs(peaks[b * 2 + 1] ?? 0);
				amp = Math.max(amp, lo, hi);
			}
			result.push(amp);
		}
		return result;
	}, [peaks, assetDurationSec, sourceStartSec, sourceEndSec]);

	if (!bars) return null;
	return (
		<div aria-hidden className={styles.tlWave}>
			{bars.map((h, bi) => (
				<span
					key={bi}
					style={{
						height: `${Math.max(8, Math.round(h * 100))}%`,
						opacity: (0.5 + h * 0.5).toFixed(2),
					}}
				/>
			))}
		</div>
	);
}

interface LanePill {
	id: string;
	kind: "annotation" | "speed" | "trim" | "zoom" | "cameraFullscreen";
	start: number;
	end: number;
	label: string;
	/** Underlying row ids this pill represents — >1 for a coalesced trim group. */
	sourceIds: string[];
}

export function V4Timeline({
	tl,
	currentTimeSec,
	setCurrentTime,
	variant = "edit",
	onDropAsset,
	videoSources = [],
	playing,
	loop,
	onTogglePlay,
	onPrevClip,
	onNextClip,
	onToggleLoop,
	onExpand,
	onEditClip,
}: {
	tl: TimelineApi;
	currentTimeSec: number;
	setCurrentTime: (sec: number) => void;
	variant?: "edit" | "media";
	onDropAsset?: (assetId: string) => void;
	videoSources?: VideoSource[];
	playing: boolean;
	loop: boolean;
	onTogglePlay: () => void;
	onPrevClip: () => void;
	onNextClip: () => void;
	onToggleLoop: () => void;
	onExpand: () => void;
	/** Opens the (now single, shell-level) EditClipModal for this clip —
	 * trim in/out and crop both live there per-clip. */
	onEditClip: (clip: AxcutClip) => void;
}) {
	const t = useScopedT("timeline");
	const tracksRef = useRef<HTMLDivElement | null>(null);
	// The transformed canvas is the true timeline coordinate frame — clips, pills
	// and the playhead are all positioned inside it. Time↔x math must measure THIS
	// (not the padded/scrollbar-inset tracks box), else clicks map to the wrong
	// time and the mapping drifts as the scrollbar appears/disappears.
	const canvasRef = useRef<HTMLDivElement | null>(null);
	const navRef = useRef<HTMLDivElement | null>(null);
	const clipsRef = useRef<HTMLDivElement | null>(null);
	// True while a clip pointer-drag actually moved the pointer past the
	// threshold, so the click fired on pointerup selects nothing (a drag is
	// not a select). Reset at the start of each new clip pointerdown.
	const didClipDragRef = useRef(false);
	const [nav, setNav] = useState({ start: 0, end: 1 });
	const [dragOver, setDragOver] = useState(false);
	const [snapPct, setSnapPct] = useState<number | null>(null);
	// Live clip-reorder drag: the dragged clip follows the pointer directly
	// (pointerDeltaX, no transition) while every clip between its origin and
	// live target slides sideways by the dragged clip's own width+gap (with
	// a CSS transition) to open a visible gap at the drop point — a manual
	// FLIP-style reorder rather than a static insertion line.
	const [clipDrag, setClipDrag] = useState<{
		id: string;
		from: number;
		target: number;
		pointerDeltaX: number;
		shiftPx: number;
	} | null>(null);
	const { settings, set: setSettings } = useEditorSettings();

	const [aspectMenuOpen, setAspectMenuOpen] = useState(false);
	const [autoEnhanceOpen, setAutoEnhanceOpen] = useState(false);
	const [autoBusy, setAutoBusy] = useState(false);

	const clips = tl.clips;
	const total = useMemo(
		() =>
			Math.max(
				1,
				clips.reduce((m, c) => Math.max(m, c.timelineEndSec), 0),
			),
		[clips],
	);
	const pctOf = useCallback((sec: number) => (sec / total) * 100, [total]);
	const showLanes = variant === "edit";

	// ── region lanes ────────────────────────────────────────────────
	// zoom/speed/annotation: one pill per row, never coalesced — each carries
	// distinct per-instance content (depth/focus, speed value, text) that two
	// touching-but-different regions must not silently merge into one.
	const annPills: LanePill[] = tl.annotationRegions.map((a) => ({
		id: a.id,
		kind: "annotation",
		start: a.startMs / 1000,
		end: a.endMs / 1000,
		label: t("toolbar.newAnnotation"),
		sourceIds: [a.id],
	}));
	const speedPills: LanePill[] = tl.speedRegions.map((s) => ({
		id: s.id,
		kind: "speed",
		start: s.startMs / 1000,
		end: s.endMs / 1000,
		label: `${(s as { speed?: number }).speed ?? 1.5}×`,
		sourceIds: [s.id],
	}));
	const cameraFullscreenPills: LanePill[] = tl.cameraFullscreenRegions.map((c) => ({
		id: c.id,
		kind: "cameraFullscreen",
		start: c.startMs / 1000,
		end: c.endMs / 1000,
		label: "Full Camera",
		sourceIds: [c.id],
	}));
	const zoomPills: LanePill[] = tl.zoomRegions.map((z) => ({
		id: z.id,
		kind: "zoom",
		start: z.startMs / 1000,
		end: z.endMs / 1000,
		// Matches RightPanelStack's effectiveZoomScale: a custom scale (from the
		// slider) overrides the depth preset; otherwise show the depth's actual
		// preset value, not a fabricated linear approximation of it.
		label: `${(z.customScale ?? ZOOM_DEPTH_SCALES[z.depth]).toFixed(2)}×`,
		sourceIds: [z.id],
	}));
	// trims: content-free (no per-instance text/settings), so touching rows —
	// inevitable once a trim is ventilated across a clip boundary — are
	// coalesced into one pill. This is what makes growing a trim across a
	// junction look like one continuously-growing pill instead of visibly
	// splitting, aligning trims with how zoom/speed/annotation already behave.
	const trimPills: LanePill[] = coalescedTrimGroups(tl.trimRanges, clips).map((g) => ({
		id: g.ids[0],
		kind: "trim",
		start: g.start,
		end: g.end,
		label: fmt(g.end - g.start),
		sourceIds: g.ids,
	}));

	const rulerTicks = useMemo(() => {
		// Adaptive interval so a long recording shows ~a dozen labels instead of
		// one every 15s (which crams the ruler unreadably past a few minutes).
		const NICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
		const step = NICE_STEPS.find((s) => total / s <= 12) ?? NICE_STEPS[NICE_STEPS.length - 1];
		const out: string[] = [];
		for (let t = 0; t <= total; t += step) out.push(fmtTick(t));
		return out;
	}, [total]);

	// ── interactions ────────────────────────────────────────────────
	const seekToClientX = useCallback(
		(clientX: number) => {
			// Measure the canvas (the zoomed timeline frame): (clientX - left)/width
			// is the fraction along the FULL timeline under the cursor, so it stays
			// correct under zoom/pan and is unaffected by padding or the scrollbar.
			const el = canvasRef.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
			setCurrentTime(pct * total);
		},
		[setCurrentTime, total],
	);

	// Mousedown anywhere on the empty timeline (ruler, lanes background, or
	// the playhead diamond itself) seeks immediately AND arms a scrub drag —
	// a single pointerdown→pointermove→pointerup replaces the old
	// click-only seek, and doubles as the playhead's drag handle since
	// dragging from its exact position is the same math as dragging from
	// anywhere else. Also clears any region selection, closing the
	// selected-element settings pane (FloatingInspector) the way clicking
	// away from a selected element is expected to.
	const startScrub = useCallback(
		(e: ReactPointerEvent) => {
			if (e.button !== 0) return;
			const target = e.target as HTMLElement;
			if (target.closest("[data-clip-id]") || target.closest(`.${styles.lanePill}`)) return;
			tl.clearSelection();
			seekToClientX(e.clientX);
			const move = (ev: PointerEvent) => seekToClientX(ev.clientX);
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[seekToClientX, tl],
	);

	// Drag a lane pill to move it (mode "move", keeps duration) or resize one
	// edge (mode "l"/"r"). Zoom/speed/annotation are timeline-ms; trims map
	// back to source-seconds through their carrying clip.
	const startPillDrag = useCallback(
		(e: ReactPointerEvent, pill: LanePill, dragMode: "move" | "l" | "r") => {
			e.preventDefault();
			e.stopPropagation();
			tl.selectRegion(pill.kind, pill.id, { additive: e.shiftKey });
			// Scale drag deltas against the canvas (full zoomed timeline) width, so a
			// drag tracks the cursor exactly regardless of padding, scrollbar or zoom.
			const el = canvasRef.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			const startX = e.clientX;
			const dur = pill.end - pill.start;
			// A trim can span several clips; it's stored as one source-time entry per
			// covered clip. `trimOwned` are the entry ids this drag controls — seeded
			// from every row the grabbed (possibly already-coalesced) pill represents,
			// then grows as the span reaches into more clips (fresh ids appended).
			// `trimOwned` only grows; ids past the current fragment count are handed
			// to `setTrimEntries` as `dropIds` so a shrinking span deletes the entries
			// it no longer needs.
			const trimOwned: string[] = [...pill.sourceIds];
			// Snap targets: clip boundaries + timeline ends. Within ~1% of total,
			// an edge snaps and a vertical guide is shown (Bottombar parity).
			const snapTargets = [
				0,
				total,
				...clips.map((c) => c.timelineStartSec),
				...clips.map((c) => c.timelineEndSec),
			];
			const snapThresh = total * 0.012;
			const snap = (v: number): number => {
				let best = v;
				let bestD = snapThresh;
				for (const t of snapTargets) {
					const d = Math.abs(t - v);
					if (d < bestD) {
						bestD = d;
						best = t;
					}
				}
				setSnapPct(best === v ? null : (best / total) * 100);
				return best;
			};
			const apply = (start: number, end: number) => {
				const s = Math.max(0, Math.min(end - 0.2, start));
				const en = Math.min(total, Math.max(s + 0.2, end));
				if (pill.kind === "zoom") void tl.updateZoomSpan(pill.id, s * 1000, en * 1000);
				else if (pill.kind === "speed") void tl.updateSpeedSpan(pill.id, s * 1000, en * 1000);
				else if (pill.kind === "annotation")
					void tl.updateAnnotationSpan(pill.id, s * 1000, en * 1000);
				else if (pill.kind === "cameraFullscreen")
					void tl.updateCameraFullscreenSpan(pill.id, s * 1000, en * 1000);
				else {
					// Trims are stored in source-time per asset but manipulated on the
					// timeline like every other pill. Ventilate the new span across the
					// clips it covers (one source range per clip) — the same primitive
					// zoom/speed/annotation use on reorder, so trims can now be grown
					// across a clip boundary just like a zoom.
					let ranges = ventilateTimelineSpanToTrims(s, en, clips);
					if (ranges.length === 0) {
						// Span sits in a gap / past the end: fall back to the nearest clip.
						const resolved = resolveTimelineSpanToTrim(s, en, clips);
						if (!resolved) return;
						ranges = [resolved];
					}
					// Grow the owned-id list to cover every fragment, keeping ids stable
					// across frames; ids past the current fragment count are dropped.
					while (trimOwned.length < ranges.length) trimOwned.push(createId("trim"));
					const entries = ranges.map((rng, i) => ({ id: trimOwned[i], ...rng }));
					const dropIds = trimOwned.slice(ranges.length);
					void tl.setTrimEntries(entries, dropIds);
				}
			};
			const move = (ev: PointerEvent) => {
				const dxSec = ((ev.clientX - startX) / r.width) * total;
				if (dragMode === "move") {
					const ns = Math.max(0, Math.min(total - dur, snap(pill.start + dxSec)));
					apply(ns, ns + dur);
				} else if (dragMode === "l") {
					apply(snap(pill.start + dxSec), pill.end);
				} else {
					apply(pill.start, snap(pill.end + dxSec));
				}
			};
			const up = () => {
				setSnapPct(null);
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[tl, total, clips],
	);

	const startNavDrag = useCallback(
		(mode: "left" | "right" | "pan", e: ReactPointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const r = navRef.current?.getBoundingClientRect();
			if (!r) return;
			const startX = e.clientX;
			const s0 = nav.start;
			const e0 = nav.end;
			const move = (ev: PointerEvent) => {
				const dx = (ev.clientX - startX) / r.width;
				let start = s0;
				let end = e0;
				if (mode === "left") start = Math.min(e0 - 0.05, Math.max(0, s0 + dx));
				else if (mode === "right") end = Math.max(s0 + 0.05, Math.min(1, e0 + dx));
				else {
					const w = e0 - s0;
					start = Math.max(0, Math.min(1 - w, s0 + dx));
					end = start + w;
				}
				setNav({ start, end });
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[nav],
	);

	// Plain scroll = vertical scroll (the panel can be too short to show every
	// lane + the main track). Shift+scroll = horizontal pan. Ctrl+scroll = zoom
	// around the cursor's timeline position.
	// Attached as a native (non-passive) listener rather than React's onWheel:
	// React marks wheel handlers passive by default, so e.preventDefault()
	// there silently no-ops and the browser/OS still intercepts Ctrl+wheel as
	// a page-zoom gesture.
	useEffect(() => {
		const el = tracksRef.current;
		if (!el) return;
		const onWheelNative = (e: WheelEvent) => {
			const r = el.getBoundingClientRect();
			const viewportPct = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
			if (e.ctrlKey) {
				e.preventDefault();
				setNav((prev) => {
					const width = prev.end - prev.start;
					const cursorFrac = prev.start + viewportPct * width;
					const zoomFactor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
					const nextWidth = Math.min(1, Math.max(0.02, width * zoomFactor));
					const start = Math.max(0, Math.min(1 - nextWidth, cursorFrac - viewportPct * nextWidth));
					return { start, end: start + nextWidth };
				});
			} else if (e.shiftKey) {
				e.preventDefault();
				setNav((prev) => {
					const width = prev.end - prev.start;
					// Shift often routes the wheel onto deltaX; accept whichever axis moved.
					const wheelDelta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
					const delta = (wheelDelta / r.width) * width;
					const start = Math.max(0, Math.min(1 - width, prev.start + delta));
					return { start, end: start + width };
				});
			}
			// Otherwise let the native vertical scroll of .tlTracks run (no preventDefault).
		};
		el.addEventListener("wheel", onWheelNative, { passive: false });
		return () => el.removeEventListener("wheel", onWheelNative);
	}, []);

	// zoom/pan: the tracks canvas is widened by 1/(navEnd-navStart) and shifted.
	const navSpan = Math.max(0.02, nav.end - nav.start);
	const canvasStyle = {
		width: `${(100 / navSpan).toFixed(3)}%`,
		transform: `translateX(${(-nav.start * (100 / navSpan)).toFixed(3)}%)`,
	} as const;

	const laneOf = (kind: LanePill["kind"]) =>
		kind === "annotation"
			? styles.laneAnnotation
			: kind === "speed"
				? styles.laneSpeed
				: kind === "trim"
					? styles.laneTrim
					: kind === "cameraFullscreen"
						? styles.laneCameraFullscreen
						: styles.laneZoom;
	const pillIcon = (kind: LanePill["kind"]) =>
		kind === "annotation" ? (
			<MessageSquare size={11} />
		) : kind === "speed" ? (
			<Clock size={11} />
		) : kind === "trim" ? (
			<Scissors size={11} />
		) : kind === "cameraFullscreen" ? (
			<Maximize2 size={11} />
		) : (
			<ZoomIn size={11} />
		);

	// Drag a clip left/right to reorder it relative to its neighbours. Pointer-
	// driven (like the lane pills), not HTML5 DnD — that's reserved for dropping
	// a *new* asset in from the media panel. A short move threshold keeps a
	// plain click as "select" and a stationary press as "double-click to edit".
	// On drop we hand the target index to tl.moveClip, which delegates to the
	// same document/timeline.ts#moveClip the agent's "move_clip" tool uses.
	const startClipDrag = useCallback(
		(e: ReactPointerEvent, clip: AxcutClip) => {
			if (e.button !== 0) return;
			// Let the delete button (and any future in-clip control) handle its
			// own pointer events instead of starting a drag.
			if ((e.target as HTMLElement).closest("[data-no-clip-drag]")) return;
			if (clips.length < 2) return;
			const container = clipsRef.current;
			const clipEl = (e.currentTarget as HTMLElement) ?? null;
			if (!container || !clipEl) return;
			const startX = e.clientX;
			const from = clips.findIndex((c) => c.id === clip.id);
			if (from < 0) return;
			didClipDragRef.current = false;
			let dragging = false;
			// Width + gap the dragged clip displaces its neighbours by — measured
			// once at drag start (only its position changes during the drag, not
			// its size).
			const gapPx = 6;
			const shiftAmount = clipEl.getBoundingClientRect().width + gapPx;

			// Boundaries are captured once, before any transform is applied —
			// re-querying live rects mid-drag would pick up the dragged clip's own
			// translated (pointer-following) position and corrupt the math, since
			// its rect no longer reflects its untouched flex slot.
			const originalRects = Array.from(
				container.querySelectorAll<HTMLElement>("[data-clip-id]"),
			).map((el) => el.getBoundingClientRect());
			const boundaries =
				originalRects.length === 0
					? [0]
					: [
							originalRects[0].left,
							...originalRects.slice(1).map((r, i) => (originalRects[i].right + r.left) / 2),
							originalRects[originalRects.length - 1].right,
						];
			// Nearest clip boundary to `clientX`, as an insertion index into the
			// *full* clip array (0..n).
			const computeInsertFull = (clientX: number) => {
				let bi = 0;
				let bd = Number.POSITIVE_INFINITY;
				for (let i = 0; i < boundaries.length; i++) {
					const d = Math.abs(boundaries[i] - clientX);
					if (d < bd) {
						bd = d;
						bi = i;
					}
				}
				return bi;
			};
			// insertFull indexes the full array; moveClip (and our own preview
			// math) target the array with the dragged clip already removed, so
			// shift down by one when the drop point is to the right of its origin.
			const computeTarget = (clientX: number) => {
				const insertFull = computeInsertFull(clientX);
				return insertFull > from ? insertFull - 1 : insertFull;
			};

			const move = (ev: PointerEvent) => {
				if (!dragging && Math.abs(ev.clientX - startX) < 4) return;
				dragging = true;
				didClipDragRef.current = true;
				const target = computeTarget(ev.clientX);
				setClipDrag({
					id: clip.id,
					from,
					target,
					pointerDeltaX: ev.clientX - startX,
					shiftPx: shiftAmount,
				});
			};
			const up = async (ev: PointerEvent) => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				if (dragging) {
					const target = computeTarget(ev.clientX);
					// Keep the slid-open preview on screen through the async save so
					// there's no one-frame snap-back to the original order before the
					// store's new order lands.
					if (target !== from) await tl.moveClip(clip.id, target);
				}
				setClipDrag(null);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[clips, tl],
	);

	const tools: Array<{ id: ToolId; label: string; icon: React.ReactNode }> = [
		{ id: "cut", label: t("buttons.addTrim"), icon: <SplitSquareHorizontal size={15} /> },
		{ id: "comment", label: t("toolbar.comment"), icon: <MessageSquare size={15} /> },
		{ id: "speed", label: t("buttons.addSpeed"), icon: <Clock size={15} /> },
	];

	// Auto-enhance option 1 — the deterministic cursor-telemetry auto-zoom
	// (ported from main; NOT AI). Reads the recorded cursor movement for the
	// primary asset and drops zoom-ins on the dwell moments.
	const runAutoZooms = useCallback(async () => {
		setAutoEnhanceOpen(false);
		const source = videoSources[0];
		const asset = tl.assets.find((a) => a.id === source?.id) ?? tl.assets[0];
		if (!source || !asset) {
			toast.error(t("toolbar.importRecordingFirst"));
			return;
		}
		setAutoBusy(true);
		try {
			const telemetry =
				(await nativeBridgeClient.cursor.getTelemetry(fromFileUrl(source.src))) ?? [];
			const suggestions = buildAutoZoomSuggestions({
				cursorTelemetry: telemetry,
				totalMs: (asset.durationSec ?? 0) * 1000,
				existingRegions: tl.zoomRegions.map((z) => ({ startMs: z.startMs, endMs: z.endMs })),
				defaultDurationMs: 2000,
			});
			if (suggestions.length === 0) {
				toast.info(t("toolbar.noAutoZoomMoments"), {
					description: t("toolbar.noAutoZoomMomentsDescription"),
				});
				return;
			}
			const added = await tl.addZoomsBulk(suggestions);
			toast.success(
				t(added === 1 ? "toolbar.addedAutoZoom" : "toolbar.addedAutoZoomPlural", { count: added }),
			);
		} catch (err) {
			toast.error(t("toolbar.autoZoomFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setAutoBusy(false);
		}
	}, [videoSources, tl, t]);

	// Auto-enhance option 2 — hand a generic prompt to the AI agent (smart
	// zooms + cuts) via the chat prompt-bus.
	const runAiEnhance = useCallback(() => {
		setAutoEnhanceOpen(false);
		useChatPromptBus.getState().submit(AI_ENHANCE_PROMPT);
		toast.success(t("toolbar.aiEnhanceRequested"));
	}, [t]);

	const isPillSelected = (id: string) =>
		tl.selection?.id === id || tl.multiSelection.some((m) => m.id === id);
	// Optimistic preview: during a clip-reorder drag, slide each region pill by
	// the same amount as the clip it sits on — mirroring the clip transforms so
	// zoom/speed/annotation/trim pills travel with their content in real time,
	// then land exactly where the reprojection (document/timeline.ts#moveClip)
	// puts them on drop. Returns px shift + whether it should track immediately
	// (the region on the dragged clip follows the pointer with no easing).
	const regionPreviewShift = (startSec: number): { px: number; immediate: boolean } => {
		if (!clipDrag) return { px: 0, immediate: false };
		const idx = clips.findIndex(
			(c) => startSec >= c.timelineStartSec && startSec < c.timelineEndSec,
		);
		if (idx < 0) return { px: 0, immediate: false };
		const { from, target, pointerDeltaX, shiftPx } = clipDrag;
		if (idx === from) return { px: pointerDeltaX, immediate: true };
		if (target > from && idx > from && idx <= target) return { px: -shiftPx, immediate: false };
		if (target < from && idx >= target && idx < from) return { px: shiftPx, immediate: false };
		return { px: 0, immediate: false };
	};

	// One rendered pill box — either the whole region (normal case) or one
	// fragment of a region being eagerly split-previewed across a clip-drag
	// junction (see renderPills below). Fragments are inert previews (no
	// handles/selection/content beyond the leading one) with the touching inner
	// edge de-styled so a split pill still reads as one continuous shape.
	const renderOnePill = (seg: {
		pill: LanePill;
		key: string;
		segStart: number;
		segEnd: number;
		shiftPx: number;
		immediate: boolean;
		showContent: boolean;
		interactive: boolean;
		suppressLeftSeam: boolean;
		suppressRightSeam: boolean;
	}) => {
		const { pill: p } = seg;
		return (
			<div
				key={seg.key}
				role={seg.interactive ? "button" : undefined}
				tabIndex={seg.interactive ? 0 : undefined}
				className={`${styles.lanePill} ${laneOf(p.kind)}${
					seg.interactive && isPillSelected(p.id) ? ` ${styles.lanePillSel}` : ""
				}`}
				style={{
					left: `${pctOf(seg.segStart)}%`,
					width: `${Math.max(1.5, pctOf(seg.segEnd - seg.segStart))}%`,
					transform: seg.shiftPx ? `translateX(${seg.shiftPx}px)` : undefined,
					transition: !clipDrag
						? undefined
						: seg.immediate
							? "none"
							: "transform 150ms cubic-bezier(0.2, 0, 0, 1)",
					...(seg.suppressLeftSeam
						? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeftWidth: 0 }
						: {}),
					...(seg.suppressRightSeam
						? { borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRightWidth: 0 }
						: {}),
				}}
				onPointerDown={seg.interactive ? (e) => startPillDrag(e, p, "move") : undefined}
				title={p.label}
			>
				{seg.interactive ? (
					<span
						className={styles.lanePillHandle}
						style={{ left: 0 }}
						onPointerDown={(e) => startPillDrag(e, p, "l")}
					/>
				) : null}
				{seg.showContent ? (
					<>
						{pillIcon(p.kind)}
						<span className={styles.lanePillLabel}>{p.label}</span>
					</>
				) : null}
				{seg.interactive ? (
					<span
						className={styles.lanePillHandle}
						style={{ right: 0 }}
						onPointerDown={(e) => startPillDrag(e, p, "r")}
					/>
				) : null}
			</div>
		);
	};

	const renderPills = (pills: LanePill[], emptyLabel: string) => (
		<>
			{pills.length === 0 ? <span className={styles.laneEmpty}>{emptyLabel}</span> : null}
			{pills.flatMap((p) => {
				// Eager split preview: the instant a clip is grabbed, a pill that
				// straddles the dragged clip's junction shows the same per-clip
				// split it would resolve to on drop (via moveClip's reprojection),
				// instead of moving as one block glued to whichever clip owns its
				// start. Only fork into fragments when they'd actually move
				// differently — a pill unaffected by this drag stays one DOM node.
				if (clipDrag) {
					const frags = ventilateSpanAcrossClips(p.start, p.end, clips);
					if (frags.length >= 2) {
						const clipById = new Map(clips.map((c) => [c.id, c]));
						const shifts = frags.map((f) => {
							const c = clipById.get(f.clipId);
							return c
								? regionPreviewShift(c.timelineStartSec + f.localStartSec)
								: { px: 0, immediate: false };
						});
						const first = shifts[0];
						const differ = shifts.some((s) => s.px !== first.px || s.immediate !== first.immediate);
						if (differ) {
							return frags.flatMap((f, i) => {
								const c = clipById.get(f.clipId);
								if (!c) return [];
								return [
									renderOnePill({
										pill: p,
										key: `${p.id}__f${i}`,
										segStart: c.timelineStartSec + f.localStartSec,
										segEnd: c.timelineStartSec + f.localEndSec,
										shiftPx: shifts[i].px,
										immediate: shifts[i].immediate,
										showContent: i === 0,
										interactive: false,
										suppressLeftSeam: i > 0,
										suppressRightSeam: i < frags.length - 1,
									}),
								];
							});
						}
					}
				}
				const shift = regionPreviewShift(p.start);
				return [
					renderOnePill({
						pill: p,
						key: p.id,
						segStart: p.start,
						segEnd: p.end,
						shiftPx: shift.px,
						immediate: shift.immediate,
						showContent: true,
						interactive: true,
						suppressLeftSeam: false,
						suppressRightSeam: false,
					}),
				];
			})}
		</>
	);

	return (
		<div className={styles.tl}>
			<div className={styles.tlToolbar}>
				{showLanes ? (
					<div className={styles.tlTools} role="toolbar" aria-label={t("toolbar.timelineTools")}>
						<Popover open={autoEnhanceOpen} onOpenChange={setAutoEnhanceOpen}>
							<PopoverTrigger asChild>
								<button
									type="button"
									className={styles.tlToolBtn}
									title={t("toolbar.autoEnhance")}
									aria-label={t("toolbar.autoEnhance")}
									disabled={autoBusy}
								>
									{autoBusy ? <Loader2 className="animate-spin" size={15} /> : <Wand2 size={15} />}
								</button>
							</PopoverTrigger>
							<PopoverContent
								align="start"
								sideOffset={6}
								animated={false}
								className="w-auto border-0 bg-transparent p-0 shadow-none"
							>
								<div
									className={styles.recMenu}
									style={{ position: "relative", bottom: "auto", width: 244 }}
								>
									<button
										type="button"
										className={styles.recMenuRow}
										onClick={() => void runAutoZooms()}
									>
										<ZoomIn size={15} style={{ flexShrink: 0 }} />
										<span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
											<span style={{ fontWeight: 600 }}>{t("toolbar.automaticZooms")}</span>
											<span style={{ fontSize: 11, color: "var(--muted)" }}>
												{t("toolbar.automaticZoomsHint")}
											</span>
										</span>
									</button>
									<button type="button" className={styles.recMenuRow} onClick={runAiEnhance}>
										<Sparkles size={15} style={{ flexShrink: 0 }} />
										<span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
											<span style={{ fontWeight: 600 }}>{t("toolbar.smartZoomsAndCuts")}</span>
											<span style={{ fontSize: 11, color: "var(--muted)" }}>
												{t("toolbar.smartZoomsAndCutsHint")}
											</span>
										</span>
									</button>
								</div>
							</PopoverContent>
						</Popover>
						<span className={styles.tlToolSep} aria-hidden />
						{tools.map((tool) => (
							<button
								type="button"
								key={tool.id}
								className={styles.tlToolBtn}
								title={tool.label}
								aria-label={tool.label}
								onClick={() => {
									if (tool.id === "speed") void tl.addSpeed();
									if (tool.id === "comment") void tl.addAnnotation();
									if (tool.id === "cut") void tl.addTrim();
								}}
							>
								{tool.icon}
							</button>
						))}
						<button
							type="button"
							className={styles.tlToolBtn}
							title={t("buttons.addZoom")}
							aria-label={t("buttons.addZoom")}
							onClick={() => void tl.addZoom()}
						>
							<ZoomIn size={15} />
						</button>
						<button
							type="button"
							className={styles.tlToolBtn}
							title="Full Camera"
							aria-label="Full Camera"
							onClick={() => void tl.addCameraFullscreen()}
						>
							<Maximize2 size={15} />
						</button>
						<span className={styles.tlToolSep} aria-hidden />
						<Popover open={aspectMenuOpen} onOpenChange={setAspectMenuOpen}>
							<PopoverTrigger asChild>
								<button
									type="button"
									className={styles.tlAspect}
									title={t("toolbar.aspectRatio")}
									aria-label={t("toolbar.aspectRatio")}
								>
									{settings.aspectRatio}
									<ChevronDown size={10} />
								</button>
							</PopoverTrigger>
							<PopoverContent
								align="end"
								sideOffset={6}
								animated={false}
								className="w-auto border-0 bg-transparent p-0 shadow-none"
							>
								<div
									className={styles.recMenu}
									style={{ position: "relative", bottom: "auto", width: 150 }}
								>
									{ASPECT_RATIOS.map((ratio) => (
										<button
											type="button"
											key={ratio}
											className={`${styles.recMenuRow}${
												ratio === settings.aspectRatio ? ` ${styles.active}` : ""
											}`}
											onClick={() => {
												void setSettings({ aspectRatio: ratio });
												setAspectMenuOpen(false);
											}}
										>
											{ratio}
										</button>
									))}
								</div>
							</PopoverContent>
						</Popover>
					</div>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
						<span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--fg-2)" }}>
							{t("toolbar.arrangeClips")}
						</span>
						<span style={{ fontSize: 11.5, color: "var(--meta)" }}>
							{t("toolbar.arrangeClipsHint")}
						</span>
					</div>
				)}
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
					onSeek={setCurrentTime}
				/>
				<div className={styles.tlHints}>
					<span className={styles.tlHint}>
						<span className={styles.tlKbd}>Shift+Scroll</span> {t("labels.pan")}
					</span>
					<span className={styles.tlHint}>
						<span className={styles.tlKbd}>Ctrl+Scroll</span> {t("labels.zoom")}
					</span>
				</div>
			</div>

			{/* Ruler + tracks share one relative wrapper so a single playhead overlay
			    (below) can span both — one continuous line whose head aligns with the
			    clips regardless of the tracks' scrollbar (scrollbar-gutter keeps all
			    three canvases the same width). */}
			<div className={styles.tlBody}>
				{/* Fixed ruler header: the ruler ticks stay pinned right below the toolbar
			    so they don't scroll off when the panel is short — only the lanes/clips
			    below scroll. Shares the tracks' zoom/pan transform so ticks line up. */}
				<div className={styles.tlRulerRow} onPointerDown={startScrub}>
					<div className={styles.tlCanvas} style={canvasStyle}>
						<div className={styles.tlRuler}>
							{rulerTicks.map((t, i) => (
								<span key={`${t}-${i}`}>{t}</span>
							))}
						</div>
					</div>
				</div>

				<div ref={tracksRef} className={styles.tlTracks} onPointerDown={startScrub}>
					<div ref={canvasRef} className={styles.tlCanvas} style={canvasStyle}>
						{snapPct !== null ? (
							<div aria-hidden className={styles.tlSnapGuide} style={{ left: `${snapPct}%` }} />
						) : null}

						{showLanes ? (
							<>
								<div className={styles.tlLane}>
									{renderPills(annPills, t("toolbar.noAnnotationsYet"))}
								</div>
								<div className={styles.tlLane}>
									{renderPills(speedPills, t("toolbar.constantSpeed"))}
								</div>
								<div className={styles.tlLane}>{renderPills(trimPills, t("toolbar.noTrims"))}</div>
								<div className={styles.tlLane}>{renderPills(zoomPills, "")}</div>
								<div className={styles.tlLane}>{renderPills(cameraFullscreenPills, "")}</div>
							</>
						) : null}

						<div
							ref={clipsRef}
							className={`${styles.tlClips}${dragOver ? ` ${styles.tlClipsDrag}` : ""}`}
							onDragOver={(e) => {
								e.preventDefault();
								e.dataTransfer.dropEffect = "copy";
								if (!dragOver) setDragOver(true);
							}}
							onDragLeave={() => setDragOver(false)}
							onDrop={(e) => {
								e.preventDefault();
								setDragOver(false);
								const id = e.dataTransfer.getData(ASSET_MIME);
								if (id && onDropAsset) onDropAsset(id);
							}}
						>
							{clips.map((c, i) => {
								const dur = c.timelineEndSec - c.timelineStartSec;
								const asset = tl.assets.find((a) => a.id === c.assetId);
								const clipVideoUrl = videoSources.find((v) => v.id === c.assetId)?.src;
								const selected = tl.clipSelection === c.id;
								const dragging = clipDrag?.id === c.id;
								// Siblings between the dragged clip's origin and its live
								// target slide sideways (via the base .tlClip transition) to
								// open a gap at the drop point; the dragged clip itself
								// follows the pointer directly (see .tlClipDragging's
								// transition:none override).
								let clipTransform: string | undefined;
								if (dragging) {
									clipTransform = `translateX(${clipDrag.pointerDeltaX}px)`;
								} else if (clipDrag) {
									const { from, target, shiftPx } = clipDrag;
									if (target > from && i > from && i <= target)
										clipTransform = `translateX(${-shiftPx}px)`;
									else if (target < from && i >= target && i < from)
										clipTransform = `translateX(${shiftPx}px)`;
								}
								return (
									<div
										key={c.id}
										data-clip-id={c.id}
										className={`${styles.tlClip}${selected ? ` ${styles.tlClipSel}` : ""}${
											dragging ? ` ${styles.tlClipDragging}` : ""
										}`}
										style={{ flex: `${dur} 0 0`, transform: clipTransform }}
										onPointerDown={(e) => startClipDrag(e, c)}
										onClick={(e) => {
											e.stopPropagation();
											// A completed reorder-drag also fires a click; don't let it
											// double as a selection.
											if (didClipDragRef.current) {
												didClipDragRef.current = false;
												return;
											}
											tl.selectClip(c.id);
										}}
										onDoubleClick={(e) => {
											e.stopPropagation();
											onEditClip(c);
										}}
										title={t("toolbar.dragToReorderHint")}
									>
										<ClipWaveform
											videoUrl={clipVideoUrl}
											assetDurationSec={asset?.durationSec}
											sourceStartSec={c.sourceStartSec}
											sourceEndSec={c.sourceEndSec ?? c.sourceStartSec + dur}
										/>
										<div className={styles.tlClipLabel}>
											<span
												className={styles.tlClipIcon}
												data-no-clip-drag
												title={t("toolbar.editInOutPoints")}
												onClick={(e) => {
													e.stopPropagation();
													onEditClip(c);
												}}
											>
												<Pencil size={9} />
											</span>
											<span className={styles.tlClipName}>
												{tl.assets.find((a) => a.id === c.assetId)?.label ?? c.assetId}
											</span>
										</div>
										{selected ? (
											<button
												type="button"
												data-no-clip-drag
												className={styles.tlClipDelete}
												title={t("toolbar.deleteClip")}
												aria-label={t("toolbar.deleteClip")}
												onClick={(e) => {
													e.stopPropagation();
													void tl.removeClip(c.id);
												}}
											>
												<Trash2 size={13} />
											</button>
										) : null}
									</div>
								);
							})}
							{dragOver ? (
								<div aria-hidden className={styles.tlDropHint}>
									{t("toolbar.dropToAdd")}
								</div>
							) : null}
						</div>
					</div>
				</div>

				{/* Single playhead overlay spanning the ruler + tracks: fixed vertically
			    (a cursor, so it doesn't scroll with the lanes) and sharing the exact
			    same zoom/pan transform + width as the canvases, so its line stays
			    continuous from the ruler down through the clips and its head aligns. */}
				<div className={styles.tlPlayheadLayer} aria-hidden>
					<div className={styles.tlCanvas} style={canvasStyle}>
						<div className={styles.tlPlayhead} style={{ left: `${pctOf(currentTimeSec)}%` }}>
							<span
								className={styles.tlPlayheadDiamond}
								style={{ pointerEvents: "auto", cursor: "grab" }}
								onPointerDown={(e) => {
									e.stopPropagation();
									startScrub(e);
								}}
							/>
						</div>
					</div>
				</div>
			</div>

			<div ref={navRef} className={styles.tlNav}>
				<div className={styles.tlNavTrack} />
				<div
					className={styles.tlNavWindow}
					style={{
						left: `${(nav.start * 100).toFixed(2)}%`,
						width: `${((nav.end - nav.start) * 100).toFixed(2)}%`,
					}}
					onPointerDown={(e) => startNavDrag("pan", e)}
				/>
				<div
					className={styles.tlNavHandle}
					style={{ left: `calc(${(nav.start * 100).toFixed(2)}% - 6px)` }}
					onPointerDown={(e) => startNavDrag("left", e)}
				>
					<span />
				</div>
				<div
					className={styles.tlNavHandle}
					style={{ left: `calc(${(nav.end * 100).toFixed(2)}% - 6px)` }}
					onPointerDown={(e) => startNavDrag("right", e)}
				>
					<span />
				</div>
			</div>
		</div>
	);
}
