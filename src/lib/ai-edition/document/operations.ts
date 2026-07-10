// Timeline operation dispatcher — port of axcut's `apps/server/src/services/document-service.ts#applyOperation`
// in the slim shape Phase 1 needs. The full union covers the 11 timeline ops
// axcut supports; we ship the four mutating ones our agent already exposes
// plus two structural helpers (drop range, restore full timeline).
//
// Each variant carries enough context to drive the document model directly
// and to compute a one-line chat summary. Callers (renderer quick-edit UI,
// agent tools, future renderer ops toolbar) hand `applyTimelineOperation`
// a parsed `AxcutTimelineOperation` and get back the mutated document
// and a summary string.

import type { AxcutDocument } from "../schema";
import {
	duplicateClip,
	moveClip,
	normalizeIntervals,
	primaryAssetDuration,
	replaceTimeline,
	resequenceClips,
} from "./timeline";

export type AxcutTimelineOperation =
	| {
			type: "replace_timeline";
			intervals: Array<{ startSec: number; endSec: number }>;
			reason?: string;
	  }
	| {
			type: "drop_range";
			assetId?: string;
			startSec: number;
			endSec: number;
			reason?: string;
	  }
	| {
			type: "add_trim_range";
			assetId?: string;
			startSec: number;
			endSec: number;
			reason?: string;
	  }
	| {
			type: "update_trim_range";
			trimId: string;
			startSec: number;
			endSec: number;
			reason?: string;
	  }
	| {
			type: "remove_trim_range";
			trimId: string;
			reason?: string;
	  }
	| {
			type: "restore_full_timeline";
			reason?: string;
	  }
	| {
			type: "update_clip_range";
			clipId: string;
			sourceStartSec: number;
			sourceEndSec: number;
			reason?: string;
	  }
	| {
			type: "move_clip";
			clipId: string;
			insertIndex: number;
			reason?: string;
	  }
	| {
			type: "duplicate_clip";
			clipId: string;
			reason?: string;
	  };

export interface AppliedTimelineOperation {
	document: AxcutDocument;
	summary: string;
}

function formatSec(sec: number): string {
	const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
	const m = Math.floor(safe / 60);
	const s = (safe % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

function pickAssetId(document: AxcutDocument, explicit?: string): string | null {
	if (explicit) return explicit;
	return document.project.primaryAssetId ?? document.assets[0]?.id ?? null;
}

function dropRangeToIntervals(
	document: AxcutDocument,
	assetId: string,
	startSec: number,
	endSec: number,
): Array<{ startSec: number; endSec: number }> {
	// ponytail: build the kept intervals = (existing clips on this asset) − (cut).
	// We start from the union of existing clips on the asset, normalize it, then
	// punch out the cut. axcut's equivalent pulls from `clips[]` directly, but
	// for the renderer quick-edit path the asset may have a single full clip
	// (the common import-then-edit shape), so we synthesize its range first.
	const duration = primaryAssetDuration(document);
	if (duration <= 0) return [];
	const existing = document.timeline.clips
		.filter((c) => c.assetId === assetId)
		.map((c) => ({
			startSec: Math.min(c.sourceStartSec, c.sourceEndSec ?? c.sourceStartSec),
			endSec: Math.max(c.sourceStartSec, c.sourceEndSec ?? c.sourceStartSec),
		}));
	const lo = Math.max(0, Math.min(startSec, endSec));
	const hi = Math.max(lo, Math.max(startSec, endSec));
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
		// ponytail: no-op range — keep the union of existing clips (or the full
		// duration if no clips are recorded yet).
		if (existing.length === 0) return [{ startSec: 0, endSec: duration }];
		return normalizeIntervals(
			duration,
			existing.map((e) => ({ startSec: e.startSec, endSec: e.endSec })),
		);
	}
	const union = existing.length > 0 ? existing : [{ startSec: 0, endSec: duration }];
	const cut = { startSec: lo, endSec: hi };
	const kept: Array<{ startSec: number; endSec: number }> = [];
	for (const iv of union) {
		if (cut.endSec <= iv.startSec || cut.startSec >= iv.endSec) {
			kept.push(iv);
			continue;
		}
		if (iv.startSec < cut.startSec) {
			kept.push({ startSec: iv.startSec, endSec: cut.startSec });
		}
		if (cut.endSec < iv.endSec) {
			kept.push({ startSec: cut.endSec, endSec: iv.endSec });
		}
	}
	return normalizeIntervals(
		duration,
		kept.map((e) => ({ startSec: e.startSec, endSec: e.endSec })),
	);
}

export function applyTimelineOperation(
	document: AxcutDocument,
	op: AxcutTimelineOperation,
): AppliedTimelineOperation {
	switch (op.type) {
		case "replace_timeline": {
			if (!op.intervals.length) {
				return { document, summary: "no intervals to keep" };
			}
			const reason = op.reason ?? "replaceTimeline";
			const next = replaceTimeline(document, op.intervals, reason, "user");
			const kept = op.intervals.length;
			return {
				document: next,
				summary: `rebuilt timeline (${kept} interval${kept === 1 ? "" : "s"})`,
			};
		}
		case "drop_range": {
			const assetId = pickAssetId(document, op.assetId);
			if (!assetId) return { document, summary: "no asset to drop from" };
			const intervals = dropRangeToIntervals(document, assetId, op.startSec, op.endSec);
			if (!intervals.length) {
				return { document, summary: "drop range was empty" };
			}
			const reason = op.reason ?? `dropped ${formatSec(op.startSec)}–${formatSec(op.endSec)}`;
			const next = replaceTimeline(document, intervals, reason, "user");
			return {
				document: next,
				summary: `dropped ${formatSec(op.startSec)}–${formatSec(op.endSec)}`,
			};
		}
		case "add_trim_range": {
			const assetId = pickAssetId(document, op.assetId);
			if (!assetId) return { document, summary: "no asset to trim" };
			const lo = Math.max(0, Math.min(op.startSec, op.endSec));
			const hi = Math.max(lo, Math.max(op.startSec, op.endSec));
			const existing = document.timeline.trimRanges.filter((s) => s.assetId === assetId);
			// ponytail: bound by the trim-range asset's duration, not the
			// primary asset's. Recording projects can have a short primary
			// asset (snippet) while the clip uses a long video — using
			// primaryAssetDuration here would truncate the trim range and
			// only trim a few words instead of the user's full selection.
			const asset = document.assets.find((a) => a.id === assetId);
			const duration = asset?.durationSec ?? Infinity;
			const merged = normalizeIntervals(duration, [
				{ startSec: lo, endSec: hi },
				...existing.map((s) => ({ startSec: s.startSec, endSec: s.endSec })),
			]);
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: merged.map((iv, i) => ({
						id: `trim_${i + 1}`,
						assetId,
						startSec: iv.startSec,
						endSec: iv.endSec,
						origin: "user" as const,
						reason: op.reason ?? "",
					})),
				},
				preview: { ...document.preview, revision: document.preview.revision + 1 },
			};
			return {
				document: next,
				summary: `added trim ${formatSec(lo)}–${formatSec(hi)}`,
			};
		}
		case "update_trim_range": {
			const lo = Math.max(0, Math.min(op.startSec, op.endSec));
			const hi = Math.max(lo, Math.max(op.startSec, op.endSec));
			let found = false;
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: document.timeline.trimRanges.map((s) => {
						if (s.id !== op.trimId) return s;
						found = true;
						return { ...s, startSec: lo, endSec: hi, reason: op.reason ?? s.reason };
					}),
				},
				preview: { ...document.preview, revision: document.preview.revision + 1 },
			};
			if (!found) return { document, summary: `unknown trim ${op.trimId}` };
			return {
				document: next,
				summary: `updated trim ${op.trimId} to ${formatSec(lo)}–${formatSec(hi)}`,
			};
		}
		case "remove_trim_range": {
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: document.timeline.trimRanges.filter((s) => s.id !== op.trimId),
				},
				preview: { ...document.preview, revision: document.preview.revision + 1 },
			};
			return {
				document: next,
				summary: `removed trim ${op.trimId}`,
			};
		}
		case "restore_full_timeline": {
			const duration = primaryAssetDuration(document);
			if (duration <= 0) return { document, summary: "no duration yet" };
			const next = replaceTimeline(
				document,
				[{ startSec: 0, endSec: duration }],
				op.reason ?? "restored full timeline",
				"user",
			);
			return { document: next, summary: "restored full timeline" };
		}
		case "update_clip_range": {
			const clips = document.timeline.clips.map((c) => {
				if (c.id !== op.clipId) return c;
				const lo = Math.max(0, Math.min(op.sourceStartSec, op.sourceEndSec));
				const hi = Math.max(lo, Math.max(op.sourceStartSec, op.sourceEndSec));
				return {
					...c,
					sourceStartSec: lo,
					sourceEndSec: hi,
					timelineStartSec: 0,
					timelineEndSec: 0,
				};
			});
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					clips: resequenceClips(clips),
				},
				preview: { ...document.preview, revision: document.preview.revision + 1 },
			};
			return {
				document: next,
				summary: `trimmed clip to ${formatSec(Math.min(op.sourceStartSec, op.sourceEndSec))}–${formatSec(Math.max(op.sourceStartSec, op.sourceEndSec))}`,
			};
		}
		case "move_clip": {
			const next = moveClip(document, op.clipId, op.insertIndex, "user", op.reason ?? "");
			return { document: next, summary: `moved clip ${op.clipId} to position ${op.insertIndex}` };
		}
		case "duplicate_clip": {
			const next = duplicateClip(document, op.clipId, "user", op.reason ?? "");
			return { document: next, summary: `duplicated clip ${op.clipId}` };
		}
		default: {
			// ponytail: exhaustive — TS errors here when a new variant is added.
			const exhaustive: never = op;
			void exhaustive;
			return { document, summary: "unhandled operation" };
		}
	}
}
