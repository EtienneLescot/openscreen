// ponytail: interval arithmetic, one implementation, no document knowledge.
//
// Every editorial oracle is a set operation on time ranges — "which speech
// seconds did the cut remove", "which silence did it leave in", "do two zooms
// overlap". Writing those unions and subtractions inline in each oracle is how
// an off-by-a-float becomes an oracle that quietly reports 0 s of damage; this
// module exists so the arithmetic is pinned once, in `l0/spans.wb.ts`.
//
// The app has its own interval helpers (`document/timeline.ts`), but they clamp
// to a duration and are tuned for the timeline layout. An oracle must NOT clamp:
// a trim running past the end of the material is exactly the kind of damage we
// are measuring, and silently pulling it back inside the asset would hide it.

/** A half-open range of SOURCE seconds, `[startSec, endSec)`. */
export interface Span {
	startSec: number;
	endSec: number;
}

/**
 * Below this, two boundaries are the same boundary.
 *
 * 1 µs: small enough that no editorial decision hides under it (the shortest
 * thing a human can perceive as a cut is four orders of magnitude longer), big
 * enough to absorb the float error of `30.0 - 12.5 + 12.5`. Deliberately much
 * tighter than the 2 ms `EPSILON_SEC` of `oracles.ts`, which compares numbers a
 * TOOL round-tripped through JSON; here both sides come from the same document.
 */
export const SPAN_EPSILON_SEC = 1e-6;

export function spanDuration(span: Span): number {
	return Math.max(0, span.endSec - span.startSec);
}

export function totalSec(spans: Span[]): number {
	return spans.reduce((sum, span) => sum + spanDuration(span), 0);
}

/** Sorted, non-overlapping, with touching neighbours joined. Empty spans are
 * dropped: a zero-length range is not a piece of the timeline. */
export function mergeSpans(spans: Span[]): Span[] {
	const ordered = spans
		.filter((span) => spanDuration(span) > SPAN_EPSILON_SEC)
		.sort((a, b) => a.startSec - b.startSec);
	const merged: Span[] = [];
	for (const span of ordered) {
		const last = merged.at(-1);
		if (!last || span.startSec > last.endSec + SPAN_EPSILON_SEC) {
			merged.push({ startSec: span.startSec, endSec: span.endSec });
			continue;
		}
		last.endSec = Math.max(last.endSec, span.endSec);
	}
	return merged;
}

/** `from` minus `minus`, both normalized first. */
export function subtractSpans(from: Span[], minus: Span[]): Span[] {
	const holes = mergeSpans(minus);
	let kept = mergeSpans(from);
	for (const hole of holes) {
		const next: Span[] = [];
		for (const span of kept) {
			// Disjoint: nothing to cut.
			if (hole.endSec <= span.startSec + SPAN_EPSILON_SEC) {
				next.push(span);
				continue;
			}
			if (hole.startSec >= span.endSec - SPAN_EPSILON_SEC) {
				next.push(span);
				continue;
			}
			if (hole.startSec > span.startSec + SPAN_EPSILON_SEC) {
				next.push({ startSec: span.startSec, endSec: hole.startSec });
			}
			if (hole.endSec < span.endSec - SPAN_EPSILON_SEC) {
				next.push({ startSec: hole.endSec, endSec: span.endSec });
			}
		}
		kept = next;
	}
	return mergeSpans(kept);
}

export function intersectSpans(a: Span[], b: Span[]): Span[] {
	const left = mergeSpans(a);
	const right = mergeSpans(b);
	const out: Span[] = [];
	for (const one of left) {
		for (const other of right) {
			const startSec = Math.max(one.startSec, other.startSec);
			const endSec = Math.min(one.endSec, other.endSec);
			if (endSec - startSec > SPAN_EPSILON_SEC) out.push({ startSec, endSec });
		}
	}
	return mergeSpans(out);
}

/** Seconds shared by two spans; 0 when they merely touch. */
export function overlapSec(a: Span, b: Span): number {
	return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

/** The complement of `spans` inside `within`. */
export function invertSpans(spans: Span[], within: Span): Span[] {
	return subtractSpans([within], spans);
}

/** True when `atSec` falls inside `span`, with an optional tolerance on both
 * ends — an interest point one frame outside a zoom is still covered by it. */
export function containsSec(span: Span, atSec: number, toleranceSec = 0): boolean {
	return atSec >= span.startSec - toleranceSec && atSec <= span.endSec + toleranceSec;
}

/** Formats spans for check evidence: `12.00–17.00, 31.00–36.20`. */
export function formatSpans(spans: Span[], max = 6): string {
	const shown = spans
		.slice(0, max)
		.map((span) => `${span.startSec.toFixed(2)}–${span.endSec.toFixed(2)}`)
		.join(", ");
	return spans.length > max ? `${shown}, +${spans.length - max}` : shown;
}
