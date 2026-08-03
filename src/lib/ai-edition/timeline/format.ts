// Timeline timecodes. Two shapes, one home — this used to be six near-identical
// private copies spread across Modals, V4Timeline, MediaStage, operations and
// virtual-preview.
//
// `formatSeconds` shows the hour field only when there is one; `formatSec`
// never does (timeline pills and region readouts are always sub-hour and the
// leading "0:" is noise there).
//
// Not covered here, deliberately: ExportDialog's `formatHms` (hh:mm:ss, always
// padded hours, no tenths) and timeUtils' `formatTimePadded` (mm:ss) are
// different formats, not copies of these.

function splitRoundedTime(value: number): { totalMinutes: number; seconds: number } {
	const safe = Number.isFinite(value) && value > 0 ? value : 0;
	let totalMinutes = Math.floor(safe / 60);
	let seconds = Math.round((safe % 60) * 10) / 10;
	if (seconds >= 60) {
		totalMinutes += 1;
		seconds = 0;
	}
	return { totalMinutes, seconds };
}

/** `m:ss.t` — no hour field, ever. */
export function formatSec(sec: number): string {
	const { totalMinutes, seconds } = splitRoundedTime(sec);
	return `${totalMinutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** `m:ss.t`, or `h:mm:ss.t` once past an hour. */
export function formatSeconds(value: number): string {
	const { totalMinutes, seconds } = splitRoundedTime(value);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
	}
	return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** `formatSec` for callers holding milliseconds (lane pills, hover tips). */
export function formatMs(ms: number): string {
	return formatSec(ms / 1000);
}
