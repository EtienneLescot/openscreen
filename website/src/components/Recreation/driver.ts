/**
 * Scroll in, custom properties out.
 *
 * The component renders once. This is the only thing that runs per frame, and
 * it writes nothing but CSS variables, one `data-beat` attribute, three text
 * nodes and — when the cue actually moves — two class changes. React is not in
 * the frame loop, and neither is layout: every value below lands on a property
 * the compositor or the style system already knows how to interpolate.
 *
 * Two rules keep it that way.
 *
 * Nothing here reads geometry. The one measurement the scene needs — how far
 * the band has scrolled — comes from a single `getBoundingClientRect` on the
 * band itself, inside the rAF callback, which is the one place a read cannot
 * force a synchronous layout on a write that has not happened yet. Everything
 * else is a percentage of its own box, so a resize needs no recomputation at
 * all.
 *
 * Counts, not lists. Which pills have been placed is one number per lane; each
 * pill compares it against its own index in CSS. Fourteen objects appear over
 * the ride and not one of them costs a DOM write.
 */

import { type Frame, frameAt, WORDS_REMOVABLE } from "./scene";

export interface DriverRefs {
	band: HTMLElement;
	root: HTMLElement;
	padValue: HTMLElement;
	sizeValue: HTMLElement;
	zoomValue: HTMLElement;
	timeValue: HTMLElement;
	flow: HTMLElement;
}

export interface DriverClasses {
	cue: string;
	struck: string;
}

/** `formatSec`'s own shape — m:ss.d — for the transport readout. The generated
 *  strings prove the format; this is the same arithmetic for a moving number. */
function fmtSec(sec: number): string {
	const s = Math.max(0, sec);
	const m = Math.floor(s / 60);
	const rest = s - m * 60;
	return `${m}:${Math.floor(rest).toString().padStart(2, "0")}.${Math.floor((rest % 1) * 10)}`;
}

/**
 * The three the component re-checks on change. `position: sticky` is not among
 * them because support for it does not change while the page is open.
 */
export const SCENE_QUERIES = [
	"(min-width: 901px)",
	"(prefers-reduced-motion: reduce)",
	"(forced-colors: active)",
] as const;

/**
 * The scene is off below 901px, without `position: sticky`, under forced colours
 * and under a reduced-motion preference — the same four conditions the
 * stylesheet gates on, because a driver that runs while the stylesheet has
 * folded the band away would be animating variables nothing reads.
 */
export function sceneEnabled(): boolean {
	if (typeof window === "undefined") return false;
	try {
		const [wide, reduced, forced] = SCENE_QUERIES.map((q) => window.matchMedia(q).matches);
		return wide && !reduced && !forced && CSS.supports("position", "sticky");
	} catch {
		return false;
	}
}

/** Everything `apply` writes, so a driver that shuts down can hand the element
 *  back to the stylesheet's resting values rather than leaving it frozen at
 *  whatever frame it happened to stop on. */
const WRITTEN = [
	"--t",
	"--tl",
	"--doc",
	"--bg",
	"--fit",
	"--zoom",
	"--zoom-x",
	"--zoom-y",
	"--pad-pct",
	"--size-pct",
	"--cur-size",
	"--cur-sel",
	"--shot-x",
	"--shot-y",
	"--page-y",
	"--palette",
	"--wand",
	"--note-on",
	"--panel",
	"--zooms-placed",
	"--trims-placed",
	"--note-placed",
	"--flow-y",
];

export function attachDriver(refs: DriverRefs, cls: DriverClasses): () => void {
	if (!sceneEnabled()) {
		for (const name of WRITTEN) refs.root.style.removeProperty(name);
		delete refs.root.dataset.beat;
		return () => {
			// Nothing was attached, so there is nothing to detach.
		};
	}

	const { band, root, padValue, sizeValue, zoomValue, timeValue, flow } = refs;

	let raf = 0;
	let lastCue = -2;
	let lastBeat: string | null | undefined;
	let lastPad = "";
	let lastSize = "";
	let lastZoom = "";
	let lastTime = "";
	/** Every entry the document can remove, paired with its element. Two of the
	 *  three silences are struck over the ride; resolving them once here is what
	 *  keeps the per-frame work off the transcript's 106 nodes. */
	const removable = WORDS_REMOVABLE.map((w) => ({
		w,
		el: flow.querySelector<HTMLElement>(`[data-w="${w.i}"]`),
	})).filter((x) => x.el);

	/**
	 * Every entry's offset inside the flow, measured once.
	 *
	 * The cue moves about a hundred times over the ride, and reading `offsetTop`
	 * each time is a layout read interleaved with the variable writes above —
	 * the shape that turns a cheap frame into a forced synchronous reflow. The
	 * flow's own layout never changes (the panel has a fixed width and the text
	 * is static), so the only thing that can invalidate this is a late webfont,
	 * which is what the resize listener and the fonts promise below are for.
	 */
	const entries = Array.from(flow.querySelectorAll<HTMLElement>("[data-w]"));
	let offsets = new Map<string, number>();
	let mask = 0;
	const measure = () => {
		offsets = new Map(entries.map((el) => [el.dataset.w!, el.offsetTop]));
		mask = flow.parentElement?.clientHeight ?? 0;
	};
	measure();
	document.fonts?.ready.then(measure).catch(() => {
		// A font that never resolves leaves the first measurement standing, which
		// is the right answer for every fallback stack anyway.
	});

	const num = (name: string, value: number, dp = 4) =>
		root.style.setProperty(name, value.toFixed(dp));

	const apply = (f: Frame) => {
		num("--t", f.t, 3);
		num("--tl", f.tl);
		num("--doc", f.doc, 3);
		num("--bg", f.bg, 3);
		num("--fit", f.fit);
		num("--zoom", f.zoom, 4);
		num("--zoom-x", f.zoomX, 1);
		num("--zoom-y", f.zoomY, 1);
		num("--pad-pct", f.paddingPct, 2);
		num("--size-pct", f.cursorSizePct, 2);
		num("--cur-size", f.cursorSize, 2);
		num("--cur-sel", f.cursorSel, 0);
		num("--shot-x", f.shot[0], 2);
		num("--shot-y", f.shot[1], 2);
		num("--page-y", f.pageY, 2);
		num("--palette", f.paletteIn, 0);
		num("--wand", f.wandOn, 0);
		num("--note-on", f.noteOn, 0);
		num("--panel", f.panelIn, 0);
		num("--zooms-placed", f.zoomsPlaced, 0);
		num("--trims-placed", f.trimsPlaced, 0);
		num("--note-placed", f.notePlaced, 0);

		if (f.beat !== lastBeat) {
			lastBeat = f.beat;
			if (f.beat) root.dataset.beat = f.beat;
			else delete root.dataset.beat;
		}

		const pad = `${Math.round(f.padding)}%`;
		if (pad !== lastPad) {
			lastPad = pad;
			padValue.textContent = pad;
		}
		// One decimal and no suffix — RightPanes.tsx:1755 gives this slider
		// `decimals={1}` and no `suffix`, unlike every other slider on the panel.
		const size = f.cursorSize.toFixed(1);
		if (size !== lastSize) {
			lastSize = size;
			sizeValue.textContent = size;
		}
		const zoom = f.zoomLabel ?? "";
		if (zoom !== lastZoom) {
			lastZoom = zoom;
			// Emptying it rather than hiding it: the badge's own opacity is
			// already driven by --zoom, and a label left behind under a
			// transparent badge is a string a screen reader can still reach.
			zoomValue.textContent = zoom;
		}
		const time = fmtSec(f.doc);
		if (time !== lastTime) {
			lastTime = time;
			timeValue.textContent = time;
		}

		if (f.cue !== lastCue) {
			const prev = lastCue;
			lastCue = f.cue;
			if (prev >= 0) flow.querySelector(`[data-w="${prev}"]`)?.classList.remove(cls.cue);
			if (f.cue >= 0) {
				flow.querySelector(`[data-w="${f.cue}"]`)?.classList.add(cls.cue);
				// Keep the cue in the panel without scrolling the panel: the flow
				// is translated under a fixed mask, so this is a transform, not a
				// scroll, and it cannot fight the page's own scrolling.
				const top = offsets.get(String(f.cue));
				if (top !== undefined) num("--flow-y", -Math.max(0, top - mask * 0.45), 1);
			}
			for (const { w, el } of removable) {
				// `startSec`, matching `trimsPlaced` in the score: the silence is
				// struck as the playhead arrives at the dead air, and its trim lands
				// on the floor on the same frame.
				el!.classList.toggle(cls.struck, f.cue >= 0 && f.doc >= w.startSec);
			}
		}
	};

	const onScroll = () => {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			const rect = band.getBoundingClientRect();
			const travel = rect.height - window.innerHeight;
			// Off screen in either direction: hold the nearest end rather than
			// letting the scene run backwards past its own first frame.
			const p = travel > 0 ? -rect.top / travel : 0;
			apply(frameAt(p));
		});
	};

	const onResize = () => {
		measure();
		onScroll();
	};
	window.addEventListener("scroll", onScroll, { passive: true });
	window.addEventListener("resize", onResize);
	onScroll();

	return () => {
		window.removeEventListener("scroll", onScroll);
		window.removeEventListener("resize", onResize);
		if (raf) cancelAnimationFrame(raf);
	};
}
