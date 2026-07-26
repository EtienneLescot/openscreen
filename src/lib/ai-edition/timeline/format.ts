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

/** `m:ss.t` — no hour field, ever. */
export function formatSec(sec: number): string {
	const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
	const m = Math.floor(safe / 60);
	const s = (safe % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

/** `m:ss.t`, or `h:mm:ss.t` once past an hour. */
export function formatSeconds(value: number): string {
	const safe = Number.isFinite(value) && value > 0 ? value : 0;
	const hours = Math.floor(safe / 3600);
	const minutes = Math.floor((safe % 3600) / 60);
	const seconds = safe % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
	}
	return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** `formatSec` for callers holding milliseconds (lane pills, hover tips). */
export function formatMs(ms: number): string {
	return formatSec(ms / 1000);
}
