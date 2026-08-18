/**
 * Scroll in, custom properties out — plus one video seek and a handful of class
 * changes. This is the only thing that runs per frame.
 *
 * Three rules keep it cheap.
 *
 * **One write target.** Everything lands on custom properties on `.stage`, so a
 * frame is a few dozen string assignments and no layout. The rail's contents,
 * the pills and the ruler all have static positions; only the rail is
 * translated.
 *
 * **Geometry is read once per resize, never per frame.** The demonstration
 * pointer aims at real controls — a swatch, a slider's 48% mark, a word in the
 * transcript — so those have to be measured. They are measured on attach and on
 * resize into a cache keyed by `data-t`, and the per-frame code only
 * interpolates between cached numbers. A target that is display:none when the
 * cache is built keeps its last known position, which is exactly right: the
 * pointer is heading for a control the panel is about to show.
 *
 * **The video is seeked, never played.** `currentTime` is the footage clock.
 * Seeks are issued latest-wins — one in flight, the newest pending value kept —
 * which is the fastest cadence the decoder can hold without building a queue.
 */

import { CURSORS } from "./generated";
import { CUT_INDEX, type Frame, frameAt, strikeOf, T_TOTAL } from "./scene";

export interface DriverRefs {
	band: HTMLElement;
	root: HTMLElement;
	cam: HTMLVideoElement;
	padValue: HTMLElement;
	sizeValue: HTMLElement;
	timeValue: HTMLElement;
	cutsValue: HTMLElement;
	flow: HTMLElement;
}

export interface DriverClasses {
	struck: string;
	cue: string;
}

export const SCENE_QUERIES = [
	"(min-width: 901px)",
	"(prefers-reduced-motion: reduce)",
	"(forced-colors: active)",
] as const;

export function sceneEnabled(): boolean {
	if (typeof window === "undefined") return false;
	try {
		const [wide, reduced, forced] = SCENE_QUERIES.map((q) => window.matchMedia(q).matches);
		return wide && !reduced && !forced && CSS.supports("position", "sticky");
	} catch {
		return false;
	}
}

/** Everything `apply` writes, so a driver that shuts down hands the element back
 *  to the stylesheet's resting values rather than freezing mid-ride. */
const WRITTEN = [
	"--t",
	"--tf",
	"--tl",
	"--bg",
	"--fit",
	"--pad-pct",
	"--frame-scale",
	"--size-pct",
	"--cur-size",
	"--size-u",
	"--zoom",
	"--zoom-origin",
	"--zoom-active",
	"--shot-x",
	"--shot-y",
	"--shot-bounce",
	"--shot-cursor",
	"--shot-hx",
	"--shot-hy",
	"--page-y",
	"--ui-x",
	"--ui-y",
	"--ui-bounce",
	"--ui-on",
	"--ui-cursor",
	"--ui-hx",
	"--ui-hy",
	"--zooms-placed",
	"--speed-placed",
	"--panel",
	"--palette",
	"--wand",
	"--comment",
	"--flow-y",
	"--trim-0",
	"--trim-1",
	"--trim-2",
	"--trim-3",
	"--trim-4",
];

const fmtSec = (sec: number) => {
	const s = Math.max(0, sec);
	const m = Math.floor(s / 60);
	const r = s - m * 60;
	return `${m}:${Math.floor(r).toString().padStart(2, "0")}.${Math.floor((r % 1) * 10)}`;
};

/** Piecewise-linear read of `[[t, ...values]]`, clamped at both ends. */
function kf(t: number, pts: number[][]): number[] {
	if (t <= pts[0][0]) return pts[0].slice(1);
	for (let i = 1; i < pts.length; i++) {
		if (t <= pts[i][0]) {
			const a = pts[i - 1];
			const b = pts[i];
			const k = (t - a[0]) / (b[0] - a[0]);
			return a.slice(1).map((v, j) => v + (b[j + 1] - v) * k);
		}
	}
	return pts[pts.length - 1].slice(1);
}

/** Windows where the pointer is over something clickable, or over text. */
const HOVERS = [
	[1.45, 3.05],
	[3.4, 4.9],
	[5.25, 6.6],
	[7.55, 10.3],
	[11.0, 12.63],
	[12.7, 14.3],
	[15.05, 16.6],
	[17.5, 18.9],
	[19.7, 20.4],
	[20.95, 21.5],
	[22.05, 22.36],
];
const TEXTS = [
	[20.4, 20.95],
	[21.5, 22.0],
];
const inAny = (t: number, w: number[][]) => w.some(([a, b]) => t >= a && t < b);

export function attachDriver(refs: DriverRefs, cls: DriverClasses): () => void {
	if (!sceneEnabled()) {
		for (const name of WRITTEN) refs.root.style.removeProperty(name);
		delete refs.root.dataset.beat;
		return () => {
			// Nothing was attached, so there is nothing to detach.
		};
	}

	const { band, root, cam, padValue, sizeValue, timeValue, cutsValue, flow } = refs;
	let raf = 0;

	/* ── the target cache ─────────────────────────────────────────────────── */

	let targets = new Map<string, [number, number]>();
	const measureVisible = () => {
		const box = root.getBoundingClientRect();
		if (box.width <= 0) return;
		for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-t]"))) {
			// An element inside a hidden pane has no box; keep whatever it last
			// measured, because the pointer is on its way to it.
			if (el.offsetParent === null) continue;
			const r = el.getBoundingClientRect();
			if (r.width <= 0) continue;
			const name = el.dataset.t!;
			// Anchors along a slider track are stored as the track's own geometry,
			// so a percentage along it can be resolved without re-measuring.
			targets.set(name, [
				((r.left - box.left) / box.width) * 100,
				((r.top + r.height / 2 - box.top) / box.height) * 100,
			]);
			targets.set(`${name}:w`, [(r.width / box.width) * 100, (r.height / box.height) * 100]);
		}
	};

	/**
	 * Measure every target, including those inside a pane that is closed.
	 *
	 * Three of the four panes are `display: none` at any moment, and a closed
	 * pane's children have no box — so a single pass leaves the swatches, the
	 * sliders and the transcript's words at their fallback coordinates, and the
	 * pointer spends the whole ride a hundred pixels from everything it is
	 * meant to be clicking. That was the first defect this build shipped.
	 *
	 * Opening each pane in turn is also the only correct way to do it: the panes
	 * share one flow container, so showing them together would measure each one
	 * stacked below the others.
	 */
	const measure = () => {
		const had = root.dataset.beat;
		for (const beat of ["style", "effects", "cursor", "timeline", "transcript"]) {
			root.dataset.beat = beat;
			measureVisible();
		}
		if (had === undefined) delete root.dataset.beat;
		else root.dataset.beat = had;
	};

	const at = (name: string, fx = 20, fy = 45): [number, number] => {
		const p = targets.get(name);
		const w = targets.get(`${name}:w`);
		if (!p) return [fx, fy];
		// Centre by default; `along` handles the two sliders and the two words.
		return [p[0] + (w ? w[0] / 2 : 0), p[1]];
	};
	const along = (name: string, frac: number, fx = 20, fy = 45): [number, number] => {
		const p = targets.get(name);
		const w = targets.get(`${name}:w`);
		if (!p || !w) return [fx, fy];
		return [p[0] + w[0] * frac, p[1]];
	};

	/** v4's pointer score, rebuilt each frame from the cache — the cache is what
	 *  makes that free, and rebuilding is what lets a target that was hidden at
	 *  attach time be aimed at correctly once its pane opens. */
	const path = (): number[][] => {
		const pad = (pct: number) => along("padtrk", pct / 100);
		const sz = (pct: number) => along("sztrk", pct / 100);
		const tok = (i: number) => at(`tok-${i}`);
		const tokU = (i: number, ax: number) => along(`tok-${i}`, ax);
		return [
			[0.4, 58, 66],
			[1.45, ...at("th-1")],
			[3.05, ...at("th-1")],
			[3.4, ...at("th-2")],
			[4.9, ...at("th-2")],
			[5.25, ...at("th-3")],
			[6.6, ...at("th-3")],
			[7.55, ...pad(97)],
			[7.95, ...pad(97)],
			[9.0, ...pad(48)],
			[10.3, ...pad(48)],
			[11.0, ...at("cur-2")],
			[11.9, ...at("cur-2")],
			[12.15, ...at("cur-1")],
			[12.63, ...at("cur-1")],
			[12.7, ...sz(50)],
			[13.2, ...sz(79)],
			[14.3, ...sz(79)],
			[15.05, ...at("wand")],
			[16.6, ...at("wand")],
			[17.5, ...at("comment")],
			[18.9, ...at("comment")],
			[19.75, ...tok(12)],
			[20.35, ...tok(12)],
			[20.5, ...tokU(13, 1.02)],
			[20.699, ...tokU(13, 1.02)],
			[20.7, ...tokU(13, 0.02)],
			[20.85, ...tokU(13, 0.02)],
			[21.0, ...tok(30)],
			[21.45, ...tok(30)],
			[21.6, ...tokU(35, 1.02)],
			[21.799, ...tokU(35, 1.02)],
			[21.8, ...tokU(35, 0.02)],
			[21.95, ...tokU(35, 0.02)],
			[22.1, ...tok(39)],
			[22.36, ...tok(39)],
		];
	};

	/* ── the webcam ───────────────────────────────────────────────────────── */

	let camReady = false;
	let camPending: number | undefined;
	const camSrc = "/video/webcam.mp4";
	const primeCam = () => {
		if (cam.getAttribute("src")) return;
		cam.setAttribute("src", camSrc);
		cam.preload = "auto";
		cam.load();
	};
	const onCamLoaded = () => {
		camReady = true;
	};
	const onCamSeeked = () => {
		if (camPending !== undefined) {
			const q = camPending;
			camPending = undefined;
			try {
				cam.currentTime = q;
			} catch {
				// A seek past a not-yet-buffered range throws; the next frame retries.
			}
		}
	};
	cam.addEventListener("loadeddata", onCamLoaded);
	cam.addEventListener("seeked", onCamSeeked);
	const seekCam = (tf: number) => {
		if (!camReady || cam.readyState < 2) return;
		const dur = Number.isFinite(cam.duration) && cam.duration > 0 ? cam.duration : 10;
		const t = ((tf % dur) + dur) % dur;
		if (cam.seeking) camPending = t;
		else if (Math.abs((cam.currentTime || 0) - t) > 0.033) {
			try {
				cam.currentTime = t;
			} catch {
				// ignored — see above
			}
		}
	};

	/* ── the frame ────────────────────────────────────────────────────────── */

	let lastBeat: string | null | undefined;
	let lastPad = "";
	let lastSize = "";
	let lastTime = "";
	let lastCuts = "";
	let lastArt = "";
	let lastTheme = -1;
	const struck = new Set<number>();
	let trimEls: HTMLElement[] = [];

	const num = (n: string, v: number, dp = 4) => root.style.setProperty(n, v.toFixed(dp));

	const apply = (f: Frame) => {
		num("--t", f.t, 3);
		num("--tf", f.tf, 3);
		num("--tl", f.tl, 0);
		if (String(f.bg) !== root.dataset.bg) root.dataset.bg = String(f.bg);
		num("--fit", f.fit);
		num("--pad-pct", f.paddingPct, 2);
		num("--frame-scale", f.frameScale, 4);
		num("--size-pct", f.cursorSizePct, 2);
		num("--cur-size", f.cursorSize, 2);
		num("--size-u", f.cursorSizeU, 4);
		num("--zoom", f.zoom, 4);
		root.style.setProperty("--zoom-origin", f.zoomOrigin);
		num("--zoom-active", f.zoomActive, 0);
		num("--shot-x", f.shot[0], 2);
		num("--shot-y", f.shot[1], 2);
		num("--shot-bounce", f.shotBounce, 4);
		num("--page-y", f.pageY, 2);
		num("--ui-bounce", f.uiBounce, 4);
		num("--zooms-placed", f.zoomsPlaced, 0);
		num("--speed-placed", f.speedPlaced, 0);
		num("--panel", f.panel, 0);
		num("--palette", f.palette, 0);
		num("--wand", f.wand, 0);
		num("--comment", f.comment, 0);
		// Written onto the elements, not through a variable and a positional
		// selector — see the note in the stylesheet.
		if (!trimEls.length) trimEls = Array.from(root.querySelectorAll<HTMLElement>("[data-trim]"));
		f.trims.forEach((c, i) => {
			const el = trimEls[i];
			if (el) el.style.opacity = c.placed ? "1" : "0";
		});

		// The pointer inside the recording wears the pack the picker selected.
		if (f.cursorTheme !== lastTheme) {
			lastTheme = f.cursorTheme;
			root.dataset.curSel = String(f.cursorTheme);
			const theme = CURSORS.themes[f.cursorTheme];
			root.style.setProperty("--shot-cursor", `url(${theme.src})`);
			num("--shot-hx", theme.hotspotX * 100, 2);
			num("--shot-hy", theme.hotspotY * 100, 2);
		}

		// The reader's pointer: arrow, pointer over a control, caret over text.
		// The hotspot is the app's own, which is why the tip lands on the target
		// rather than near it.
		const art = inAny(f.t, TEXTS) ? "text" : inAny(f.t, HOVERS) ? "pointer" : "arrow";
		if (art !== lastArt) {
			lastArt = art;
			const sprite =
				art === "text" ? CURSORS.text : art === "pointer" ? CURSORS.pointer : CURSORS.themes[0];
			root.style.setProperty("--ui-cursor", `url(${sprite.src})`);
			num("--ui-hx", sprite.hotspotX * 100, 2);
			num("--ui-hy", sprite.hotspotY * 100, 2);
			root.dataset.cur = art;
		}

		const [ux, uy] = kf(Math.min(f.t, 22.36), path());
		num("--ui-x", ux, 2);
		num("--ui-y", uy, 2);
		num("--ui-on", f.t > 1.1 && f.t < 22.36 ? 1 : 0, 0);

		if (f.beat !== lastBeat) {
			lastBeat = f.beat;
			if (f.beat) root.dataset.beat = f.beat;
			else delete root.dataset.beat;
		}

		const pad = `${Math.round(f.padding)}%`;
		if (pad !== lastPad) padValue.textContent = lastPad = pad;
		// One decimal and no suffix: RightPanes gives this one slider `decimals={1}`
		// and no unit, unlike every other slider on the panel.
		const size = f.cursorSize.toFixed(1);
		if (size !== lastSize) sizeValue.textContent = lastSize = size;
		const time = fmtSec(f.tf);
		if (time !== lastTime) timeValue.textContent = lastTime = time;
		const cuts = f.cutCount ? `−${f.cutCount} · −${f.saved.toFixed(1)}s` : "";
		if (cuts !== lastCuts) cutsValue.textContent = lastCuts = cuts;

		// Only the five removable entries can ever change, so the other forty
		// nodes in the transcript are never touched.
		for (const i of CUT_INDEX) {
			const on = f.t >= strikeOf(i);
			if (on === struck.has(i)) continue;
			on ? struck.add(i) : struck.delete(i);
			flow.querySelector(`[data-w="${i}"]`)?.classList.toggle(cls.struck, on);
		}

		seekCam(f.tf);
	};

	/* ── the scroll ───────────────────────────────────────────────────────── */

	const onScroll = () => {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			const rect = band.getBoundingClientRect();
			const total = rect.height - window.innerHeight;
			// The ride overflows the sticky on purpose: the last stretch plays while
			// the section is already scrolling away, so the editor is not still
			// sitting pinned and finished for a whole viewport.
			const span = total + window.innerHeight * 1.04;
			const off = Math.min(span, Math.max(0, -rect.top));
			if (off > 0 && off < span) primeCam();
			apply(frameAt(span > 0 ? off / span : 0));
		});
	};

	const onResize = () => {
		measure();
		onScroll();
	};

	let detached = false;

	measure();
	// Targets inside a closed pane cannot be measured until it opens, and the
	// panes open on scroll — so re-measure once the fonts have settled, which is
	// also when the transcript's words stop moving.
	//
	// Guarded: the driver re-attaches whenever a SCENE_QUERIES breakpoint is
	// crossed, and by then `fonts.ready` is already resolved, so an unguarded
	// `.then` runs a second full measuring pass — five panes opened and closed —
	// for a driver that has since been thrown away.
	document.fonts?.ready
		.then(() => {
			if (!detached) measure();
		})
		.catch(() => {
			// A font that never resolves leaves the first measurement standing.
		});
	window.addEventListener("scroll", onScroll, { passive: true });
	window.addEventListener("resize", onResize);
	onScroll();

	return () => {
		detached = true;
		window.removeEventListener("scroll", onScroll);
		window.removeEventListener("resize", onResize);
		// The video outlives the driver — it is the same element on re-attach —
		// so listeners left on it accumulate one pair per breakpoint crossing,
		// each holding a dead driver's closure alive.
		cam.removeEventListener("loadeddata", onCamLoaded);
		cam.removeEventListener("seeked", onCamSeeked);
		if (raf) cancelAnimationFrame(raf);
	};
}

export { T_TOTAL };
