/**
 * The score, ported from the design's v4 cut.
 *
 * Time here is *scene seconds* — a clock that exists only on this page and runs
 * 0 → `T_TOTAL` as the reader scrolls the band. Every constant below is v4's,
 * kept to the number: the beat boundaries, the instants each click lands, where
 * each pill sits, and the two clocks' relationship.
 *
 * Nothing here touches the DOM and nothing reads a clock. The driver calls
 * `frameAt(p)` and applies the result, which is what lets the whole score be
 * checked by a test that never opens a browser.
 *
 * ── WHAT IS DERIVED AND WHAT IS STAGED ───────────────────────────────────────
 *
 * The editor's *chrome* is the application's: panel titles, every slider's
 * range, scaling and suffix, the wallpapers, and the cursor packs with their
 * real hotspots all come out of `generated.ts`, which the generator emits by
 * reading the app's locale files and source.
 *
 * The *session* is staged. The transcript below, the five trims, the three
 * zooms and the speed ramp are the design's scenario, not the vendored
 * project file — they are a demonstration of what the editor does, composed to
 * read in twenty-six seconds. An earlier cut drove this from the project
 * document; the document's own edit is two trims at the two ends of a
 * forty-second take, which is truthful and shows almost nothing. The page says
 * which is which rather than implying the whole thing is a recording.
 */

import { CONTROLS, CURSORS, EFFECTS } from "./generated";

export const T_TOTAL = 26.0;

/* ── the five beats ───────────────────────────────────────────────────────── */

/* The five beats tile [0, T_TOTAL] with no gaps, and that is a correctness
 * property, not tidiness. A frame that falls in a gap has no beat, the driver
 * has nothing to write to `data-beat`, and the stylesheet's `:not([data-beat])`
 * rule takes over — which is the RESTING frame, built for readers who will
 * never get the driver at all: the timeline in, the transcript panel open, the
 * scene at its closing values.
 *
 * So a gap does not show "nothing". It shows the end of the story. This opened
 * at [0, 0.6), which is the state of the stage on every approach to the band,
 * and the reader met the transcript panel before the background panel. There
 * were two more at [14.5, 15.0) and [19.5, 19.6), invisible only because the
 * panel happens to be faded out across both. */
export const BEATS = [
	{
		id: "style",
		from: 0,
		to: 7.2,
		kicker: "Style",
		title: "Swap the background",
		sub: "Image, color or gradient behind your recording — no re-shoot.",
	},
	{
		id: "effects",
		from: 7.2,
		to: 10.4,
		kicker: "Effects",
		title: "Frame it your way",
		sub: "Padding, motion blur, shadow, roundness — every effect composites live.",
	},
	{
		id: "cursor",
		from: 10.4,
		to: 15.0,
		kicker: "Cursor",
		title: "A cursor worth watching",
		sub: "Size, smoothing, motion blur, click bounce — every move reads on screen.",
	},
	{
		id: "timeline",
		from: 15.0,
		to: 19.6,
		kicker: "Timeline",
		/* Not "One click, one pill": the click this beat actually shows is the
		   wand's, and it places three zooms at once. The claim is the same one —
		   an edit is an object you can see — but counted the way the screen
		   counts it. */
		title: "One click, every zoom placed",
		sub: "Zooms, speed ramps, trims, comments — each edit lands as a pill on the timeline.",
	},
	{
		id: "transcript",
		from: 19.6,
		to: 26.0,
		kicker: "Transcript",
		title: "Edit video like text",
		sub: "Delete a word or a silence; the cut lands on the timeline. Nothing destructive.",
	},
] as const;

export type BeatId = (typeof BEATS)[number]["id"];

/** The floor arrives here — inside the cursor beat, so the acts change under a
 *  caption that is still up rather than across an empty stage. */
const TL_IN = 14.65;
/** When the interface arrives over the picture — the inspector and the captions
 *  together. They used to disagree: the caption turned on with its beat, which
 *  now opens the scene at 0, while the panel waited for this threshold, so the
 *  title faded up a fifth of a second of scroll before the panel it belongs to.
 *  One number, read by both. */
const UI_IN = 0.35;

/**
 * The inspector is up for every beat except the one the palette owns — the
 * timeline beat, read off the beat itself rather than copied.
 *
 * The copy said 14.45 where the beat starts at 15.0, and a caption belongs to
 * the panel it describes: for those 0.55s "A cursor worth watching" stood over
 * a toolbar with no cursor panel under it. One boundary, written once.
 */
const TL_BEAT = BEATS.find((b) => b.id === "timeline")!;
const PANEL_OFF = [TL_BEAT.from, TL_BEAT.to] as const;

/* ── the transcript ───────────────────────────────────────────────────────── */

export type Token = {
	text: string;
	silence?: boolean;
	cut?: number;
	label?: string;
	/** Tail words, revealed by viewport height. Only legal AFTER the last cut —
	 *  see the assertion below — so hiding one can never move a struck word. */
	tier?: 2 | 3;
};

/** The staged take. Five entries are removable — three silences and two filler
 *  words — and each has an explicit strike time in `STRIKE_T`. */
export const TOKENS: Token[] = [
	...["Hey,", "so", "this", "is", "Fern", "—", "I", "want", "to", "walk", "you", "through"].map(
		(text) => ({ text }),
	),
	{ text: "[silence 0.5s]", silence: true, cut: 0.5, label: "0.5s" },
	{ text: "Um,", cut: 0.4, label: "0.4s" },
	...["pairing", "a", "soil", "sensor."].map((text) => ({ text })),
	...["This", "is", "the", "garden", "—", "every", "bed", "reports", "its", "own", "moisture."].map(
		(text) => ({ text }),
	),
	{ text: "[silence 0.6s]", silence: true, cut: 0.6, label: "0.6s" },
	...["Now", "the", "new", "probe,"].map((text) => ({ text })),
	{ text: "um,", cut: 0.3, label: "0.3s" },
	...["down", "in", "bed", "three."].map((text) => ({ text })),
	{ text: "[silence 0.5s]", silence: true, cut: 0.5, label: "0.5s" },

	/* Everything from here on is tail: it sits after the last cut, so hiding any
	   of it cannot move a struck word or a pointer target. Tier 2 and 3 are
	   revealed by viewport height, which is what the transcript window's own
	   height is derived from. */
	...["It", "shows", "up", "the", "second", "it", "handshakes."].map((text) => ({ text })),
	...[
		"No",
		"app",
		"store,",
		"no",
		"account",
		"—",
		"the",
		"probe",
		"talks",
		"to",
		"the",
		"laptop.",
	].map((text) => ({ text, tier: 2 as const })),
	...[
		"Whole",
		"thing",
		"took",
		"forty",
		"seconds,",
		"and",
		"I",
		"still",
		"have",
		"to",
		"cut",
		"the",
		"dead",
		"air",
		"out",
		"of",
		"it.",
	].map((text) => ({ text, tier: 3 as const })),
];

/** Indices into `TOKENS` of everything removable, in order. */
export const CUT_INDEX = TOKENS.reduce<number[]>((out, t, i) => {
	if (t.cut !== undefined) out.push(i);
	return out;
}, []);

/** When each removable entry is struck. Explicit rather than swept: the pointer
 *  has to arrive at that word on that frame, and a sweep cannot be aimed. */
const STRIKE_T = [20.05, 20.72, 21.25, 21.8, 22.3];

/* The one coupling in here that cannot be derived: STRIKE_T is positional, so
 * its k-th entry belongs to the k-th token carrying a `cut`. Everything else
 * about the transcript is re-derived from TOKENS — the indices, the pointer's
 * targets, the cut counter — so words can be added and removed freely. Change
 * the NUMBER or ORDER of cut-bearing tokens, though, and every strike after the
 * change lands on the wrong word at the wrong time, silently. Hence the check:
 * it costs one comparison at module load and turns that into a build failure. */
/* Tail words must never sit before a strike: text flows forward, so hiding a
 * word after the last cut cannot move anything above it — and hiding one before
 * a cut would move every struck word and every pointer target under it. */
{
	const lastCut = CUT_INDEX[CUT_INDEX.length - 1] ?? -1;
	const stray = TOKENS.findIndex((t, i) => t.tier !== undefined && i < lastCut);
	if (stray >= 0) {
		throw new Error(
			`recreation: tail token "${TOKENS[stray]?.text}" at ${stray} sits before the last cut at ` +
				`${lastCut} — hiding it would move a struck word.`,
		);
	}
}

if (CUT_INDEX.length !== STRIKE_T.length) {
	throw new Error(
		`recreation: ${CUT_INDEX.length} removable tokens but ${STRIKE_T.length} strike times — ` +
			"every strike after the mismatch would land on the wrong word.",
	);
}

export const strikeOf = (i: number) => {
	const k = CUT_INDEX.indexOf(i);
	return k < 0 ? Number.POSITIVE_INFINITY : (STRIKE_T[k] ?? Number.POSITIVE_INFINITY);
};

/* ── the floor ────────────────────────────────────────────────────────────── */

/** Pixels per second of footage. Every object on the rail is placed with it and
 *  the rail is translated by it, so the whole timeline is one transform. */
export const K = 90;
/**
 * How much of the take the rail shows, and why it is not a constant.
 *
 * K is pixels per second of footage. Held fixed, the window it opens is the
 * stage's width divided by it — sixteen seconds at 1440, and four at the width
 * of a phone. Four seconds is not a timeline; it is one pill at a time drifting
 * past, and it makes any portrait layout pointless before it is drawn.
 *
 * So the reference is the SPAN, not the scale: sixteen seconds, which is what
 * 1440px at K already gives, and the scale follows from the width. Capped at K
 * so nothing wider than the reference zooms in — a large display keeps showing
 * more of the take rather than the same amount, larger.
 */
export const RAIL_SECONDS = 1440 / K;
export const railScale = (stageWidth: number) => Math.min(K, stageWidth / RAIL_SECONDS);
/** The playhead's x, as a fraction of the stage. */
export const PLAYHEAD = 0.38;

/** The lane plan, in px from the top of the rail. */
export const LANES = {
	label: 20,
	tick: 22,
	annotation: 40,
	speed: 66,
	cut: 92,
	zoom: 118,
	laneH: 22,
	hint: 142,
	track: 150,
	trackH: 50,
} as const;

export const FLOOR_H = 210;

/** The two clips on the track. */
/* The join is 0.13s — about twelve pixels at 90px/s. The design leaves 0.4s,
   which is 36px of floor showing between two takes that are meant to read as
   consecutive on one track. */
export const CLIPS = [
	{ from: -9, to: 13.1, selected: true },
	{ from: 13.23, to: 42, selected: false },
] as const;

/** Three zooms, each with the scene time the wizard places it.
 *
 *  Two decimals, always: the app labels a zoom pill `scale.toFixed(2) + "×"`
 *  (V4Timeline.tsx), so "1.5×" and "2×" are strings it never renders — the same
 *  class of tell as a hand-typed cursor-size value. */
export const ZOOMS = [
	{ from: 12.6, to: 13.7, label: "1.50×", scale: 1.5, placedAt: 16.15, origin: "52% 58%" },
	{ from: 16.25, to: 17.15, label: "1.80×", scale: 1.8, placedAt: 16.35, origin: "52% 58%" },
	{ from: 17.6, to: 18.45, label: "2.00×", scale: 2, placedAt: 16.55, origin: "36% 30%" },
] as const;

/** The speed ramp, and the window over which the footage clock runs 2.2x. */
export const SPEED = { from: 18.6, to: 20.6, placedAt: 18.25, rate: 2.2, label: "2.2×" } as const;

/** Where each trim lands. Close enough to the playhead to be on screen at the
 *  moment its own word is struck — a cut that appears off screen is a cut the
 *  reader has to take on trust. */
const CUT_POS = [16.4, 17.3, 22.35, 23.15, 23.9];
/** The zoom window trims are pushed clear of, so nothing overlaps. */
const ZOOM_GUARD = { from: 20.9, to: 21.9 };

export type Placed = { label: string; from: number; to: number; placed: boolean };

/** The trim lane, resolved: sorted, spaced, and kept out from under the zoom. */
export function trims(t: number): Placed[] {
	const raw = CUT_INDEX.map((tokenIndex, k) => ({
		label: TOKENS[tokenIndex].label ?? "",
		at: CUT_POS[k] ?? 25.7,
		dur: TOKENS[tokenIndex].cut ?? 0.5,
		placed: t >= strikeOf(tokenIndex),
	})).sort((a, b) => a.at - b.at);

	const out: Placed[] = [];
	let lastEnd = Number.NEGATIVE_INFINITY;
	for (const c of raw) {
		let from = Math.max(c.at, lastEnd + 0.25);
		let to = from + c.dur;
		if (to > ZOOM_GUARD.from - 0.35 && from < ZOOM_GUARD.to + 0.35) {
			from = Math.max(ZOOM_GUARD.to + 0.4, lastEnd + 0.25);
			to = from + c.dur;
		}
		lastEnd = to;
		out.push({ label: c.label, from, to, placed: c.placed });
	}
	return out;
}

/* ── the footage ──────────────────────────────────────────────────────────── */

/**
 * The footage clock.
 *
 * It is not the scene clock. While the playhead crosses the speed region the
 * recording runs at 2.2x, and after it the footage is permanently 2.4s ahead —
 * which is exactly what a speed ramp does to everything downstream of it, and
 * the reason the picture and the rail cannot share one number.
 */
export const footageTime = (t: number) =>
	t < SPEED.from
		? t
		: t < SPEED.to
			? SPEED.from + (t - SPEED.from) * SPEED.rate
			: t + (SPEED.to - SPEED.from) * (SPEED.rate - 1);

/** Clicks in the recording, for the recorded pointer's bounce. */
const FOOTAGE_CLICKS = [8.2, 11.6, 15.1, 16.5, 17.9, 21.9, 23.8];
/** Clicks the reader makes on the editor, for the demonstration pointer's. */
const UI_CLICKS = [2.0, 3.95, 5.8, 7.95, 11.45, 12.55, 12.7, 16.08, 18.25, 20.05, 21.25, 22.3];

/**
 * Click bounce, at parity with the renderer's own `cursor.rs`: the press is a
 * half-sine down to 50% over the first 38% of the window, and the release a
 * sine back up through 132%. Without it a pointer that never flinches reads as
 * a sprite being dragged rather than something clicking.
 */
function bounce(t: number, win: number, clicks: number[]): number {
	let last = -1;
	for (const c of clicks) {
		if (c <= t) last = c;
		else break;
	}
	if (last < 0) return 1;
	const e = (t - last) / win;
	if (e >= 1) return 1;
	return e < 0.38
		? 1 - Math.sin((e / 0.38) * Math.PI) * 0.5
		: 1 + Math.sin(((e - 0.38) / 0.62) * Math.PI) * 0.32;
}

/**
 * The recorded pointer's path, on the footage clock.
 *
 * A keyframe is either a place in the frame — percentages, so no pixel is baked
 * in — or the NAME of something in it, matched against `[data-shot]` and
 * resolved by the driver against what that thing actually measures.
 *
 * The names are the point. Coordinates copied from the design describe the
 * design's frame, not ours: our padding comes off the vendored document, so the
 * recorded window sits somewhere else, and the pointer parked outside the very
 * window it had just clicked. A name cannot drift, because whatever moves the
 * window moves the answer with it.
 *
 * The wandering between clicks stays in coordinates. It is not aimed at
 * anything, so there is nothing for it to name.
 */
export type ShotKey =
	| readonly [at: number, x: number, y: number]
	| readonly [at: number, on: string, fx: number, fy: number];

export const SHOT_PATH: readonly ShotKey[] = [
	[0.8, 38, 60],
	[3.5, 52, 55],
	[6.4, 46, 50],
	/* The page's own call to action, which is what the take opens by pressing.
	   Named through the scroll: the page is at -6% here and at -62% when the
	   pointer comes back to this same spot at 21.9, so one coordinate cannot
	   mean the same thing twice. */
	[7.4, "cta", 0.5, 0.5],
	[8.9, "cta", 0.5, 0.5],
	[10.5, 52, 58],
	[11.2, 46, 64],
	[12.3, 46, 64],
	[13.8, 50, 60],
	[14.6, 44, 62],
	[15.5, 44, 62],
	/* The button it is about to press. */
	[15.9, "app-go", 0.5, 0.5],
	[16.9, "app-go", 0.5, 0.5],
	/* On the window's own title bar, a fifth of the way along it — where a hand
	   goes to move a window. Named, so the padding can move the window without
	   taking the pointer off it. */
	[17.4, "app-bar", 0.2, 0.5],
	[18.3, "app-bar", 0.2, 0.5],
	[19.2, 35, 68],
	[20.2, 58, 58],
	[21.3, 34.5, 49],
	[22.1, 34.5, 49],
	[23.0, 52, 44],
	[23.6, 20, 49],
	[24.1, 20, 49],
	[25.2, 46, 54],
	[26.8, 56, 48],
	[28.4, 48, 56],
];

const PAGE_PATH: number[][] = [
	[0, 0],
	[5.5, 0],
	[6.6, -6],
	[8.4, -6],
	[9.6, -26],
	[12.8, -26],
	[13.6, -40],
	[18.8, -40],
	[20.3, -62],
	[21.3, -62],
	[22.6, -30],
	[24.6, -8],
];

/* ── interpolation ────────────────────────────────────────────────────────── */

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

/** Smoothstep. Used only where a value is held at both ends — a ramp that
 *  starts and stops is the one place linear reads as mechanical. */
const ease = (v: number) => {
	const k = clamp01(v);
	return k * k * (3 - 2 * k);
};

/* ── sub-beat moments ─────────────────────────────────────────────────────── */

/** The three background picks, and the two cursor picks. */
const BG_PICKS = [2.0, 3.95, 5.8];
const CURSOR_PICKS = [11.45, 12.55];
/** Which pack each pick selects, as an index into `CURSORS.themes`: the default
 *  arrow, then the pink one, then the green.
 *
 *  The order is the page's, not the take's. Green is the site's accent, and the
 *  pack chosen last is the one the recorded pointer wears for the eleven seconds
 *  of timeline and transcript that follow — so the take ends on it and the pink
 *  is spent early, while the panel it is being picked in is still the subject.
 *
 *  Exported because the pointer has to be on the swatch whose pack the frame
 *  selects, and the path in `driver.ts` reads this rather than repeating it. */
export const CURSOR_CHOICE = [0, 1, 2];

export const WALLPAPER_COUNT_SHOWN = 12;

/* ── the frame ────────────────────────────────────────────────────────────── */

export interface Frame {
	t: number;
	beat: BeatId | null;
	/** 0 before the floor arrives, 1 after. */
	tl: number;
	/** The footage clock, which the speed ramp pushes ahead of `t`. */
	tf: number;
	/** Which wallpaper is selected, 0-3. */
	bg: number;
	/** `paddingFit`, by the app's formula, and what the slider reads. */
	fit: number;
	padding: number;
	paddingPct: number;
	/** Uniform scale on the recorded window — v4 scales the frame rather than
	 *  insetting it, so the page's internal layout never reflows. */
	frameScale: number;
	/** The recorded app window's entrance, 0-1. */
	winVis: number;
	cursorSize: number;
	cursorSizePct: number;
	/** The size drag as 0-1, which is what the recorded cursor scales on. */
	cursorSizeU: number;
	/** Index into `CURSORS.themes` of the selected pack. */
	cursorTheme: number;
	zoom: number;
	zoomOrigin: string;
	zoomLabel: string;
	zoomActive: number;
	shotBounce: number;
	uiBounce: number;
	pageY: number;
	/** How many of the three zooms the wizard has placed, and whether the speed
	 *  region is down. */
	zoomsPlaced: number;
	speedPlaced: number;
	trims: Placed[];
	/** Index of the entry the pointer is striking, or -1. */
	strikeIndex: number;
	panel: number;
	/** The captions' gate, so they arrive with the inspector rather than before
	 *  it. A switch, not a ramp — the fade is the CSS transition under it. */
	intro: number;
	palette: number;
	wand: number;
	comment: number;
}

export function frameAt(p: number): Frame {
	const t = clamp01(p) * T_TOTAL;
	const tf = footageTime(t);

	const beat = BEATS.find((b) => t >= b.from && t < b.to)?.id ?? null;
	// A ramp, not a switch.
	//
	// This used to be 0/1 with a 0.75s CSS transition doing the easing, and that
	// is a scroll-driven value being animated by a clock that is not the scroll:
	// the floor chased a target it only reached long after `--tl` had settled, so
	// it sat ~16px below its own `bottom: 0` and cut the bottom off the clips.
	// Easing the value here instead means every rule that reads `--tl` — the
	// floor, the panel's top and height, the composite's box — moves together and
	// lands exactly.
	//
	// 1.5s, not 0.55s. The ramp is what the reader sees as the timeline sliding
	// up from the bottom, and 0.55s of a 26s scene is 2% of the band — about a
	// wheel notch, which arrives as a jump rather than as an entrance. At 1.5s
	// it takes just under 6% of the band, and because every rule that reads
	// --tl moves on it, the panel and the composite resize over the same
	// stretch instead of snapping ahead of the floor.
	const tl = ease(clamp01((t - TL_IN) / 1.5));

	const bg = BG_PICKS.reduce((n, at) => (t >= at ? n + 1 : n), 0);

	// Padding starts wide — the backgrounds have to be visible for the beat that
	// is about them — and comes down once, slowly, during the Effects beat.
	const padU = 1 - clamp01((t - 7.95) / 1.05);
	const padding = Math.round(30 + padU * 55);
	const fit = Math.min(
		1,
		Math.max(EFFECTS.paddingFitMin, 1 - (padding / 100) * EFFECTS.paddingFitFactor),
	);

	const sizeU = clamp01((t - 12.7) / 0.5);
	const cursorSize = 40 + sizeU * 23.2;

	const cursorTheme = CURSOR_CHOICE[CURSOR_PICKS.reduce((n, at) => (t >= at ? n + 1 : n), 0)] ?? 0;

	const live = ZOOMS.slice(1).find((z) => t >= z.from && t <= z.to);
	const zoomsPlaced = ZOOMS.filter((z) => t >= z.placedAt).length;

	const [pageY] = kf(tf, PAGE_PATH);

	const placedTrims = trims(t);

	const strikeIndex = CUT_INDEX.find((i) => t >= strikeOf(i) - 0.5 && t < strikeOf(i) + 0.35) ?? -1;

	const panelOn = t >= UI_IN && !(t >= PANEL_OFF[0] && t < PANEL_OFF[1]);
	/* The complement of the panel's window, not a second pair of numbers.
	   Written separately they were 14.75 to 19.45 against the panel's 14.45 to
	   19.60, which leaves 0.30s at the start and 0.15s at the end where neither
	   is up and the caption stands alone over an empty column. They are
	   alternatives: one hands over to the other, and the 0.45s fades overlap. */
	const paletteOn = t >= PANEL_OFF[0] && t < PANEL_OFF[1];

	return {
		t,
		beat,
		tl,
		tf,
		bg,
		fit,
		padding,
		paddingPct:
			((padding - CONTROLS.padding.min) / (CONTROLS.padding.max - CONTROLS.padding.min)) * 100,
		frameScale: 1 - padU * 0.36,
		/* The window opens and shuts on the footage clock, so it rides the speed
		   ramp with everything else in the recording. Here and not in the
		   stylesheet, because the pointer has to aim at a window this scales: it
		   is the third transform between a named target and the frame, after the
		   page's scroll and the padding. The `* 8` IS the ease — nothing may
		   transition on top of it. */
		winVis: Math.min(clamp01((tf - 15.25) * 8), clamp01((17.95 - tf) * 8)),
		cursorSize,
		cursorSizeU: sizeU,
		cursorSizePct:
			((cursorSize - CONTROLS.cursorSize.min) /
				(CONTROLS.cursorSize.max - CONTROLS.cursorSize.min)) *
			100,
		cursorTheme,
		zoom: live ? live.scale : 1,
		zoomOrigin: live ? live.origin : "52% 58%",
		zoomLabel: live ? live.label : ZOOMS[1].label,
		zoomActive: live ? 1 : 0,
		shotBounce: bounce(tf, 0.32, FOOTAGE_CLICKS),
		uiBounce: bounce(t, 0.42, UI_CLICKS),
		pageY,
		zoomsPlaced,
		speedPlaced: t >= SPEED.placedAt ? 1 : 0,
		trims: placedTrims,
		strikeIndex,
		panel: panelOn ? 1 : 0,
		intro: t >= UI_IN ? 1 : 0,
		palette: paletteOn ? 1 : 0,
		wand: t >= 15.0 && t < 17.0 && t >= 15.0 + (17.0 - 15.0) * 0.54 ? 1 : 0,
		comment: t >= 17.3 && t < 19.2 && t >= 17.3 + (19.2 - 17.3) * 0.5 ? 1 : 0,
	};
}

/** The pack the recorded pointer is currently drawn with. */
export const shotCursorSrc = (f: Frame) => CURSORS.themes[f.cursorTheme].src;
