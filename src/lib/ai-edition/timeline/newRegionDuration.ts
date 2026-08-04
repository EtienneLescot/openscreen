/**
 * How long a region should be when the USER creates one, so the pill they get is
 * always the same comfortable size on screen.
 *
 * A 30-minute recording has to fit the panel's width, so the default view is
 * heavily dezoomed — around 0.4 px per second. A fixed 2 s region is under a
 * pixel there: invisible, and hidden behind the very playhead it was created at.
 * What has to stay constant is the WIDTH; the duration is whatever that width is
 * worth at the current zoom, which is why it can be 95 s zoomed out and 2 s
 * zoomed in for the same gesture.
 *
 * (A flat 2 s only ever looked right because the old 1.5%-of-the-timeline
 * minimum pill width inflated it in the RENDERING — the lie removed in #233.)
 *
 * This lives outside the timeline component because BOTH ways of creating a
 * region must agree: the toolbar buttons in V4Timeline and the keyboard
 * shortcuts in NewEditorShell, which the empty lanes advertise ("Press Z to add
 * zoom") and which have no other access to the zoom — `nav` is local state
 * inside V4Timeline. Paths that are not a user placing a pill by hand (the
 * agent, auto-zooms) don't call this and keep useTimeline's flat default.
 */

/**
 * On-screen width a freshly created pill aims for: wide enough to READ, not just
 * to see. Measured in a browser, the width each label needs before the ellipsis
 * bites — icon + gap + text + padding — is "Full Camera" 93px, "Annotation"
 * 90px, "1.80×" 61px, "1.5×" 55px. 96 covers the longest with a couple of px to
 * spare; longer translations of those two still ellipsize, which is what the
 * ellipsis is for.
 *
 * The cost of a wide default is a long region: at full zoom-out on a 30-minute
 * recording (~0.42 px/s) one click creates about 3 min 45 s. That is the trade
 * the constant width implies — the duration is the variable, and the pill is
 * immediately draggable by either edge.
 */
export const PILL_CREATE_PX = 96;
/** Floor on the duration. Only bites past ~30x zoom, where 40px is worth a few
 *  hundredths of a second and the region would be born unusable. */
export const PILL_CREATE_MIN_SEC = 0.25;

/**
 * The timeline's current scale, in px per timeline-second.
 *
 * Module state, written by the one timeline that exists and read IMPERATIVELY at
 * the instant a region is created — deliberately not a store subscription. The
 * value changes on every zoom notch and nothing renders it, so subscribing would
 * re-render the whole editor shell for a number only a click ever reads. Same
 * reasoning as `playheadSec()` in useTimeline.
 */
let pxPerSec = 0;

export function setTimelineScale(value: number): void {
	pxPerSec = Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Duration to create a region with, or `undefined` while the timeline has not
 * been measured yet (first paint, or no timeline mounted) — callers then fall
 * back to their own default rather than inventing a length from a width of zero.
 */
export function newRegionDurationSec(): number | undefined {
	return pxPerSec > 0 ? Math.max(PILL_CREATE_MIN_SEC, PILL_CREATE_PX / pxPerSec) : undefined;
}
