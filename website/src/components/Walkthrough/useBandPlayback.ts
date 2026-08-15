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
	/** Bumped by every play() call. Ownership alone cannot express "start again",
	 *  because the band asking is usually the band that already owns the element. */
	playToken: number;
	/** Bands that have played to the end, and now show their result frame. */
	playedIds: ReadonlySet<string>;
	/** Whether clips start on their own when scrolled to. */
	autoplay: boolean;
	setAutoplay: (on: boolean) => void;
	/** Turns autoplay off, cancels the dwell timers already counting down, and
	 *  gives up the element — so the control stops what is running, not only what
	 *  would have run next. */
	stopAutoplay: () => void;
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
	const [playToken, setPlayToken] = useState(0);
	const [playedIds, setPlayedIds] = useState<ReadonlySet<string>>(new Set());
	const [refusedIds, setRefusedIds] = useState<ReadonlySet<string>>(new Set());
	const [autoplay, setAutoplay] = useState(true);
	const [quiet, setQuiet] = useState(false);
	const [small, setSmall] = useState(false);

	const nodes = useRef(new Map<string, HTMLElement>());
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	// Set the moment the reader works the toggle. The environment supplies the
	// default; after that the choice is theirs and nothing may recompute it.
	const chosen = useRef(false);
	// Read inside the observer callback, and inside stopAutoplay — both of which
	// are created once and must not see a stale render's values.
	const state = useRef({ autoplay, activeId, refusedIds });
	state.current = { autoplay, activeId, refusedIds };

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

		// Two queries, two callbacks. Width decides which rendition to load and
		// nothing else; reading it in the same callback as the motion default is
		// what let a phone rotation, or a zoom past 200%, put autoplay back on
		// after the reader had turned it off.
		const syncMotion = () => {
			const q = motion.matches || thin;
			setQuiet(q);
			// An explicit choice outranks the default, but asking the OS for
			// stillness outranks the choice: it withdraws consent rather than
			// merely suggesting one. The toggle is still there to opt back in.
			if (q) chosen.current = false;
			if (!chosen.current) setAutoplay(!q);
		};
		const syncNarrow = () => setSmall(narrow.matches);
		syncMotion();
		syncNarrow();

		motion.addEventListener("change", syncMotion);
		narrow.addEventListener("change", syncNarrow);
		return () => {
			motion.removeEventListener("change", syncMotion);
			narrow.removeEventListener("change", syncNarrow);
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
					// `quiet` is not consulted here. It has already set the default
					// this gate reads, and consulting it twice made the toggle
					// unable to do anything at all for a reduced-motion reader.
					if (!state.current.autoplay) continue;
					// A band whose play() the browser actually refused has lost its
					// control; handing it the element again would leave the page
					// playing a clip with nothing beside it to stop.
					if (state.current.refusedIds.has(id)) continue;
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

	// Ownership is a claim on the element, not an instruction to start. Asking the
	// band that already holds it to play writes its own id back over itself, React
	// bails out of the render, and nothing downstream ever hears about it — which
	// is why the token exists and why every caller must go through here.
	const play = useCallback((id: string) => {
		setActiveId(id);
		setPlayToken((n) => n + 1);
	}, []);

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

	const chooseAutoplay = useCallback((on: boolean) => {
		chosen.current = true;
		setAutoplay(on);
	}, []);

	const stopAutoplay = useCallback(() => {
		chosen.current = true;
		setAutoplay(false);
		// Clearing the timers is the half that matters: a dwell scheduled a moment
		// before the click would otherwise mount a clip after the control already
		// reads off.
		for (const t of timers.current.values()) clearTimeout(t);
		timers.current.clear();
		// Marking it played first — the band it stops is a band the reader has seen
		// motion from, and releasing the element must not snap the picture back to
		// the opening frame.
		if (state.current.activeId) markPlayed(state.current.activeId);
		setActiveId(null);
	}, [markPlayed]);

	return {
		activeId,
		playToken,
		playedIds,
		autoplay,
		setAutoplay: chooseAutoplay,
		stopAutoplay,
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
