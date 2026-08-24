import {
	Clock,
	Crosshair,
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
	memo,
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
import { setUiProbeScrubbing } from "@/lib/ai-edition/perf/uiFrameProbe";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { audioGainScalar } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useTimelineTranscriptGate } from "@/lib/ai-edition/store/transcriptionStore";
import { useChatPromptBus } from "@/lib/ai-edition/store/useChatPromptBus";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { hasAnyClipWithCamera } from "@/lib/ai-edition/timeline/camera";
import { formatSec } from "@/lib/ai-edition/timeline/format";
import {
	newRegionDurationSec,
	setTimelineScale,
} from "@/lib/ai-edition/timeline/newRegionDuration";
import { ventilateSpanAcrossClips } from "@/lib/ai-edition/timeline/region-ventilation";
import { coalesceRegionsForRuler } from "@/lib/ai-edition/timeline/timelineMap";
import {
	coalescedTrimGroups,
	resolveTimelineSpanToTrim,
	ventilateTimelineSpanToTrims,
} from "@/lib/ai-edition/timeline/trim-mapping";
import {
	type AutoZoomSuggestion,
	buildAutoZoomSuggestionsForClips,
} from "@/lib/ai-edition/timeline/zoom-suggestions";
import { nativeBridgeClient } from "@/native/client";
import { TransportBar } from "../TransportBar";
import type { VideoSource } from "../VirtualPreview";
import styles from "./EditorShellV4.module.css";

// The AI option's prompt — sent straight to the chat agent via the prompt-bus.
//
// ponytail: cuts ONLY, deliberately. It used to ask for zooms too ("smart
// zoom-ins on the moments where the cursor dwells… focused on the cursor's
// location"), and the model has no way to do that well: measured on a real 66s
// screencast, every trim it emitted landed strictly inside a true silence with a
// 0.06–0.33s margin and destroyed zero speech, while 7 of its 9 zoom focus points
// missed the actual cursor position in their own window — three of them by more
// than a third of the frame. It places zooms from what the transcript SAYS, not
// from where the pointer WAS. Asking for both in one breath bought misaimed zooms
// at the price of the cuts' credibility, and the cursor-driven wand next to it
// already does the zoom pass from the same telemetry, deterministically.
// Re-widen this when the model can be shown to read the track; the workbench
// scenario `real-wizard-enhance` is what would show it.
const AI_ENHANCE_PROMPT =
	"Cut the dead time in this recording: long pauses, silences, and idle stretches where nothing is being said or done. Keep the pacing tight and natural, and do not cut anything a viewer needs. Apply the edits directly to the timeline.";

type TimelineApi = ReturnType<typeof useTimeline>;

const ASSET_MIME = "application/x-axcut-asset";

type ToolId = "cut" | "comment" | "speed";

// "Nice" ruler steps, from a 20th of a second up to an hour. The one that gets
// used depends on the zoom (see rulerTicks), so the ladder has to cover both a
// 5-second span blown up across the panel and a two-hour recording.
const TICK_STEPS_SEC = [
	0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];
/** Smallest gap two ruler labels may sit at — the step grows until they clear it. */
const MIN_LABEL_GAP_PX = 76;
/** Unlabelled ticks drawn between two labelled ones. */
const MINOR_PER_MAJOR = 5;

// ── lane-pill screen geometry ───────────────────────────────────────
// A pill's width IS its duration — there is no minimum beyond the 1px the CSS
// keeps so a very short region doesn't vanish entirely. The floor used to be
// `max(1.5%, …)` of the whole timeline, a percentage and therefore a DURATION:
// on a 30-minute recording every region shorter than 27 s was drawn as if it
// lasted 27 s, at every zoom level, so agent-placed zooms and trims lied about
// what they covered and touching ones merged into one visual block.
//
// What a pill needs room FOR (two resize handles, a label) is a question about
// its width in PIXELS at the current zoom, which is what pillAffordance answers.
/** Grab-strip width of one resize handle — mirrors .lanePillHandle in the CSS. */
const PILL_HANDLE_PX = 6;
/** Clear body left between two inside-mounted handles. Under this the handles
 *  would meet (or overlap) and a "move" drag would silently become a resize —
 *  the point at which the pill flips to the compact geometry below. */
const PILL_MOVE_PX = 6;
/** Two handles + a grabbable body: the narrowest pill that can host its own
 *  chrome inside its box. */
const PILL_HANDLES_MIN_PX = PILL_HANDLE_PX * 2 + PILL_MOVE_PX;
/**
 * Compact pills keep BOTH affordances by moving the chrome outside the box:
 * handle | gap | «the pill» | gap | handle. The gaps belong to the move target
 * (the pill's ::after strip widens by exactly this much), so even a 1px pill
 * offers ~8px to grab for a move and 6px on each side to resize — at every zoom,
 * at every duration. Mirrors .lanePillCompact in the CSS.
 */
const PILL_MOVE_GAP_PX = 4;
/** Offset of an outside-mounted handle from the pill's edge. */
const PILL_HANDLE_OUT_PX = PILL_HANDLE_PX + PILL_MOVE_GAP_PX;
/** Icon (11px) + the pill's own padding (15px): below this, content is pure
 *  overflow — the lane's colour already says which kind it is, and the title
 *  attribute still gives the value on hover. */
const PILL_CONTENT_MIN_PX = 34;
/** Edge-snap radius while dragging a pill, in screen px. */
const PILL_SNAP_PX = 8;
// The size a newly created pill aims for (PILL_CREATE_PX) lives in
// timeline/newRegionDuration, because the keyboard shortcuts create regions too
// and they are handled in NewEditorShell, outside this component.
/** Visual separation between two clip cards. Taken off each clip's own width
 *  (see .tlClip) rather than inserted between them, so it cannot displace the
 *  clips that follow — which is what a flex `gap` did, once per junction. */
const CLIP_GUTTER_PX = 6;
/**
 * Shortest region a resize may leave behind — the storage grid itself (regions
 * are `Math.round`ed to whole ms, and coalesceRegionsForRuler's epsilon is 1 ms),
 * so nothing rounds away to a zero-length row. It replaced a flat 0.2 s floor,
 * which quietly refused the last 200 ms of every trim however far you zoomed in.
 * How SHORT a region can be is a data question; how PRECISELY you can aim at one
 * is the zoom's business, and the two were conflated.
 */
const MIN_REGION_SEC = 0.001;

/**
 * How a pill's chrome is laid out at its current on-screen size.
 *
 * `compact` — the box is too narrow to hold handles AND a draggable body, so the
 * handles mount outside it (see PILL_MOVE_GAP_PX). Nothing is lost: move and
 * resize both stay reachable at any width and any zoom, the pill just stops
 * containing its own controls.
 *
 * `pxPerSec <= 0` means the panel hasn't been measured yet (first paint, jsdom).
 * Assume roomy rather than reflowing every pill's chrome for one frame.
 */
export function pillAffordance(
	durSec: number,
	pxPerSec: number,
): { compact: boolean; roomForLabel: boolean } {
	const widthPx = pxPerSec > 0 ? durSec * pxPerSec : Number.POSITIVE_INFINITY;
	const compact = widthPx < PILL_HANDLES_MIN_PX;
	// `!compact &&` is load-bearing, not belt-and-braces: .lanePillCompact turns
	// overflow visible (it has to, its handles hang outside the box), so a compact
	// pill that rendered a label would spill it across the lane with nothing to
	// clip it. Today PILL_CONTENT_MIN_PX > PILL_HANDLES_MIN_PX makes that
	// impossible; this makes it impossible whatever those two numbers become.
	return { compact, roomForLabel: !compact && widthPx >= PILL_CONTENT_MIN_PX };
}

// Ruler tick label. Precision follows the step: whole seconds read as a clean
// M:SS, but once the ruler is zoomed past one tick per second the fraction is
// the only thing telling two labels apart.
function fmtTick(sec: number, stepSec: number): string {
	if (!Number.isFinite(sec) || sec < 0) sec = 0;
	const digits = stepSec < 0.5 ? 2 : stepSec < 1 ? 1 : 0;
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (h > 0) {
		const mm = String(m).padStart(2, "0");
		const ss = String(Math.floor(s)).padStart(2, "0");
		return `${h}:${mm}:${ss}`;
	}
	if (digits > 0) {
		const [whole, frac] = s.toFixed(digits).split(".");
		return `${m}:${whole.padStart(2, "0")}.${frac}`;
	}
	return `${m}:${String(Math.round(s)).padStart(2, "0")}`;
}

interface RulerTick {
	sec: number;
	major: boolean;
}

interface PlayheadOverlayProps {
	/** Full timeline length in seconds — the denominator for the playhead's percentage. */
	totalSec: number;
	/** Live scrub position, when a drag is in flight. Takes precedence over the store. */
	overrideTimeSec: number | null;
	canvasStyle: React.CSSProperties;
	onPointerDown: (e: ReactPointerEvent) => void;
	playheadRef?: React.MutableRefObject<HTMLDivElement | null>;
}

/**
 * The playhead reads `currentTimeSec` from the store ITSELF instead of taking it
 * as a prop from V4Timeline.
 *
 * It is the only animated element on the timeline — everything around it (clips,
 * waveforms, ruler, lane pills) is static during playback. Threading the playhead
 * position down as a prop meant V4Timeline (and, above it, NewEditorShell) had to
 * re-render on every one of the ~60 store writes per second that playback
 * produces, just to move this one line: React had to render and commit the whole
 * editor before the playhead's DOM node moved, and any frame where that took
 * longer than ~16 ms showed up as visible playhead stutter.
 *
 * Subscribing here instead keeps the per-frame re-render confined to these three
 * nodes. `memo` then stops the surrounding timeline's own re-renders (zoom/pan,
 * clip edits) from re-rendering it for no reason.
 */
const PlayheadOverlay = memo(function PlayheadOverlay({
	totalSec,
	overrideTimeSec,
	canvasStyle,
	onPointerDown,
	playheadRef,
}: PlayheadOverlayProps) {
	const storeTimeSec = useProjectStore((s) => s.currentTimeSec);
	const pct = ((overrideTimeSec ?? storeTimeSec) / totalSec) * 100;
	return (
		<div className={styles.tlPlayheadLayer} aria-hidden>
			<div className={styles.tlCanvas} style={canvasStyle}>
				<div ref={playheadRef} className={styles.tlPlayhead} style={{ left: `${pct}%` }}>
					<span
						className={styles.tlPlayheadHead}
						style={{ pointerEvents: "auto", cursor: "grab" }}
						onPointerDown={(e) => {
							e.stopPropagation();
							onPointerDown(e);
						}}
					/>
				</div>
			</div>
		</div>
	);
});

// Waveform preview bars inside a timeline clip. Derived from peaks data;
// asset only decode once. Renders nothing while decoding or if the source has
// no audio track, so the clip pill just shows its label until peaks arrive.
const ClipWaveform = memo(function ClipWaveform({
	videoUrl,
	assetDurationSec,
	sourceStartSec,
	sourceEndSec,
	gain,
}: {
	videoUrl: string | undefined;
	assetDurationSec: number | undefined;
	sourceStartSec: number;
	sourceEndSec: number;
	/** Linear output gain — `audioGainScalar(settings.audioGainDb)`, not the dB.
	 *  Passed in rather than read from the settings store here: this component is
	 *  memoised per clip, and subscribing each one to the document would re-render
	 *  every waveform on any edit at all. As a prop it busts the memo on a gain
	 *  change and on nothing else. */
	gain: number;
}) {
	// The duration is what tells `useAudioPeaks` whether this recording is small
	// enough to decode whole — the file's byte size does not, on compressed video.
	const peaks = useAudioPeaks(videoUrl, assetDurationSec);
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
			{bars.map((h, bi) => {
				// Gain is applied HERE and not inside the memo above, which scans the whole
				// asset's blocks: a slider drag fires one setLive per pointer move, so this
				// keeps a tick at `barCount` multiplies instead of re-folding the peaks.
				//
				// Clamped because `finish_audio` clamps: it does `(sample * trim).clamp(-1, 1)`
				// per sample, and this bar is `max|sample|` over its bucket. Gain is positive
				// and clamping is monotonic, so `clamp(max(|s|) * g)` IS the peak of the gained,
				// clipped signal — the bar is exact, not an impression. Without the clamp a
				// 0.5 peak at +12 dB computes `height: 199%` and is merely hidden by the clip's
				// `overflow`, which draws a signal the export will never write.
				//
				// The 8% floor is deliberately NOT scaled: it exists so an empty clip still
				// reads as a clip, and it is not amplitude.
				const amplitude = Math.min(1, h * gain);
				return (
					<span
						key={bi}
						style={{
							height: `${Math.max(8, Math.round(amplitude * 100))}%`,
							opacity: (0.5 + amplitude * 0.5).toFixed(2),
						}}
					/>
				);
			})}
		</div>
	);
});

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
	setCurrentTime,
	variant = "edit",
	onDropAsset,
	videoSources = [],
	playing,
	onTogglePlay,
	onPrevClip,
	onNextClip,
	onEditClip,
}: {
	tl: TimelineApi;
	setCurrentTime: (sec: number) => void;
	variant?: "edit" | "media";
	onDropAsset?: (assetId: string) => Promise<void>;
	videoSources?: VideoSource[];
	playing: boolean;
	onTogglePlay: () => void;
	onPrevClip: () => void;
	onNextClip: () => void;
	/** Opens the (now single, shell-level) EditClipModal for this clip —
	 * trim in/out and crop both live there per-clip. */
	onEditClip: (clip: AxcutClip) => void;
}) {
	const t = useScopedT("timeline");
	// The camera lane borrows the Layout pane's "No Webcam" wording when there is no
	// camera to grow, so the two surfaces say the same thing about the same project.
	const ts = useScopedT("settings");
	// Wheel zoom/pan listens on the whole pane (toolbar down through the nav bar),
	// not just the lanes — a user scrolling over the ruler or the hint labels
	// expects the same zoom/pan the lanes give, not silence.
	const panelRef = useRef<HTMLDivElement | null>(null);
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
	// On-screen width of one full (unzoomed) timeline, in px. The ruler needs it
	// to pick a tick step that reads at THIS panel size — a step that looks right
	// on a wide window crams into an unreadable smear on a narrow one.
	const [viewportWidthPx, setViewportWidthPx] = useState(0);
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

	const [autoEnhanceOpen, setAutoEnhanceOpen] = useState(false);
	const [autoBusy, setAutoBusy] = useState(false);
	// The AI cut pass reads the transcript, and the transcript is produced in the
	// background (see transcriptionStore). Until it is there, the entry says why
	// rather than handing the agent a prompt it cannot honour — the failure mode
	// that made this button the wrong first click for a new user.
	const transcriptGate = useTimelineTranscriptGate();
	const smartCutsBlocked = transcriptGate.state !== "ready";
	const smartCutsHint =
		transcriptGate.state === "pending"
			? t("toolbar.smartCutsWaiting")
			: transcriptGate.state === "ready"
				? t("toolbar.smartZoomsAndCutsHint")
				: transcriptGate.reason === "no-audio"
					? t("toolbar.smartCutsNoAudio")
					: transcriptGate.reason === "no-speech"
						? t("toolbar.smartCutsNoSpeech")
						: transcriptGate.reason === "failed"
							? t("toolbar.smartCutsFailed")
							: t("toolbar.smartCutsNeedsTranscript");

	const clips = tl.clips;
	// A camera-fullscreen region grows the webcam overlay, so on a project with no webcam
	// it renders nothing in the preview and nothing in the export. `addCameraFullscreen`
	// refuses to write one (see useTimeline) — this makes the control say so before it is
	// clicked instead of looking like it worked. Same question, same helper as the Layout
	// pane: is a camera attached anywhere on this timeline?
	const hasAnyCamera = useMemo(() => hasAnyClipWithCamera(tl.assets, clips), [tl.assets, clips]);
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

	// The visible fraction of the timeline, and what one second is worth on screen
	// at that zoom. Every screen-space rule below — ruler step, pill affordances,
	// snap radius — goes through this instead of being written as a fraction of
	// `total`, which is a duration in disguise and so scales with the recording.
	const navSpan = Math.max(0.02, nav.end - nav.start);
	const pxPerSec = viewportWidthPx / navSpan / total;
	// Publish the scale so the keyboard shortcuts (NewEditorShell) size a new
	// region exactly like the buttons below do — `nav` never leaves this
	// component, so without this they fall back to a flat default and a pill
	// created with `Z` comes out invisible on a long recording.
	useEffect(() => {
		setTimelineScale(pxPerSec);
	}, [pxPerSec]);

	// ── region lanes ────────────────────────────────────────────────
	// zoom/speed/annotation: one pill per row, never coalesced — each carries
	// distinct per-instance content (depth/focus, speed value, text) that two
	// touching-but-different regions must not silently merge into one.
	// Pills follow the universal merge rule (timelineMap): regions of the same kind whose
	// PROPERTIES are equal and whose spans touch render as ONE pill, however they came to be
	// adjacent. Different properties never merge (and cannot overlap — they repel on edit).
	// Trims obey the same rule with an empty property set, so they always merge.
	const annPills: LanePill[] = coalesceRegionsForRuler(tl.annotationRegions).map((p) => ({
		id: p.ids[0],
		kind: "annotation",
		start: p.start,
		end: p.end,
		label: t("toolbar.newAnnotation"),
		sourceIds: p.ids,
	}));
	const speedPills: LanePill[] = coalesceRegionsForRuler(tl.speedRegions).map((p) => ({
		id: p.ids[0],
		kind: "speed",
		start: p.start,
		end: p.end,
		label: `${(p.member as { speed?: number }).speed ?? 1.5}×`,
		sourceIds: p.ids,
	}));
	const cameraFullscreenPills: LanePill[] = coalesceRegionsForRuler(tl.cameraFullscreenRegions).map(
		(p) => ({
			id: p.ids[0],
			kind: "cameraFullscreen",
			start: p.start,
			end: p.end,
			label: "Full Camera",
			sourceIds: p.ids,
		}),
	);
	const zoomPills: LanePill[] = coalesceRegionsForRuler(tl.zoomRegions).map((p) => ({
		id: p.ids[0],
		kind: "zoom",
		start: p.start,
		end: p.end,
		// Matches RightPanelStack's effectiveZoomScale: a custom scale (from the
		// slider) overrides the depth preset; otherwise show the depth's actual
		// preset value, not a fabricated linear approximation of it.
		label: `${(p.member.customScale ?? ZOOM_DEPTH_SCALES[p.member.depth]).toFixed(2)}×`,
		sourceIds: p.ids,
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
		label: formatSec(g.end - g.start),
		sourceIds: g.ids,
	}));

	// Ruler ticks are chosen from what is actually ON SCREEN, not from the clip
	// length: the canvas is widened by 1/navSpan, so the same recording shows one
	// label per 30s zoomed out and one per tenth of a second zoomed in. The step
	// is the first "nice" one whose on-screen gap clears MIN_LABEL_GAP_PX, which
	// is why the labels never collide however narrow the panel gets.
	const rulerTicks = useMemo((): { step: number; ticks: RulerTick[] } => {
		if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return { step: 1, ticks: [] };
		const step =
			TICK_STEPS_SEC.find((s) => s * pxPerSec >= MIN_LABEL_GAP_PX) ??
			TICK_STEPS_SEC[TICK_STEPS_SEC.length - 1];
		const minor = step / MINOR_PER_MAJOR;
		// Emit the visible window only (plus a step of margin so a tick never pops
		// in at the edge): at a 50× zoom the full timeline would otherwise be
		// thousands of off-screen nodes re-rendered on every pan.
		const from = Math.max(0, nav.start * total - step);
		const to = Math.min(total, nav.end * total + step);
		const ticks: RulerTick[] = [];
		for (let i = Math.ceil(from / minor - 1e-6); i * minor <= to + 1e-6; i++) {
			ticks.push({ sec: i * minor, major: i % MINOR_PER_MAJOR === 0 });
		}
		return { step, ticks };
	}, [total, nav.start, nav.end, pxPerSec]);

	// Live scrub position. The store write behind it is rAF-throttled (see
	// seekToClientX), so this keeps the playhead and the timecode pinned to the
	// pointer for the frame the store hasn't caught up on yet. Handed down as an
	// override to the two components that read the playhead from the store.
	const [scrubbingTimeSec, setScrubbingTimeSec] = useState<number | null>(null);
	const rafSeekRef = useRef<number>(0);
	const pendingSeekTimeRef = useRef<number | null>(null);

	// ── interactions ────────────────────────────────────────────────
	const playheadElRef = useRef<HTMLDivElement | null>(null);

	// Seek timeline position from a clientX pointer position.
	const seekToClientX = useCallback(
		(clientX: number, isImmediate = false) => {
			// Measure the canvas (the zoomed timeline frame): (clientX - left)/width
			// is the fraction along the FULL timeline under the cursor, so it stays
			// correct under zoom/pan and is unaffected by padding or the scrollbar.
			const el = canvasRef.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
			const targetTime = pct * total;

			// Direct DOM playhead update (0ms latency, zero React re-render overhead)
			if (playheadElRef.current) {
				playheadElRef.current.style.left = `${pct * 100}%`;
			}

			// Optimistic local UI state update
			setScrubbingTimeSec(targetTime);
			pendingSeekTimeRef.current = targetTime;

			if (isImmediate) {
				if (rafSeekRef.current !== 0) {
					cancelAnimationFrame(rafSeekRef.current);
					rafSeekRef.current = 0;
				}
				setCurrentTime(targetTime);
				return;
			}

			// Throttled store update / D3D seek via rAF to avoid IPC flooding
			if (rafSeekRef.current === 0) {
				rafSeekRef.current = requestAnimationFrame(() => {
					rafSeekRef.current = 0;
					if (pendingSeekTimeRef.current !== null) {
						setCurrentTime(pendingSeekTimeRef.current);
					}
				});
			}
		},
		[setCurrentTime, total],
	);

	// Mousedown anywhere on the empty timeline (ruler, lanes background, or
	// the playhead head itself) seeks immediately AND arms a scrub drag —
	// a single pointerdown→pointermove→pointerup replaces the old
	// click-only seek, and doubles as the playhead's drag handle since
	// dragging from its exact position is the same math as dragging from
	// anywhere else. Also clears any region selection, closing the
	// selected-element settings pane (FloatingInspector) the way clicking
	// away from a selected element is expected to.
	const startScrub = useCallback(
		(e: ReactPointerEvent) => {
			if (e.button !== 0) return;
			// Media has no playhead rendered, so there is nothing to scrub. Guarded
			// here rather than at the three call sites: seeking an invisible cursor
			// would still move `currentTimeSec`, i.e. silently reposition the Edit
			// tab's preview from a screen that shows no time at all.
			if (!showLanes) return;
			const target = e.target as HTMLElement;
			if (target.closest("[data-clip-id]") || target.closest(`.${styles.lanePill}`)) return;
			tl.clearSelection();
			seekToClientX(e.clientX, true);
			// Sonde de fluidité (diagnostic) : marque la fenêtre de drag pour que les
			// intervalles rAF mesurés pendant le scrub soient comptés à part.
			setUiProbeScrubbing(true);
			const move = (ev: PointerEvent) => seekToClientX(ev.clientX);
			const up = () => {
				setUiProbeScrubbing(false);
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				if (rafSeekRef.current !== 0) {
					cancelAnimationFrame(rafSeekRef.current);
					rafSeekRef.current = 0;
				}
				if (pendingSeekTimeRef.current !== null) {
					setCurrentTime(pendingSeekTimeRef.current);
					pendingSeekTimeRef.current = null;
				}
				setScrubbingTimeSec(null);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[seekToClientX, tl, setCurrentTime, showLanes],
	);

	const [activePillDrag, setActivePillDrag] = useState<{
		id: string;
		kind: LanePill["kind"];
		start: number;
		end: number;
	} | null>(null);
	const activePillDragRef = useRef<{
		id: string;
		kind: LanePill["kind"];
		start: number;
		end: number;
	} | null>(null);

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
			// Snap targets: clip boundaries + timeline ends. Within PILL_SNAP_PX of
			// one on screen, an edge snaps and a vertical guide is shown.
			// The radius is in PIXELS: as a fraction of total (it was 1.2%) it was a
			// 21-second magnet on a 30-minute project, so a pill dragged anywhere near
			// a junction jumped to it however far you zoomed in to place it precisely.
			const snapTargets = [
				0,
				total,
				...clips.map((c) => c.timelineStartSec),
				...clips.map((c) => c.timelineEndSec),
			];
			// 0 = no snapping at all while the panel is unmeasured (first paint):
			// better to drop the edge exactly where it was released than to move it
			// by a radius computed from a width we do not have.
			const snapThresh = pxPerSec > 0 ? PILL_SNAP_PX / pxPerSec : 0;
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
			const apply = async (start: number, end: number): Promise<void> => {
				const s = Math.max(0, Math.min(end - MIN_REGION_SEC, start));
				const en = Math.min(total, Math.max(s + MIN_REGION_SEC, end));
				if (pill.kind === "zoom") await tl.updateZoomSpan(pill.id, s * 1000, en * 1000);
				else if (pill.kind === "speed") await tl.updateSpeedSpan(pill.id, s * 1000, en * 1000);
				else if (pill.kind === "annotation")
					await tl.updateAnnotationSpan(pill.id, s * 1000, en * 1000);
				else if (pill.kind === "cameraFullscreen")
					await tl.updateCameraFullscreenSpan(pill.id, s * 1000, en * 1000);
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
					await tl.setTrimEntries(entries, dropIds);
				}
			};
			const move = (ev: PointerEvent) => {
				const dxSec = ((ev.clientX - startX) / r.width) * total;
				let ns = pill.start;
				let ne = pill.end;
				if (dragMode === "move") {
					ns = Math.max(0, Math.min(total - dur, snap(pill.start + dxSec)));
					ne = ns + dur;
				} else if (dragMode === "l") {
					ns = Math.max(0, Math.min(pill.end - MIN_REGION_SEC, snap(pill.start + dxSec)));
					ne = pill.end;
				} else {
					ns = pill.start;
					ne = Math.min(total, Math.max(pill.start + MIN_REGION_SEC, snap(pill.end + dxSec)));
				}
				const nextState = { id: pill.id, kind: pill.kind, start: ns, end: ne };
				activePillDragRef.current = nextState;
				setActivePillDrag(nextState);
			};
			const up = () => {
				setSnapPct(null);
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				const finalDrag = activePillDragRef.current;
				if (finalDrag) {
					void apply(finalDrag.start, finalDrag.end).finally(() => {
						if (activePillDragRef.current === finalDrag) {
							activePillDragRef.current = null;
							setActivePillDrag(null);
						}
					});
				} else {
					activePillDragRef.current = null;
					setActivePillDrag(null);
				}
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[tl, total, clips, pxPerSec],
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
	// around the cursor's timeline position. Shift is tested first, so it wins
	// when both are held: holding Shift always pans, never zooms.
	// Attached as a native (non-passive) listener rather than React's onWheel:
	// React marks wheel handlers passive by default, so e.preventDefault()
	// there silently no-ops and the browser/OS still intercepts Ctrl+wheel as
	// a page-zoom gesture.
	// Listens on the whole panel (ref below) so the ruler, the hint labels and
	// the nav bar all zoom/pan too — only .tlTracks scrolls natively, but the
	// gesture shouldn't be confined to wherever that scroll happens to live.
	// The rect stays tracksRef regardless of which descendant the wheel fired
	// on: ruler + tracks share one horizontal padding (see the width effect
	// below), so tracksRef reads the same left/width either way, and it's the
	// one guaranteed to exist whenever showLanes is true.
	useEffect(() => {
		const panel = panelRef.current;
		const tracks = tracksRef.current;
		if (!panel || !tracks) return;
		// Media shows no zoom window, so leave the wheel alone there: a zoom with
		// no control to undo it and no ruler reading to explain it is a trap.
		if (!showLanes) return;
		const onWheelNative = (e: WheelEvent) => {
			const r = tracks.getBoundingClientRect();
			const viewportPct = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
			if (e.shiftKey) {
				e.preventDefault();
				setNav((prev) => {
					const width = prev.end - prev.start;
					// Shift often routes the wheel onto deltaX; accept whichever axis moved.
					const wheelDelta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
					const delta = (wheelDelta / r.width) * width;
					const start = Math.max(0, Math.min(1 - width, prev.start + delta));
					return { start, end: start + width };
				});
			} else if (e.ctrlKey) {
				e.preventDefault();
				// A trackpad can deliver a horizontal swipe here, leaving deltaY at 0.
				// Read whichever axis moved, otherwise the sign test below always
				// reads "up" and the gesture only ever zooms in.
				const wheelDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
				if (wheelDelta === 0) return;
				setNav((prev) => {
					const width = prev.end - prev.start;
					const cursorFrac = prev.start + viewportPct * width;
					const zoomFactor = wheelDelta > 0 ? 1.12 : 1 / 1.12;
					const nextWidth = Math.min(1, Math.max(0.02, width * zoomFactor));
					const start = Math.max(0, Math.min(1 - nextWidth, cursorFrac - viewportPct * nextWidth));
					return { start, end: start + nextWidth };
				});
			}
			// Otherwise let the native vertical scroll of .tlTracks run (no preventDefault).
		};
		panel.addEventListener("wheel", onWheelNative, { passive: false });
		return () => panel.removeEventListener("wheel", onWheelNative);
	}, [showLanes]);

	// Track the tracks' content width for the ruler. .tlTracks and .tlRulerRow
	// carry the same horizontal padding and the tracks' scrollbar is hidden, so
	// this content box is exactly one unzoomed canvas wide.
	useEffect(() => {
		const el = tracksRef.current;
		if (!el) return;
		setViewportWidthPx(el.clientWidth);
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) setViewportWidthPx(entry.contentRect.width);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// zoom/pan: the tracks canvas is widened by 1/(navEnd-navStart) and shifted.
	// The width % resolves against the CONTAINER, the translate % against the
	// canvas's own (already widened) box — so scrolling to nav.start is a flat
	// -nav.start of the canvas. Scaling it by 1/navSpan as well double-counted
	// the zoom and threw the whole timeline off-screen at any nav.start > 0.
	const canvasStyle = {
		width: `${(100 / navSpan).toFixed(3)}%`,
		transform: `translateX(${(-nav.start * 100).toFixed(3)}%)`,
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
	// same document/timeline.ts#moveClip the agent's "moveClip" tool uses.
	// (That tool takes a neighbour's id rather than this index — the index is
	// relative to the array with the moved clip already removed, see below.)
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
			const shiftAmount = clipEl.getBoundingClientRect().width + CLIP_GUTTER_PX;

			// Boundaries are captured once, before any transform is applied —
			// re-querying live rects mid-drag would pick up the dragged clip's own
			// translated (pointer-following) position and corrupt the math, since
			// its rect no longer reflects its untouched slot.
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
	// (ported from main; NOT AI). Reads the recorded cursor movement and drops
	// zoom-ins on the dwell moments.
	//
	// Telemetry belongs to a RECORDING, not to a clip: it is fetched per asset and read in
	// that asset's source time. Projecting it onto the ruler is `buildAutoZoomSuggestionsForClips`'
	// job — every clip drawing on the asset gets its own zooms, including the second clip over
	// a recording already used once. Feeding the raw source-time spans to `addZoomsBulk` (which
	// reads RAW TIMELINE ms) is what confined every suggestion to the first clip's stretch of
	// ruler. Each asset with clips is asked, not just the first: a second recording on the
	// timeline was previously never consulted at all.
	const runAutoZooms = useCallback(async () => {
		setAutoEnhanceOpen(false);
		const sources = videoSources.filter((source) => clips.some((c) => c.assetId === source.id));
		if (sources.length === 0) {
			toast.error(t("toolbar.importRecordingFirst"));
			return;
		}
		setAutoBusy(true);
		try {
			// Read once, up front: every clip reserves against the zooms the document
			// ALREADY holds, and two clips can never contest the same stretch of ruler, so
			// nothing here depends on the order the assets are visited — which is what lets
			// their telemetry be fetched concurrently rather than one IPC round trip after
			// another. `Promise.all` preserves input order, so the suggestions come out in
			// the same sequence a loop would have produced.
			const existingRegions = tl.zoomRegions.map((z) => ({ startMs: z.startMs, endMs: z.endMs }));
			const perSource = await Promise.all(
				sources.map(async (source) => {
					const telemetry =
						(await nativeBridgeClient.cursor.getTelemetry(fromFileUrl(source.src))) ?? [];
					return buildAutoZoomSuggestionsForClips({
						cursorTelemetry: telemetry,
						assetId: source.id,
						clips,
						existingRegions,
						defaultDurationMs: 2000,
					});
				}),
			);
			const suggestions: AutoZoomSuggestion[] = perSource.flat();
			if (suggestions.length === 0) {
				toast.info(t("toolbar.noAutoZoomMoments"), {
					description: t("toolbar.noAutoZoomMomentsDescription"),
				});
				return;
			}
			const added = await tl.addZoomsBulk(suggestions);
			// A failed write returns 0 and has already toasted why. Without this the user
			// got "Added 0 automatic zooms" stacked on top of "Failed to save project",
			// with no zoom anywhere -- a success message for something that did not happen.
			if (added === 0) return;
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
	}, [videoSources, clips, tl, t]);

	// Auto-enhance option 2 — hand a generic prompt to the AI agent (smart
	// zooms + cuts) via the chat prompt-bus. The chat panel owns the outcome
	// toast: submitting is not the same as being accepted (no usable provider
	// bounces the prompt), and only the consumer knows which happened.
	const runAiEnhance = useCallback(() => {
		setAutoEnhanceOpen(false);
		useChatPromptBus.getState().submit(AI_ENHANCE_PROMPT);
	}, []);

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
		const durSec = seg.segEnd - seg.segStart;
		// The box is exactly as long as the effect is; only what fits INSIDE it
		// varies with the zoom.
		const { compact, roomForLabel } = pillAffordance(durSec, pxPerSec);
		return (
			<div
				key={seg.key}
				role={seg.interactive ? "button" : undefined}
				tabIndex={seg.interactive ? 0 : undefined}
				className={`${styles.lanePill} ${laneOf(p.kind)}${
					compact ? ` ${styles.lanePillCompact}` : ""
				}${seg.interactive && isPillSelected(p.id) ? ` ${styles.lanePillSel}` : ""}`}
				style={{
					left: `${pctOf(seg.segStart)}%`,
					width: `${pctOf(durSec)}%`,
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
						style={{ left: compact ? -PILL_HANDLE_OUT_PX : 0 }}
						onPointerDown={(e) => startPillDrag(e, p, "l")}
					/>
				) : null}
				{seg.showContent && roomForLabel ? (
					<>
						{pillIcon(p.kind)}
						<span className={styles.lanePillLabel}>{p.label}</span>
					</>
				) : null}
				{seg.interactive ? (
					<span
						className={styles.lanePillHandle}
						style={{ right: compact ? -PILL_HANDLE_OUT_PX : 0 }}
						onPointerDown={(e) => startPillDrag(e, p, "r")}
					/>
				) : null}
			</div>
		);
	};

	const renderPills = (pills: LanePill[], emptyLabel: string) => {
		const effectivePills = pills.map((p) => {
			if (activePillDrag && activePillDrag.id === p.id) {
				return { ...p, start: activePillDrag.start, end: activePillDrag.end };
			}
			return p;
		});
		return (
			<>
				{effectivePills.length === 0 ? (
					// The lane is as wide as the ZOOMED canvas, so centring the hint on it
					// would slide it off-screen as soon as the timeline is zoomed in. Span
					// the visible window instead, and the hint stays centred in view.
					<span
						className={styles.laneEmpty}
						style={{ left: `${nav.start * 100}%`, width: `${navSpan * 100}%` }}
					>
						{emptyLabel}
					</span>
				) : null}
				{effectivePills.flatMap((p) => {
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
							const differ = shifts.some(
								(s) => s.px !== first.px || s.immediate !== first.immediate,
							);
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
	};

	return (
		<div className={styles.tl} ref={panelRef}>
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
									<button
										type="button"
										className={styles.recMenuRow}
										onClick={runAiEnhance}
										disabled={smartCutsBlocked}
										title={transcriptGate.reason === "failed" ? transcriptGate.message : undefined}
										style={smartCutsBlocked ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
									>
										{transcriptGate.state === "pending" ? (
											<Loader2 size={15} className="animate-spin" style={{ flexShrink: 0 }} />
										) : (
											<Sparkles size={15} style={{ flexShrink: 0 }} />
										)}
										<span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
											<span style={{ fontWeight: 600 }}>{t("toolbar.smartZoomsAndCuts")}</span>
											<span style={{ fontSize: 11, color: "var(--muted)" }}>{smartCutsHint}</span>
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
									// Read at CLICK time: a render-time value would be one zoom
									// notch stale when the user zooms and immediately creates.
									const dur = newRegionDurationSec();
									if (tool.id === "speed") void tl.addSpeed(dur);
									if (tool.id === "comment") void tl.addAnnotation(dur);
									if (tool.id === "cut") void tl.addTrim(dur);
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
							onClick={() => void tl.addZoom(newRegionDurationSec())}
						>
							<ZoomIn size={15} />
						</button>
						<button
							type="button"
							className={styles.tlToolBtn}
							aria-pressed={settings.autoFocusAll}
							title={t(
								settings.autoFocusAll ? "buttons.autoFocusAllOn" : "buttons.autoFocusAllOff",
							)}
							aria-label={t(
								settings.autoFocusAll ? "buttons.autoFocusAllOn" : "buttons.autoFocusAllOff",
							)}
							onClick={() => void setSettings({ autoFocusAll: !settings.autoFocusAll })}
						>
							<Crosshair size={15} />
						</button>
						<button
							type="button"
							className={styles.tlToolBtn}
							title={t("buttons.addCameraFullscreen")}
							aria-label={t("buttons.addCameraFullscreen")}
							disabled={!hasAnyCamera}
							style={!hasAnyCamera ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
							onClick={() => void tl.addCameraFullscreen(newRegionDurationSec())}
						>
							<Maximize2 size={15} />
						</button>
					</div>
				) : (
					// Media is an ARRANGING surface: add, remove, reorder. Nothing here
					// plays or edits, so the transport, the scroll hints, the zoom nav and
					// the playhead are absent rather than inert — this caption is the whole
					// header, and it centres because it is alone in the row.
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 2,
							margin: "0 auto",
							textAlign: "center",
						}}
					>
						<span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--fg-2)" }}>
							{t("toolbar.arrangeClips")}
						</span>
						<span style={{ fontSize: 11.5, color: "var(--meta)" }}>
							{t("toolbar.arrangeClipsHint")}
						</span>
					</div>
				)}
				{showLanes ? (
					<>
						<TransportBar
							playing={playing}
							overrideTimeSec={scrubbingTimeSec}
							clips={clips}
							onTogglePlay={onTogglePlay}
							onPrevClip={onPrevClip}
							onNextClip={onNextClip}
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
					</>
				) : null}
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
							{rulerTicks.ticks.map((tick) => (
								<div
									key={tick.sec}
									className={`${styles.tlTick}${tick.major ? ` ${styles.tlTickMajor}` : ""}`}
									style={{ left: `${pctOf(tick.sec)}%` }}
								>
									{tick.major ? (
										<span className={styles.tlTickLabel}>{fmtTick(tick.sec, rulerTicks.step)}</span>
									) : null}
								</div>
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
								{/* An empty lane advertises the shortcut that fills it ("Press A to add
								    annotation") rather than restating that it is empty — the same hint
								    strings the pre-v4 timeline used, so the keys stay translated. */}
								<div className={styles.tlLane}>
									{renderPills(annPills, t("hints.pressAnnotation"))}
								</div>
								<div className={styles.tlLane}>
									{renderPills(speedPills, t("hints.pressSpeed"))}
								</div>
								<div className={styles.tlLane}>{renderPills(trimPills, t("hints.pressTrim"))}</div>
								<div className={styles.tlLane}>{renderPills(zoomPills, t("hints.pressZoom"))}</div>
								<div className={styles.tlLane}>
									{/* Advertising "Press C" on a project with no webcam invites a keystroke
									    that `addCameraFullscreen` now refuses (#353). The toolbar button is
									    already disabled; this keeps the lane from contradicting it. */}
									{renderPills(
										cameraFullscreenPills,
										hasAnyCamera ? t("hints.pressCameraFullscreen") : ts("layout.noWebcam"),
									)}
								</div>
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
								if (id && onDropAsset) void onDropAsset(id).catch(() => undefined);
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
										style={{
											left: `${pctOf(c.timelineStartSec)}%`,
											// Minus the gutter that separates two cards (it used to be the
											// flex row's `gap`). A clip shorter than the gutter lands on
											// .tlClip's 1px min-width instead of collapsing — same rule as
											// the lane pills above.
											width: `calc(${pctOf(dur)}% - ${CLIP_GUTTER_PX}px)`,
											transform: clipTransform,
										}}
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
											gain={audioGainScalar(settings.audioGainDb)}
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
			    continuous from the ruler down through the clips and its head aligns.
			    Edit only: there is no playback to follow on the Media surface. */}
				{showLanes ? (
					<PlayheadOverlay
						totalSec={total}
						overrideTimeSec={scrubbingTimeSec}
						canvasStyle={canvasStyle}
						onPointerDown={startScrub}
						playheadRef={playheadElRef}
					/>
				) : null}
			</div>

			{/* Zoom/pan window. Edit only: arranging clips needs the whole timeline
			    on screen at once, and there is nothing to zoom INTO without lanes. */}
			{showLanes ? (
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
			) : null}
		</div>
	);
}
