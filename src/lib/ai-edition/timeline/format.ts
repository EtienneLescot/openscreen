// Format milliseconds as the timeline-style timecode (m:ss.t).
//
// Shared by Bottombar lane pills and TimelinePane so pill hover tips and the
// header readouts stay in sync. Kept tiny — it's used in dozens of pill titles
// and would otherwise duplicate `${Math.floor(sec/60)}:${(...).toFixed(1)}`
// paddings across the editor.

export function formatMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0:00.0";
	const sec = ms / 1000;
	const m = Math.floor(sec / 60);
	const s = (sec % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}
