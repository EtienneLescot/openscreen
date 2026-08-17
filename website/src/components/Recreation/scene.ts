/**
 * The score. One pure function of scroll position, and the constants that say
 * when each thing happens.
 *
 * Time here is *scene seconds* — a clock that exists only on this page and runs
 * from 0 to `T_TOTAL` as the reader scrolls the band. It is not the document's
 * clock. Where the two meet is `docTime()`, and they meet in exactly one place
 * on purpose: act one is a settings demonstration where the recording is not
 * playing at all, and act two is a ride down the real 40.033 s document.
 *
 * Nothing in this file touches the DOM, and nothing in it reads a clock. The
 * driver calls `frameAt(t)` and applies the result; that split is what lets the
 * whole score be checked by a test that never opens a browser.
 */

import { CONTROLS, EFFECTS, META, PILLS, STAGE, WORDS } from "./generated";

/* ── the two acts ─────────────────────────────────────────────────────────
 *
 * Act one holds three settings that need no timeline to make sense — you can
 * see a background swap, a padding change and a cursor resize in a still frame.
 * They are the three the composite can answer on its own, so the timeline stays
 * off stage and the picture gets the room instead.
 *
 * Act two holds the three that are only meaningful against a timeline: zooms
 * placed on it, a note pinned to it, and cuts that arrive on it when words
 * leave the transcript. The timeline slides in once, between the acts, and the
 * composite gives up the height it was borrowing.
 */

/**
 * The beats touch. There is no gap anywhere, and the last one runs to the end.
 *
 * Two earlier cuts got this wrong in the same way. A gap between beats is a
 * stretch with no caption, no panel and no palette — so what looks on paper
 * like breathing room between two claims is, on screen, the left half of the
 * viewport going empty while the composite sits there alone. It is invisible
 * when you scroll past it at speed and glaring the moment anyone stops in it,
 * which is exactly the kind of defect that survives a demo and fails a reader.
 *
 * Touching beats mean the panel never has to fade out and back in between
 * background, padding and cursor: it stays, and its contents swap, which is
 * what the app does when you click a different facet. The one place anything
 * really leaves is the act change, where the panel gives way to the tool
 * palette — and the timeline starts arriving before then (`TL_IN`), so even
 * that happens under a caption that is still up.
 */
export const BEATS = [
	{ id: "background", from: 0.6, to: 4.15 },
	{ id: "padding", from: 4.15, to: 7.5 },
	{ id: "cursor", from: 7.5, to: 11.0 },
	{ id: "autozoom", from: 11.0, to: 15.3 },
	{ id: "annotation", from: 15.3, to: 18.7 },
	{ id: "transcript", from: 18.7, to: 26.5 },
] as const;

export type BeatId = (typeof BEATS)[number]["id"];

export const T_TOTAL = 26.5;

/** Where the timeline arrives and the composite makes room. Deliberately inside
 *  the cursor beat rather than after it: the floor rising is the transition, and
 *  it should happen while there is still a caption on screen to watch it. */
const TL_IN = 10.2;

/** Act two's ride: scene seconds mapped onto the document's own 40.033 s, so
 *  the playhead, the pills under it and the transcript cue are three renderings
 *  of one number rather than three animations that happen to agree. */
const RIDE_FROM = 10.9;
const RIDE_TO = T_TOTAL;
const DOC_END = META.assetDurationSec;

/* ── sub-beat moments ─────────────────────────────────────────────────────
 * The instants inside a beat when a discrete thing happens — a click lands, a
 * selection moves. Each is the moment the pointer arrives, so the pointer path
 * below and these have to be read together.
 */
const T_BG_CLICK = 2.5;
const T_CUR_CLICK = 8.5;
const T_WAND_CLICK = 12.6;
const T_NOTE_CLICK = 16.4;

/** The swatch the document itself is set to, and the one the pointer moves to.
 *  `STAGE.wallpaper` is the document's — everything else on this page agrees
 *  with the project file, and the picture the reader starts on has to as well. */
export const WALLPAPER_FROM = wallpaperIndex(STAGE.wallpaper);
export const WALLPAPER_TO = 9;

function wallpaperIndex(path: string): number {
	const n = Number(/wallpaper(\d+)\.jpg$/.exec(path)?.[1]);
	// A document pointing at a colour or a gradient has no swatch to light up.
	// Falling back to the first one keeps the panel honest about that rather
	// than lighting up a swatch the document never chose.
	return Number.isInteger(n) ? n : 1;
}

/* ── the pointers ─────────────────────────────────────────────────────────
 *
 * There are two, because the app has two, and only one of them is scored here.
 *
 * The reader's pointer — the one clicking swatches and dragging sliders — has
 * no coordinates at all. It is a child of the control it is operating, so the
 * same CSS that places a knob places the hand on it, at every viewport width,
 * with nothing to keep in sync. An earlier cut animated it along a path in
 * percentages of the stage and had to be re-tuned every time a panel moved,
 * which is a whole class of "nearly on the control" bug that simply cannot
 * happen now. All the score decides is *which* control has the hand, and that
 * is the beat.
 *
 * The recorded pointer — the one inside the recording, drawn from the captured
 * telemetry, which is what the Cursor panel is actually restyling — does have a
 * path, because there is nothing in the DOM for it to be attached to.
 */

/** The recorded pointer, over the page being recorded. Percent of the screen
 *  inside the frame. */
const SHOT_PATH: number[][] = [
	[0, 34, 58],
	[3, 46, 40],
	[5.5, 45, 45],
	[8, 58, 50],
	[10.5, 60, 52],
	[15.2, 60, 52],
	[18, 52, 68],
	[22, 44, 60],
	[26.5, 40, 44],
];

/** How far the recorded page has been scrolled, as a percentage of its own
 *  height. The image is the whole page; this is the window onto it. */
const PAGE_PATH: number[][] = [
	[0, 0],
	[5.5, 0],
	[9.5, -18],
	[13.8, -18],
	[17, -34],
	[21, -34],
	[26.5, -46],
];

/* ── interpolation ────────────────────────────────────────────────────────── */

/** Piecewise-linear read of `[[t, ...values]]` at `t`, clamped at both ends. */
function kf(t: number, points: readonly number[][]): number[] {
	if (t <= points[0][0]) return points[0].slice(1);
	for (let i = 1; i < points.length; i++) {
		if (t <= points[i][0]) {
			const a = points[i - 1];
			const b = points[i];
			const k = (t - a[0]) / (b[0] - a[0]);
			return a.slice(1).map((v, j) => v + (b[j + 1] - v) * k);
		}
	}
	return points[points.length - 1].slice(1);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Smoothstep. Used only where a value is *held* at both ends — a ramp that
 *  starts and stops is the one place linear reads as mechanical. */
const ease = (v: number) => {
	const k = clamp01(v);
	return k * k * (3 - 2 * k);
};

/* ── the frame ────────────────────────────────────────────────────────────── */

export interface Frame {
	/** Scene seconds. */
	t: number;
	/** Which beat's caption and panel are up, or null between beats. */
	beat: BeatId | null;
	/** 0 in act one, 1 once the timeline has taken its place. */
	tl: number;
	/** Document seconds under the playhead. 0 for the whole of act one. */
	doc: number;
	/** Wallpaper cross-fade, 0 = the document's own, 1 = the one just picked. */
	bg: number;
	/** `paddingFit`, by the app's formula. Multiplies the whole content block. */
	fit: number;
	/** What the Padding slider reads, and where its knob sits on its own track.
	 *  The two differ for Size and not for Padding, which is exactly the trap:
	 *  Size runs 5–100, so value and track percentage are never the same number. */
	padding: number;
	paddingPct: number;
	/** Cursor size, as the Cursor panel's own number — `cursor.size * 10`. */
	cursorSize: number;
	cursorSizePct: number;
	/** 1 once the pointer has picked the second cursor style. */
	cursorSel: number;
	/** Composite magnification, and where it magnifies from. */
	zoom: number;
	zoomX: number;
	zoomY: number;
	/** The zoom pill currently under the playhead, if any — the badge quotes it. */
	zoomLabel: string | null;
	/** The recorded pointer, in percent of the screen inside the frame. */
	shot: [number, number];
	pageY: number;
	/** Index into `WORDS` of the cue — the entry under the playhead. -1 before
	 *  the transcript opens. */
	cue: number;
	/** How many of the document's pills have been placed, by lane. */
	zoomsPlaced: number;
	trimsPlaced: number;
	notePlaced: number;
	/** Tool-palette state. */
	paletteIn: number;
	wandOn: number;
	noteOn: number;
	/** Panel presence. */
	panelIn: number;
}

/** Where act two's annotation lands. Not in the document — the project holds no
 *  annotation regions, which is why its lane still shows the "Press A" hint —
 *  so it is placed at the playhead, which is what pressing A does. */
export const NOTE_AT = 19.6;
export const NOTE_LEN = 2.4;

const ZOOMS = PILLS.filter((p) => p.lane === "zoom");
const TRIMS = PILLS.filter((p) => p.lane === "trim");

/** The entries the document's own trims remove — two of its three silences.
 *  The driver resolves these to elements once, so striking them costs nothing
 *  per frame and the other 104 nodes are never touched. */
export const WORDS_REMOVABLE = WORDS.filter((w) => !w.kept);

/** The scene at scroll position `p` (0–1 through the band). */
export function frameAt(p: number): Frame {
	const t = clamp01(p) * T_TOTAL;

	const beat = BEATS.find((b) => t >= b.from && t < b.to)?.id ?? null;
	const q = (id: BeatId) => {
		const b = BEATS.find((x) => x.id === id)!;
		return clamp01((t - b.from) / (b.to - b.from));
	};

	const tl = ease((t - TL_IN) / 0.9);
	const doc = clamp01((t - RIDE_FROM) / (RIDE_TO - RIDE_FROM)) * DOC_END;

	/* Background — the swatch lights up and the picture behind the window
	   changes on the same frame, because in the app they are one event. */
	const bg = t >= T_BG_CLICK ? 1 : 0;

	/* Padding — a drag, so it rises and comes back rather than landing on a
	   number. The composite follows PreviewCanvas's own arithmetic. */
	const dragged = clamp01((q("padding") - 0.32) / 0.48);
	const triangle = beat === "padding" ? (dragged < 0.5 ? dragged * 2 : (1 - dragged) * 2) : 0;
	const padding = STAGE.padding + triangle * 40;
	const fit = Math.min(
		1,
		Math.max(
			EFFECTS.paddingFitMin,
			1 - (Math.min(100, Math.max(0, padding)) / 100) * EFFECTS.paddingFitFactor,
		),
	);

	/* Cursor — the style is picked, then the size is dragged up and left there,
	   which is why this one does not come back down. */
	const cursorSel = t >= T_CUR_CLICK ? 1 : 0;
	const sizeU = t < BEATS[2].from ? 0 : t >= BEATS[2].to ? 1 : ease((q("cursor") - 0.55) / 0.3);
	const cursorSize = CONTROLS.cursorSize.value + sizeU * 23;

	/* Zoom — driven by the document, not by the beat. The composite magnifies
	   while a zoom region is under the playhead and at that region's own scale,
	   so the picture cannot disagree with the pill that caused it. */
	const active = tl > 0.5 ? ZOOMS.find((z) => doc >= z.startSec && doc <= z.endSec) : undefined;
	const placedZooms = ZOOMS.filter((_, i) => t >= T_WAND_CLICK + 0.35 + i * 0.28).length;
	const live = active && placedZooms > 0 ? active : undefined;
	const zoomEdge = live
		? Math.min(ease((doc - live.startSec) / 0.5), ease((live.endSec - doc) / 0.5))
		: 0;
	const scale = live ? Number(live.label.replace("×", "")) : 1;
	const zoom = 1 + (scale - 1) * zoomEdge;

	/* Transcript — the cue is the entry the playhead is inside, which is what
	   the app highlights. Nothing sweeps on its own schedule. */
	const transcriptOpen = t >= BEATS[5].from;
	const cue = transcriptOpen ? WORDS.findIndex((w) => doc >= w.startSec && doc < w.endSec) : -1;
	// A trim lands when the playhead *reaches* the span it removes, which is the
	// same test the driver strikes the silence with — the pill and the
	// strike-through are one event rather than two that nearly agree.
	//
	// Reaches, not clears. This document's second trim runs 35.12–40.033, and
	// 40.033 is the end of the document: waiting for the playhead to clear it
	// puts the whole payoff of the beat — a silence struck, a cut appearing under
	// the playhead — on the last frame of the last scroll, where nobody sees it.
	const trimsPlaced = transcriptOpen ? TRIMS.filter((x) => doc >= x.startSec).length : 0;

	const [shotX, shotY] = kf(t, SHOT_PATH);
	const [pageY] = kf(t, PAGE_PATH);

	const paletteIn = beat === "autozoom" || beat === "annotation" ? 1 : 0;

	return {
		t,
		beat,
		tl,
		doc,
		bg,
		fit,
		padding,
		paddingPct:
			((padding - CONTROLS.padding.min) / (CONTROLS.padding.max - CONTROLS.padding.min)) * 100,
		cursorSize,
		cursorSizePct:
			((cursorSize - CONTROLS.cursorSize.min) /
				(CONTROLS.cursorSize.max - CONTROLS.cursorSize.min)) *
			100,
		cursorSel,
		zoom,
		zoomX: 60,
		zoomY: 52,
		zoomLabel: live && zoomEdge > 0.02 ? live.label : null,
		shot: [shotX, shotY],
		pageY,
		cue,
		zoomsPlaced: placedZooms,
		trimsPlaced,
		notePlaced: t >= T_NOTE_CLICK + 0.3 ? 1 : 0,
		paletteIn,
		wandOn: beat === "autozoom" && t >= T_WAND_CLICK ? 1 : 0,
		noteOn: beat === "annotation" && t >= T_NOTE_CLICK ? 1 : 0,
		panelIn:
			beat === "background" || beat === "padding" || beat === "cursor" || beat === "transcript"
				? 1
				: 0,
	};
}
