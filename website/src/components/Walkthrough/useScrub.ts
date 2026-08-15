import { useEffect, useRef, useState } from "react";

/**
 * Scroll drives the picture.
 *
 * A band that has a scrub rendition gets taller than the viewport and pins its
 * figure, so scrolling through the band walks the clip frame by frame: the zoom
 * lands, the reply types itself, the render bar fills, all at the reader's own
 * pace and in either direction. Apple's product pages do the same thing per
 * section rather than as one pinned stage held across the page, which is also
 * what makes it degrade cleanly — take away two CSS rules and the band is an
 * ordinary picture beside an ordinary paragraph.
 *
 * Three things this does NOT do, each learned the expensive way:
 *
 * It does not scrub with `requestVideoFrameCallback`. That callback stops firing
 * whenever the element is not being composited, which is precisely the state you
 * would be trying to observe.
 *
 * It does not wait on `seeked` to pace itself. `seeked` fires at a p50 of 0.0 ms
 * — before any frame has been presented — so pacing on it means racing ahead of
 * the picture. The in-flight guard here is a plain boolean cleared by the same
 * event, used only to avoid queueing seeks, never to decide what is on screen.
 *
 * It does not touch the DOM on `scroll`. Every read happens once per animation
 * frame, and only while the band is on screen; a scroll listener that measures
 * layout is how a page that looks fine on a desktop turns to treacle on a phone.
 */

const ATTR = "data-os-scrub";

/** Set before first paint by the inline script in the section's <Head>, so the
 *  tall pinned layout is never a post-hydration reflow. */
export function useScrubEnabled(): boolean {
	const [on, setOn] = useState(false);
	useEffect(() => {
		// Narrow viewports are excluded on purpose, not by omission. A seek per
		// animation frame is the most expensive thing on the page, phones are where
		// it costs most and where the battery pays for it, and a pinned band on a
		// short screen leaves the copy nowhere to go. Below 901px the band is an
		// ordinary picture beside an ordinary paragraph, which is a fine thing to be.
		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const wide = window.matchMedia("(min-width: 901px)");
		const sync = () => {
			const ok = !motion.matches && wide.matches && CSS.supports("position", "sticky");
			document.documentElement.setAttribute(ATTR, ok ? "on" : "off");
			setOn(ok);
		};
		sync();
		motion.addEventListener("change", sync);
		wide.addEventListener("change", sync);
		return () => {
			motion.removeEventListener("change", sync);
			wide.removeEventListener("change", sync);
		};
	}, []);
	return on;
}

type Options = {
	/** The element whose scroll range maps to the clip. */
	band: React.RefObject<HTMLElement | null>;
	video: React.RefObject<HTMLVideoElement | null>;
	seconds: number;
	enabled: boolean;
};

export function useScrub({ band, video, seconds, enabled }: Options): {
	/** 0-1, for the progress rail. Updated on the same frame as the picture. */
	progress: number;
	/** True once enough of the clip has arrived to seek anywhere in it. */
	ready: boolean;
	/** True while the band's scroll range is on screen — the clip only mounts then. */
	near: boolean;
} {
	const [progress, setProgress] = useState(0);
	const [ready, setReady] = useState(false);
	const [near, setNear] = useState(false);
	const seeking = useRef(false);
	const shown = useRef(-1);

	useEffect(() => {
		const el = band.current;
		if (!enabled || !el || typeof IntersectionObserver === "undefined") return;
		// A viewport of margin on each side: the clip has to be decodable by the
		// time its first frame is asked for, and a 268 KB file on a slow link is
		// not instant. Nothing is fetched for a band the reader never reaches.
		const io = new IntersectionObserver((entries) => setNear(entries[0].isIntersecting), {
			rootMargin: "100% 0px",
		});
		io.observe(el);
		return () => io.disconnect();
	}, [band, enabled]);

	useEffect(() => {
		if (!enabled || !near) return;
		const el = band.current;
		if (!el) return;

		let frame = 0;
		const tick = () => {
			frame = requestAnimationFrame(tick);
			const rect = el.getBoundingClientRect();
			const travel = rect.height - window.innerHeight;
			if (travel <= 0) return;
			const p = Math.min(1, Math.max(0, -rect.top / travel));
			setProgress(p);

			const v = video.current;
			if (!v || !v.duration || seeking.current) return;
			// Quantised to the clip's own frames: without this every rAF asks for a
			// new sub-frame time, the decoder never finishes one seek before the
			// next arrives, and the picture lags the scroll by a growing margin.
			const target = Math.min(seconds - 0.001, p * seconds);
			const step = Math.round((target * v.duration) / seconds / (1 / 20));
			if (step === shown.current) return;
			shown.current = step;
			seeking.current = true;
			v.currentTime = target;
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [band, video, seconds, enabled, near]);

	useEffect(() => {
		const v = video.current;
		if (!v || !near) return;
		const done = () => {
			seeking.current = false;
		};
		const loaded = () => setReady(true);
		v.addEventListener("seeked", done);
		v.addEventListener("error", done);
		v.addEventListener("loadeddata", loaded);
		return () => {
			v.removeEventListener("seeked", done);
			v.removeEventListener("error", done);
			v.removeEventListener("loadeddata", loaded);
		};
	}, [video, near]);

	return { progress, ready, near };
}
