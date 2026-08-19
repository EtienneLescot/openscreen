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

/** Delayed rather than immediate: the likeliest transient causes are a file the
 *  capture process has not finished writing and a momentarily unreadable file
 *  (an antivirus pass, a Windows share lock). An instant re-read sees the same
 *  bytes and burns an attempt for nothing. */
export const RETRY_DELAYS_MS = [400, 1200] as const;

/** A recording that is still being written reports as "unsupported" too, so
 *  code 4 gets one cheap look before we believe the browser that the file is
 *  unusable. */
export const UNSUPPORTED_RETRY_BUDGET = 1;

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

/**
 * Hard ceiling on reloads for one mounted media, whatever the budget says.
 *
 * The budget is re-armed by playback getting past the point it died at, which
 * is a heuristic — and a file with two bad spots FURTHER APART than that margin
 * re-arms it on every cycle, because each failure looks like progress relative
 * to the other. Measured on a deliberately corrupted recording: failures at
 * 22.528 s and 22.997 s, 0.47 s apart, produced four reloads per episode
 * instead of two. This is the backstop that keeps the count finite whatever the
 * heuristic concludes. Reset only by a media change or the user's Retry.
 */
export const MAX_RELOADS_PER_MEDIA = RETRY_DELAYS_MS.length * 2;

export type MediaErrorDisposition = "ignore" | "retry" | "fatal";

/**
 * `attemptsSpent` is reset by a successful load, not by elapsed time: success is
 * the only honest evidence that the source recovered. A budget that only ever
 * counts up is issue #395 again with a longer fuse.
 *
 * A null code (an error event carrying no MediaError) rides the full budget —
 * we know nothing, so we try.
 */
export function mediaErrorDisposition(
	code: number | null,
	attemptsSpent: number,
	reloadsSpent = 0,
): MediaErrorDisposition {
	// Still ignored at the ceiling: a cancelled load says nothing about the
	// media, and making it terminal once the counter is high is how #395 would
	// come back through the side door.
	if (code === 1) return "ignore";
	if (reloadsSpent >= MAX_RELOADS_PER_MEDIA) return "fatal";
	const budget = code === 4 ? UNSUPPORTED_RETRY_BUDGET : RETRY_DELAYS_MS.length;
	return attemptsSpent < budget ? "retry" : "fatal";
}

export function retryDelayMs(attemptsSpent: number): number {
	return RETRY_DELAYS_MS[Math.min(attemptsSpent, RETRY_DELAYS_MS.length - 1)];
}
