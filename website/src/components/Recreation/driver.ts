/**
 * The recreation's ONE requestAnimationFrame loop.
 *
 * ── THE TWO CLOCKS ────────────────────────────────────────────────────────────
 *
 * This page has two clocks and they are never crossed. Grep for `MEDIA CLOCK`
 * and `SCROLL CLOCK` — every rule in the component is filed under one of them.
 *
 * MEDIA CLOCK — `video.currentTime`, mapped into the recording's own timebase.
 *   It owns, and is the ONLY source of:
 *     · the transport digits          (`0:17.5 / 0:40.0`)
 *     · the playhead's x and the transport rail's fill
 *     · the cue-word underline walking the transcript
 *     · the pointer drawn over the canvas from the recording's telemetry
 *     · the zoom lane's lift (t is inside zoomRanges[1])
 *     · the play/pause glyph
 *   Everything in that list is written by this file, on leaf nodes, by hand.
 *
 * SCROLL CLOCK — the CSS view-timeline `--os-cam`.
 *   It owns, and is the ONLY source of:
 *     · the camera (the `.world` transform)
 *     · the presence of the edit-history objects (the empty chat, the two
 *       messages, the trim pills, the applied line, the struck silences)
 *   Every one of those lives in `styles.module.css` as an `animation-timeline:
 *   --os-cam` declaration. This file contains no scroll read of any kind: no
 *   `scrollY`, no `getBoundingClientRect()` in the tick, no
 *   `--scroll-progress`. If you are adding one, you are crossing the clocks.
 *
 * ── WHY IT WRITES `element.style` AND NEVER A CUSTOM PROPERTY ────────────────
 *
 * The popular pattern — one rAF writing `--scroll-progress` on a container and
 * `calc()` reading it on the descendants — was measured against an identical
 * sweep at 211 ms of style recalc at 588 elements (624 ms at 5,210) versus
 * 8–9 ms for direct `element.style` writes, because an inherited custom
 * property invalidates every descendant. This file writes leaf nodes only, and
 * only when the value it would write has actually changed.
 *
 * ── WHY IT IS NOT A REACT HOOK ───────────────────────────────────────────────
 *
 * `useScrub.ts` calls `setProgress()` inside its own tick and its component
 * re-renders. Dropping 433 server-rendered nodes into that shape turns every
 * animation frame into a full reconciliation. Everything here goes through
 * refs; React renders the markup once and never again.
 *
 * ── AND IT NEVER SEEKS ───────────────────────────────────────────────────────
 *
 * The clip plays and loops. Scroll drives the camera, not the film. A
 * scroll-scrubbable rendition of this window measured 758,484 B for nine
 * seconds all-intra against 132,193 B for the ordinary-GOP one that ships.
 */

import { LOOP, PILLS, TRANSPORT, WORDS } from "./generated";

/* ── the recording's own numbers ─────────────────────────────────────────── */

/** The asset's duration; the denominator of every percentage below. */
const TOTAL_SEC = 40.033;

/** zoomRanges[1] — the region the loop was cut from, and the only one the
 *  playhead visits. Read from the document rather than typed. */
const ZOOM2 = PILLS.find((p) => p.lane === "zoom" && p.startSec === LOOP.startSec);

/* ── the pointer's telemetry ─────────────────────────────────────────────── */

/**
 * `recording-1786032000000.mp4.cursor.json`, samples 17500–24300 ms, remapped
 * into the 2.20× crop the clip was cut at (`LOOP.crop`: 872×490 at 524,295 of
 * 1920×1080, so the visible window is cx ∈ [0.2729, 0.7271], cy ∈ [0.2732,
 * 0.7269]) and stored as per-mille of that window, x then y, clamped to
 * [-200, 1200]. 205 samples at a uniform 33.33 ms — the recording's own frame
 * pitch, so no resampling was done and none is undone here.
 *
 * There are no clicks in this window (the recording's three are at 13.87,
 * 24.80 and 36.20 s) and no invisible samples, so no click bounce is drawn and
 * none is invented. 19 of the 205 fall outside the crop; the pointer is hidden
 * for those, which is what the app does with a pointer outside the framing.
 *
 * This is the page's one demonstration rather than assertion: band 01 claims
 * the pointer is recorded as data and restyled afterwards, and this is that
 * data, restyled, in DOM, over footage it was never burned into.
 */
const CURSOR_XY =
	"563,402,561,407,566,408,570,413,569,413,571,413,572,419,577,418,580,423,583,425,589,426,591," +
	"434,594,435,599,438,600,442,607,448,610,448,610,454,614,457,618,462,621,461,628,463,632,471," +
	"636,474,637,479,645,479,645,484,653,491,660,495,664,497,664,501,669,506,675,509,675,514,679," +
	"515,689,517,690,522,694,530,697,533,701,537,704,536,712,545,714,546,717,546,720,552,725,553," +
	"728,560,732,562,737,562,737,567,745,570,747,574,750,578,749,577,755,584,756,582,761,585,765," +
	"589,767,593,766,596,769,596,771,595,772,597,779,601,779,600,778,606,780,603,783,606,784,609," +
	"786,605,781,605,788,609,787,609,786,611,789,609,788,613,788,612,787,608,786,609,782,614,782," +
	"613,784,611,783,612,778,616,774,616,773,612,770,613,771,615,766,617,762,616,760,624,758,623," +
	"749,622,748,626,743,624,742,630,738,632,734,634,723,636,723,636,713,637,713,639,707,640,700," +
	"645,693,649,686,646,683,650,677,652,667,656,661,660,658,658,648,661,641,667,633,669,627,670," +
	"625,676,618,678,607,681,602,683,592,684,585,688,578,691,575,696,564,699,559,701,551,699,546," +
	"701,540,708,532,712,524,711,521,715,514,719,509,719,500,722,495,721,490,724,483,725,475,729," +
	"471,735,465,733,459,736,456,739,453,743,448,740,440,746,438,748,433,747,431,752,421,751,418," +
	"755,416,754,413,755,413,757,410,755,401,758,402,758,399,759,399,762,397,763,396,766,396,760," +
	"394,766,392,761,388,767,391,764,390,765,389,764,386,753,378,740,370,716,361,692,348,659,331," +
	"625,311,585,295,542,278,497,255,451,236,403,216,348,195,299,172,249,148,198,131,146,112,103," +
	"88,64,74,22,60,-11,46,-46,36,-73,28,-92,19,-108,18,-113,17,-116,15,-116,8,-123,7,-131,0,-141," +
	"-14,-155,-22,-165,-34,-187,-48,-200,-60,-200,-79,-200,-92,-200,-113,-200";

/** Parsed once, at module scope: 205 pairs → one flat Int16Array. */
const CURSOR = (() => {
	const parts = CURSOR_XY.split(",");
	const out = new Int16Array(parts.length);
	for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
	return out;
})();

/** 205 samples spanning 0 → 6.8 s of clip time. */
const CURSOR_LAST = CURSOR.length / 2 - 1;
const CURSOR_DT = LOOP.contentDurationSec / CURSOR_LAST;

/* ── formatting ──────────────────────────────────────────────────────────── */

/**
 * `splitRoundedTime` + `formatSec`, reproduced from
 * `src/lib/ai-edition/timeline/format.ts` because the transport's digits are
 * written every tenth of a second in the browser and the app's module cannot be
 * imported into a Docusaurus bundle. This is the file's ONE duplication of app
 * logic and it is checked below: `formatSec(LOOP.startSec)` must equal
 * `TRANSPORT.restCurrent`, which the generator produced by calling the real
 * function. If the app's format ever changes, this throws in development
 * instead of drifting.
 */
function formatSec(sec: number): string {
	const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
	let totalMinutes = Math.floor(safe / 60);
	let seconds = Math.round((safe % 60) * 10) / 10;
	if (seconds >= 60) {
		totalMinutes += 1;
		seconds = 0;
	}
	return `${totalMinutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/* ── the elements the loop writes ────────────────────────────────────────── */

export interface DriverRefs {
	/** Observed for intersection; nothing is fetched or run until it is near. */
	band: HTMLElement;
	video: HTMLVideoElement;
	/** The current-time half of `0:17.5 / 0:40.0`. */
	timeReadout: HTMLElement;
	/** `data-playing` is flipped on it; CSS shows one of its two glyphs. */
	transport: HTMLElement;
	/** The violet line down the floor. */
	playhead: HTMLElement;
	/** The filled part of the transport's rail; its knob rides its right edge. */
	scrubFill: HTMLElement;
	/** The pointer over the canvas. */
	cursor: HTMLElement;
	/** The zoom lane, lifted while `t` is inside zoomRanges[1]. */
	zoomLane: HTMLElement;
	/** The transcript paragraph; its `[data-w]` spans are read once. */
	flow: HTMLElement;
}

export interface DriverClasses {
	/** Applied to the one word whose span contains `t`. */
	cue: string;
	/** Applied to the zoom lane while it owns `t`. */
	lift: string;
}

/**
 * Attaches the loop. Returns a teardown that removes every listener, cancels
 * the frame, pauses the element and drops its `src`.
 *
 * Nothing is fetched before the band is within a viewport of the screen: the
 * `<video>` is server-rendered with `preload="none"` and NO source at all, so a
 * reader who never scrolls this far — and a reader with no JavaScript, forever
 * — gets the poster and zero video bytes.
 */
export function attachDriver(refs: DriverRefs, classes: DriverClasses): () => void {
	const { band, video, timeReadout, transport, playhead, scrubFill, cursor, zoomLane, flow } = refs;

	if (process.env.NODE_ENV !== "production" && formatSec(LOOP.startSec) !== TRANSPORT.restCurrent) {
		throw new Error(
			`Recreation: formatSec drifted from the app — got ${formatSec(LOOP.startSec)}, generated.ts says ${TRANSPORT.restCurrent}`,
		);
	}

	// A reader who has asked for stillness gets the still recreation: the camera
	// is already absent (every animation is declared inside
	// `prefers-reduced-motion: no-preference`), and the film must not start
	// either. The poster stays, and the transport keeps its rest reading.
	const quiet =
		typeof window !== "undefined" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (quiet) return () => {};

	// The word spans, read once. `data-w` is the index into WORDS, so the two
	// arrays are addressed by the same integer and nothing is looked up by text.
	const spans = Array.from(flow.querySelectorAll<HTMLElement>("[data-w]"));
	const wordEl: (HTMLElement | undefined)[] = [];
	for (const el of spans) wordEl[Number(el.dataset.w)] = el;

	// ── per-frame state: last value WRITTEN, so nothing is written twice ──
	let lastTenth = -1;
	let lastPctKey = "";
	let lastCue = -1;
	let lastCursorKey = "";
	let lastPlaying: boolean | null = null;
	let lastLift: boolean | null = null;

	let frame = 0;
	let near = false;

	/* ── MEDIA CLOCK ──────────────────────────────────────────────────────
	   One read of `video.currentTime`, then six writes, each guarded by the
	   value it last wrote. No scroll is read here and none may ever be. */
	const tick = () => {
		frame = requestAnimationFrame(tick);

		// `LOOP.timeMapping`: the clip is 7.000 s but only its first 6.8 s is
		// footage — the tail is a dissolve into, and a hold on, a copy of frame 0
		// that makes the wrap invisible. Without the clamp the last 0.2 s reports
		// a time (24.3 → 24.5 s) the footage never reaches, and the playhead walks
		// past the end of the picture it is supposed to be indexing.
		const clipT = Math.min(video.currentTime, LOOP.contentDurationSec);
		const t = LOOP.startSec + clipT;

		// 1. the transport digits — only when the tenth changes (~7 writes/second,
		//    not 60), because `textContent` on a mono readout is a layout.
		const tenth = Math.round(t * 10);
		if (tenth !== lastTenth) {
			lastTenth = tenth;
			timeReadout.textContent = formatSec(t);
		}

		// 2. the playhead and the transport rail — one percentage, two writes.
		const pct = ((t / TOTAL_SEC) * 100).toFixed(3);
		if (pct !== lastPctKey) {
			lastPctKey = pct;
			playhead.style.left = `${pct}%`;
			scrubFill.style.width = `${pct}%`;
		}

		// 3. the cue underline — moved between spans, roughly 22 times across the
		//    loop rather than 60 times a second.
		const cue = findWord(t, lastCue);
		if (cue !== lastCue) {
			if (lastCue >= 0) wordEl[lastCue]?.classList.remove(classes.cue);
			if (cue >= 0) wordEl[cue]?.classList.add(classes.cue);
			lastCue = cue;
		}

		// 4. the pointer — one transform on one element, from the telemetry.
		const ci = Math.max(0, Math.min(CURSOR_LAST, Math.round(clipT / CURSOR_DT)));
		const ux = CURSOR[ci * 2] / 1000;
		const uy = CURSOR[ci * 2 + 1] / 1000;
		const onScreen = ux >= 0 && ux <= 1 && uy >= 0 && uy <= 1;
		const cursorKey = onScreen ? `${ux},${uy}` : "";
		if (cursorKey !== lastCursorKey) {
			lastCursorKey = cursorKey;
			if (onScreen) {
				cursor.style.visibility = "visible";
				cursor.style.transform = `translate3d(${(ux * LOOP.width).toFixed(1)}px, ${(
					uy * LOOP.height
				).toFixed(1)}px, 0)`;
			} else {
				cursor.style.visibility = "hidden";
			}
		}

		// 5. the zoom lane's lift. It is information, not decoration: the lane is
		//    raised because it holds the region containing `t`. Before playback
		//    starts nothing owns `t`, and the lane is not raised.
		const lift = !!ZOOM2 && t >= ZOOM2.startSec && t < ZOOM2.endSec;
		if (lift !== lastLift) {
			lastLift = lift;
			zoomLane.classList.toggle(classes.lift, lift);
		}

		// 6. the play/pause glyph, from the element rather than from our intent —
		//    iOS in Low Power Mode refuses muted inline autoplay and the page
		//    cannot override it, so a transport that reported our intent would be
		//    lying on exactly the devices that refused.
		const playing = !video.paused && !video.ended;
		if (playing !== lastPlaying) {
			lastPlaying = playing;
			transport.dataset.playing = playing ? "true" : "false";
		}
	};

	/** The span containing `t`, searched from the last answer — the clock only
	 *  ever moves forward by a frame, or wraps to the start. */
	function findWord(t: number, from: number): number {
		if (from >= 0) {
			const w = WORDS[from];
			if (w && t >= w.startSec && t < w.endSec) return from;
			const next = WORDS[from + 1];
			if (next && t >= next.startSec && t < next.endSec) return from + 1;
		}
		let lo = 0;
		let hi = WORDS.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (t < WORDS[mid].startSec) hi = mid - 1;
			else if (t >= WORDS[mid].endSec) lo = mid + 1;
			else return mid;
		}
		return -1;
	}

	const start = () => {
		if (!video.src) {
			// Chosen once, when the file is first wanted. Not reactive: swapping
			// `src` mid-loop runs the resource-selection algorithm, which rewinds
			// to 0 and pauses without firing `pause`.
			video.src = window.matchMedia("(max-width: 1280px)").matches
				? LOOP.srcSmall
				: LOOP.src;
		}
		const attempt = video.play();
		if (attempt) attempt.catch(() => {});
		if (!frame) frame = requestAnimationFrame(tick);
	};

	const stop = () => {
		if (frame) {
			cancelAnimationFrame(frame);
			frame = 0;
		}
		video.pause();
	};

	// A viewport of margin on each side, the shape `useScrub.ts` already uses:
	// the clip has to be decodable by the time its first frame is wanted.
	// This is the file's only use of the observer, and it is not a scroll read —
	// it fires on visibility, not on position, and it drives nothing but
	// play/pause.
	let io: IntersectionObserver | null = null;
	if (typeof IntersectionObserver !== "undefined") {
		io = new IntersectionObserver(
			(entries) => {
				near = entries[0].isIntersecting;
				if (near) start();
				else stop();
			},
			{ rootMargin: "100% 0px" },
		);
		io.observe(band);
	} else {
		near = true;
		start();
	}

	// The document's visibility, not ours: a backgrounded tab throttles rAF to
	// once a second while the element keeps decoding, so the readouts would come
	// back a second stale and the pointer would jump.
	const onVisibility = () => {
		if (document.hidden) stop();
		else if (near) start();
	};
	document.addEventListener("visibilitychange", onVisibility);

	return () => {
		io?.disconnect();
		document.removeEventListener("visibilitychange", onVisibility);
		stop();
		video.removeAttribute("src");
		video.load();
	};
}
