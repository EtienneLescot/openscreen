// Interval arithmetic, with no opinion about what the numbers mean.
//
// Extracted from `document/timeline.ts` so `programme-time.ts` can reuse the very
// subtraction that `resolvePlaybackSegments` runs. It could not import it from there:
// the dependency runs `document/` → `timeline/` (document/timeline.ts already imports
// `trimAppliesToClip` from this layer), so importing back would close a cycle. A second
// copy of the same twelve lines was the alternative, and two implementations of "what
// survives a cut" is exactly the shape of bug this whole change exists to remove.
//
// `document/timeline.ts` re-exports both names, so its existing callers are unaffected.

export interface Interval {
	startSec: number;
	endSec: number;
}

/**
 * `intervals` minus `cut`. An interval straddling the cut splits in two; one wholly
 * inside it disappears. Inputs are not required to be sorted or disjoint, and the
 * output preserves the order it was given.
 */
export function subtractInterval(intervals: Interval[], cut: Interval): Interval[] {
	const output: Interval[] = [];
	for (const interval of intervals) {
		if (cut.endSec <= interval.startSec || cut.startSec >= interval.endSec) {
			output.push(interval);
			continue;
		}
		if (cut.startSec > interval.startSec) {
			output.push({ startSec: interval.startSec, endSec: cut.startSec });
		}
		if (cut.endSec < interval.endSec) {
			output.push({ startSec: cut.endSec, endSec: interval.endSec });
		}
	}
	return output;
}
