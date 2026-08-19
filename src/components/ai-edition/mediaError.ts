// What to do about an HTMLMediaElement `error` event in the preview.
//
// Split out of VirtualPreview's `onError` so the decision table is testable
// without a DOM. The absence of that table is issue #395: ANY error event, of
// any kind, was treated as "this asset is dead", and one such event collapsed
// the whole preview to the "add a video to get started" empty state for the
// rest of the session.
//
// MEDIA_ERR_ABORTED is the one we must never act on. It is what a *cancelled*
// load looks like, and the preview cancels loads as a matter of course: the
// <video> is keyed on `activeSource.id`, so every cross-asset clip boundary
// remounts it mid-fetch, and our own reload calls load() on an element that may
// still be loading. Counting those against a failure budget is how a healthy
// editor talks itself into an error screen.

export const MEDIA_ERROR_NAMES: Record<number, string> = {
	1: "MEDIA_ERR_ABORTED",
	2: "MEDIA_ERR_NETWORK",
	3: "MEDIA_ERR_DECODE",
	4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

/** Delayed rather than immediate: the failure we actually measured is a demuxer
 *  that could not keep up (see VirtualPreview's `applySourceTime`), and an
 *  instant re-read arrives while it is still saturated. */
export const RETRY_DELAYS_MS = [400, 1200] as const;

/** A recording that is still being written reports as "unsupported" too, so
 *  code 4 gets one cheap look before we believe the browser that the file is
 *  unusable. */
export const UNSUPPORTED_RETRY_BUDGET = 1;

/**
 * The budget is spent by reloads inside a SLIDING WINDOW, not over the lifetime
 * of the mounted media. That distinction is the whole design:
 *
 * - a genuinely dead file burns the budget in seconds (400 ms + 1200 ms of
 *   backoff and a moment of decode), so the user reaches the card almost at
 *   once, which is what they need;
 * - a healthy file hit by the occasional transient — the confirmed cause of
 *   #395 was our own seek storm, which recurs across an editing session and
 *   recovers every time — never accumulates, because the window empties between
 *   hiccups. A lifetime count could not tell those apart: it would show a card
 *   after enough ordinary editing, on media a 400 ms reload heals every time.
 *
 * A window also removes the need to "re-arm" anything on recovery, which is the
 * mechanism that kept getting this wrong: it expires by itself.
 */
export const RELOAD_WINDOW_MS = 30_000;

export interface MediaErrorDescription {
	code: number | null;
	name: string;
	message: string;
}

/** Typed structurally rather than as `MediaError` so this module carries no DOM
 *  dependency and its test can run in the default node environment. */
export function describeMediaError(
	error: { readonly code?: number; readonly message?: string } | null | undefined,
): MediaErrorDescription {
	const code = typeof error?.code === "number" ? error.code : null;
	return {
		code,
		name: (code !== null ? MEDIA_ERROR_NAMES[code] : undefined) ?? "MEDIA_ERR_UNKNOWN",
		message: error?.message ?? "",
	};
}

/** One line for the console and for the error card — the code is what makes a
 *  user's bug report actionable, since we cannot reproduce their decoder. */
export function formatMediaError(description: MediaErrorDescription): string {
	const label =
		description.code === null ? description.name : `${description.name} (${description.code})`;
	return description.message ? `${label} — ${description.message}` : label;
}

/** The reload timestamps still inside the window. The single definition of what
 *  "recent" means: the caller keeps the returned array and reads its length, so
 *  there is no second copy of this predicate to drift from. The caller owns the
 *  clock, which keeps this module pure and testable in the node environment. */
export function pruneReloads(timestamps: readonly number[], nowMs: number): number[] {
	return timestamps.filter((at) => nowMs - at < RELOAD_WINDOW_MS);
}

export type MediaErrorDisposition = "ignore" | "retry" | "fatal";

/**
 * `reloadsInWindow` counts only AUTOMATIC reloads: a user pressing Retry clears
 * the history, because they clicked knowing something changed.
 *
 * A null code (an error event carrying no MediaError) rides the full budget —
 * we know nothing, so we try.
 */
export function mediaErrorDisposition(
	code: number | null,
	reloadsInWindow: number,
	hasGivenUp = false,
): MediaErrorDisposition {
	if (code === 1) return "ignore";
	// Once the card is up, the window expiring must not quietly start the cycle
	// again: a dead file would reload every 30 s, flash back to a picture on the
	// metadata that always parses, and lose the card. Only Retry or a media
	// change lifts this.
	if (hasGivenUp) return "fatal";
	const budget = code === 4 ? UNSUPPORTED_RETRY_BUDGET : RETRY_DELAYS_MS.length;
	return reloadsInWindow < budget ? "retry" : "fatal";
}

export function retryDelayMs(reloadsInWindow: number): number {
	return RETRY_DELAYS_MS[Math.min(reloadsInWindow, RETRY_DELAYS_MS.length - 1)];
}
