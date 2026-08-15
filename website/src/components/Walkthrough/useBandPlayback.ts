import { useCallback, useEffect, useRef, useState } from "react";

import useIsBrowser from "@docusaurus/useIsBrowser";

/**
 * One video element on the page, ever.
 *
 * Not a stylistic choice: two H.264 elements decoding at once measured
 * 120.9 -> 30.8 fps on Apple Silicon with hardware decode, which is the best
 * case any visitor gets. So instead of mounting a <video> per band and pausing
 * the ones offscreen, exactly one band at a time owns the element, and the
 * others are their own poster. `content-visibility` is not a lever here — a
 * video 8,000px offscreen under `content-visibility: auto` decoded at full
 * speed in testing, the same as the onscreen one.
 *
 * A band that has finished keeps showing its *last* frame rather than reverting
 * to its first, so scrolling back up shows outcomes: captions rendered, the file
 * saved. That is also exactly what a reduced-motion reader is shown from the
 * start, which is why the reduced experience is a designed one rather than a
 * page with the motion subtracted.
 */

const DWELL_MS = 400; // a fast scroll to the footer must not request five clips
const VISIBLE = 0.55;

export type BandPlayback = {
	/** The band that currently owns the single <video>, if any. */
	activeId: string | null;
	/** Bands that have played to the end, and now show their result frame. */
	playedIds: ReadonlySet<string>;
	/** Whether clips start on their own when scrolled to. */
	autoplay: boolean;
	setAutoplay: (on: boolean) => void;
	/** True once the browser has taken over — controls stay inert before that. */
	hydrated: boolean;
	/** True where motion is unwelcome: reduced motion, or a metered connection. */
	quiet: boolean;
	/** Narrow viewport, so the small renditions are the ones to load. */
	small: boolean;
	registerBand: (id: string) => (node: HTMLElement | null) => void;
	play: (id: string) => void;
	markPlayed: (id: string) => void;
	/** Set by a band whose play() was refused, so its control can stop lying. */
	markRefused: (id: string) => void;
	refusedIds: ReadonlySet<string>;
};

export function useBandPlayback(): BandPlayback {
	const hydrated = useIsBrowser();
	const [activeId, setActiveId] = useState<string | null>(null);
	const [playedIds, setPlayedIds] = useState<ReadonlySet<string>>(new Set());
	const [refusedIds, setRefusedIds] = useState<ReadonlySet<string>>(new Set());
	const [autoplay, setAutoplay] = useState(true);
	const [quiet, setQuiet] = useState(false);
	const [small, setSmall] = useState(false);

	const nodes = useRef(new Map<string, HTMLElement>());
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	// Read inside the observer callback, which is created once.
	const state = useRef({ autoplay, quiet });
	state.current = { autoplay, quiet };

	useEffect(() => {
		if (!hydrated) return;

		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const narrow = window.matchMedia("(max-width: 780px)");

		// `prefers-reduced-data` has no implementation to speak of and GitHub Pages
		// is static, so it cannot vary a response on the Save-Data header either.
		// This client-side probe is the only signal that exists; where it is absent
		// the default path is already the light one.
		const conn = (
			navigator as Navigator & {
				connection?: { saveData?: boolean; effectiveType?: string };
			}
		).connection;
		const thin = conn?.saveData === true || /^(slow-)?2g$/.test(conn?.effectiveType ?? "");

		const sync = () => {
			const q = motion.matches || thin;
			setQuiet(q);
			setAutoplay(!q);
			setSmall(narrow.matches);
		};
		sync();

		motion.addEventListener("change", sync);
		narrow.addEventListener("change", sync);
		return () => {
			motion.removeEventListener("change", sync);
			narrow.removeEventListener("change", sync);
		};
	}, [hydrated]);

	useEffect(() => {
		if (!hydrated) return;
		if (typeof IntersectionObserver === "undefined") return;

		const clearTimer = (id: string) => {
			const t = timers.current.get(id);
			if (t) {
				clearTimeout(t);
				timers.current.delete(id);
			}
		};

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = (entry.target as HTMLElement).dataset.bandId;
					if (!id) continue;
					if (!entry.isIntersecting) {
						clearTimer(id);
						continue;
					}
					if (!state.current.autoplay || state.current.quiet) continue;
					if (timers.current.has(id)) continue;
					timers.current.set(
						id,
						setTimeout(() => {
							timers.current.delete(id);
							setActiveId((current) => (current === id ? current : id));
						}, DWELL_MS),
					);
				}
			},
			{ threshold: VISIBLE },
		);

		for (const node of nodes.current.values()) observer.observe(node);
		const timersAtCleanup = timers.current;
		return () => {
			observer.disconnect();
			for (const t of timersAtCleanup.values()) clearTimeout(t);
			timersAtCleanup.clear();
		};
	}, [hydrated]);

	// One ref callback per band id, cached. Returning a fresh closure each render
	// makes React detach and re-attach every ref on every render, which empties
	// and refills the map the observer was set up from.
	const refCallbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
	const registerBand = useCallback((id: string) => {
		let cb = refCallbacks.current.get(id);
		if (!cb) {
			cb = (node: HTMLElement | null) => {
				if (node) nodes.current.set(id, node);
				else nodes.current.delete(id);
			};
			refCallbacks.current.set(id, cb);
		}
		return cb;
	}, []);

	const play = useCallback((id: string) => setActiveId(id), []);

	const markPlayed = useCallback((id: string) => {
		setPlayedIds((prev) => {
			if (prev.has(id)) return prev;
			const next = new Set(prev);
			next.add(id);
			return next;
		});
	}, []);

	const markRefused = useCallback((id: string) => {
		setActiveId((current) => (current === id ? null : current));
		setRefusedIds((prev) => {
			if (prev.has(id)) return prev;
			const next = new Set(prev);
			next.add(id);
			return next;
		});
	}, []);

	return {
		activeId,
		playedIds,
		autoplay,
		setAutoplay,
		hydrated,
		quiet,
		small,
		registerBand,
		play,
		markPlayed,
		markRefused,
		refusedIds,
	};
}
