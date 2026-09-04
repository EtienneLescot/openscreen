// The one way to turn a document on disk into a document in memory.
//
// Three steps, in this order, and no caller may do two of them and skip the third:
//
//   1. UPGRADE  — `migrateRawDocumentToCurrent` walks the vN → vN+1 chain.
//   2. VALIDATE — `documentSchema.parse` is a pure current-version shape check.
//   3. RECONCILE — clip geometry is brought back in line with the insert ranges.
//
// Step 3 is the one that is easy to forget and impossible to notice. An insertion is MEDIA
// inside a clip (issue #560), so a clip carrying one is longer than its source window by
// exactly that much — every reader downstream depends on it, and a document written before
// that was true carries SHORT clips. Nothing else reconciles them: `withInsertRangesForWords`
// only runs when a transcript word is written, so a project the user merely OPENS keeps its
// old geometry while all the code around it assumes the new. The visible result is a film
// whose ruler stops short, insertion pills drawn at their source position instead of their
// timeline one, and subtitles sliding further out of step with every insertion passed.
//
// `reflowClipsForInserts` is absolute rather than incremental, so this is idempotent: a
// document already in step is returned unchanged, and running it on every load costs nothing
// while also repairing anything that writes clip geometry without allowing for insertions.

import type { AxcutDocument } from "../schema";
import { documentSchema, migrateRawDocumentToCurrent } from "../schema";
import { reflowClipsForInserts } from "./timeline";
import { withInsertRangesForAllWords, withMarkedAddedWords } from "./transcript";

/**
 * The whole insertion invariant, in dependency order.
 *
 * A word is ADDED, an added word has an INSERTION, and a clip carrying insertions is
 * LONGER. Each step feeds the next, and reconciling only the last one left a document
 * carrying an unmarked added word looking perfectly consistent while playing its text over
 * the recording. Every step is idempotent, so this runs on every load and changes nothing
 * for a document already in step.
 */
export function reconcileInsertions(document: AxcutDocument): AxcutDocument {
	return reconcileClipsWithInserts(withInsertRangesForAllWords(withMarkedAddedWords(document)));
}

/** Clip geometry brought back in line with the document's insert ranges. Idempotent. */
export function reconcileClipsWithInserts(document: AxcutDocument): AxcutDocument {
	const insertRanges = document.timeline.insertRanges ?? [];
	if (insertRanges.length === 0) return document;
	const clips = reflowClipsForInserts(document.timeline.clips, insertRanges);
	const unchanged =
		clips.length === document.timeline.clips.length &&
		clips.every((clip, i) => {
			const was = document.timeline.clips[i];
			return (
				Math.abs(clip.timelineStartSec - was.timelineStartSec) < 1e-9 &&
				Math.abs(clip.timelineEndSec - was.timelineEndSec) < 1e-9
			);
		});
	return unchanged ? document : { ...document, timeline: { ...document.timeline, clips } };
}

/** Raw JSON (any stored version) → a validated, reconciled document. */
export function parseStoredDocument(raw: unknown): AxcutDocument {
	return reconcileInsertions(documentSchema.parse(migrateRawDocumentToCurrent(raw)));
}
