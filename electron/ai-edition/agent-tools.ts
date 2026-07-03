// Agent tool layer (P1.1/P1.2): the JSON-schema tool definitions fed to the
// LLM as `tools[]`, plus the executor that validates arguments (zod) and
// applies each tool against an AxcutDocument snapshot. Pure — no IPC, no fs.
// The chat-service tool loop owns checkpoints and persistence; this module
// only knows how to turn (document, toolName, argsJson) into a new document.
//
// Read tools return JSON the model can reason over; write tools return the
// mutated document plus a human-readable summary line for the chat panel
// ("applied: added skip 0:02.1 – 0:02.4").

import { z } from "zod";
import { createId } from "../../src/lib/ai-edition/document/ids";
import { replaceTimeline, resequenceClips } from "../../src/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";

export interface AgentToolSpec {
	name: string;
	description: string;
	/** JSON schema for the tool arguments, sent verbatim to the provider. */
	parameters: Record<string, unknown>;
	/** True when the tool mutates the document (gates checkpoint + permission). */
	mutating: boolean;
}

export interface AgentToolExecution {
	ok: boolean;
	/** JSON payload returned to the model as the tool result. */
	resultJson: string;
	/** Updated document — only set when the tool mutated it. */
	document?: AxcutDocument;
	/** One-line human summary for the chat panel (mutating tools only). */
	summary?: string;
}

function formatSec(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
	const m = Math.floor(sec / 60);
	const s = (sec % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

const secondsSchema = z.number().finite().nonnegative();

const addSkipArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	assetId: z.string().min(1).optional(),
	reason: z.string().default(""),
});

const setSkipRangeArgs = z.object({
	skipRangeId: z.string().min(1),
	startSec: secondsSchema,
	endSec: secondsSchema,
});

const setClipRangeArgs = z.object({
	clipId: z.string().min(1),
	sourceStartSec: secondsSchema,
	sourceEndSec: secondsSchema,
});

const replaceTimelineArgs = z.object({
	intervals: z.array(z.object({ startSec: secondsSchema, endSec: secondsSchema })).min(1),
	reason: z.string().default(""),
});

const getTranscriptArgs = z.object({
	assetId: z.string().min(1).optional(),
});

export const AGENT_TOOL_SPECS: AgentToolSpec[] = [
	{
		name: "getCurrentDocument",
		description:
			"Read a compact snapshot of the current project: assets (with durations), timeline clips, skip ranges, and counts of annotations/zoom ranges. Call this before editing if the snapshot in the system prompt may be stale.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		mutating: false,
	},
	{
		name: "getTranscript",
		description:
			"Read the transcript segments (speech and silence, with start/end seconds and text) for an asset. Omit assetId to read the primary asset's transcript.",
		parameters: {
			type: "object",
			properties: {
				assetId: { type: "string", description: "Asset id; defaults to the primary asset." },
			},
			additionalProperties: false,
		},
		mutating: false,
	},
	{
		name: "addSkip",
		description:
			"Add a skip range (a cut — this source-time span will not be played or exported). Times are in seconds of the asset's source time.",
		parameters: {
			type: "object",
			properties: {
				startSec: { type: "number", minimum: 0 },
				endSec: { type: "number", minimum: 0 },
				assetId: { type: "string", description: "Asset id; defaults to the primary asset." },
				reason: { type: "string", description: "Why this range is being cut." },
			},
			required: ["startSec", "endSec"],
			additionalProperties: false,
		},
		mutating: true,
	},
	{
		name: "setSkipRange",
		description: "Move or resize an existing skip range by id. Times are source-time seconds.",
		parameters: {
			type: "object",
			properties: {
				skipRangeId: { type: "string" },
				startSec: { type: "number", minimum: 0 },
				endSec: { type: "number", minimum: 0 },
			},
			required: ["skipRangeId", "startSec", "endSec"],
			additionalProperties: false,
		},
		mutating: true,
	},
	{
		name: "setClipRange",
		description:
			"Trim a clip: set its source in/out points (seconds). All clips are re-laid back-to-back afterwards, so downstream clips shift automatically.",
		parameters: {
			type: "object",
			properties: {
				clipId: { type: "string" },
				sourceStartSec: { type: "number", minimum: 0 },
				sourceEndSec: { type: "number", minimum: 0 },
			},
			required: ["clipId", "sourceStartSec", "sourceEndSec"],
			additionalProperties: false,
		},
		mutating: true,
	},
	{
		name: "replaceTimeline",
		description:
			"Replace the whole timeline with the given kept intervals of the primary asset's source time. Everything outside the intervals becomes a skip. Use for bulk edits like 'cut all silences'.",
		parameters: {
			type: "object",
			properties: {
				intervals: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						properties: {
							startSec: { type: "number", minimum: 0 },
							endSec: { type: "number", minimum: 0 },
						},
						required: ["startSec", "endSec"],
						additionalProperties: false,
					},
				},
				reason: { type: "string" },
			},
			required: ["intervals"],
			additionalProperties: false,
		},
		mutating: true,
	},
];

export function isMutatingTool(name: string): boolean {
	return AGENT_TOOL_SPECS.find((t) => t.name === name)?.mutating ?? false;
}

// Compact projection of the document for the model: everything it needs to
// reference ids and times, nothing it doesn't (no waveform paths, no history).
export function documentSnapshotForModel(document: AxcutDocument): Record<string, unknown> {
	return {
		project: { id: document.project.id, title: document.project.title },
		primaryAssetId: document.project.primaryAssetId ?? document.assets[0]?.id ?? null,
		assets: document.assets.map((a) => ({
			id: a.id,
			label: a.label,
			durationSec: a.durationSec ?? null,
		})),
		clips: document.timeline.clips.map((c) => ({
			id: c.id,
			assetId: c.assetId,
			sourceStartSec: c.sourceStartSec,
			sourceEndSec: c.sourceEndSec ?? null,
			timelineStartSec: c.timelineStartSec,
			timelineEndSec: c.timelineEndSec,
		})),
		skipRanges: document.timeline.skipRanges.map((s) => ({
			id: s.id,
			assetId: s.assetId,
			startSec: s.startSec,
			endSec: s.endSec,
			reason: s.reason,
		})),
		annotationCount: document.annotations.length,
		zoomRangeCount: document.zoomRanges.length,
		hasTranscript: document.transcripts.length > 0 || document.transcript !== null,
	};
}

function failure(message: string): AgentToolExecution {
	return { ok: false, resultJson: JSON.stringify({ error: message }) };
}

export function executeAgentTool(
	document: AxcutDocument,
	name: string,
	rawArgs: string,
): AgentToolExecution {
	let args: unknown = {};
	if (rawArgs.trim()) {
		try {
			args = JSON.parse(rawArgs);
		} catch {
			return failure(`Tool arguments are not valid JSON: ${rawArgs.slice(0, 120)}`);
		}
	}

	switch (name) {
		case "getCurrentDocument": {
			return { ok: true, resultJson: JSON.stringify(documentSnapshotForModel(document)) };
		}

		case "getTranscript": {
			const parsed = getTranscriptArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const assetId =
				parsed.data.assetId ?? document.project.primaryAssetId ?? document.assets[0]?.id;
			const transcript =
				document.transcripts.find((t) => t.assetId === assetId) ??
				(document.transcript?.assetId === assetId ? document.transcript : null);
			if (!transcript) {
				return failure(`No transcript for asset ${assetId ?? "(none)"}.`);
			}
			// ponytail: segments only — words would blow the context for long
			// recordings and the segment text already carries the content.
			const segments = transcript.segments.slice(0, 800).map((s) => ({
				id: s.id,
				kind: s.kind,
				startSec: s.startSec,
				endSec: s.endSec,
				text: s.text,
			}));
			return {
				ok: true,
				resultJson: JSON.stringify({ assetId, language: transcript.language, segments }),
			};
		}

		case "addSkip": {
			const parsed = addSkipArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const assetId =
				parsed.data.assetId ?? document.project.primaryAssetId ?? document.assets[0]?.id;
			if (!assetId) return failure("Project has no assets — nothing to skip.");
			if (!document.assets.some((a) => a.id === assetId)) {
				return failure(`Unknown asset: ${assetId}`);
			}
			const startSec = Math.min(parsed.data.startSec, parsed.data.endSec);
			const endSec = Math.max(parsed.data.startSec, parsed.data.endSec);
			const skip = {
				id: createId("skip"),
				assetId,
				startSec,
				endSec,
				reason: parsed.data.reason,
				origin: "agent" as const,
			};
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					skipRanges: [...document.timeline.skipRanges, skip],
				},
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ skipRangeId: skip.id, startSec, endSec }),
				summary: `added skip ${formatSec(startSec)} – ${formatSec(endSec)}`,
			};
		}

		case "setSkipRange": {
			const parsed = setSkipRangeArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { skipRangeId } = parsed.data;
			if (!document.timeline.skipRanges.some((r) => r.id === skipRangeId)) {
				return failure(`Unknown skip range: ${skipRangeId}`);
			}
			const startSec = Math.min(parsed.data.startSec, parsed.data.endSec);
			const endSec = Math.max(parsed.data.startSec, parsed.data.endSec);
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					skipRanges: document.timeline.skipRanges.map((r) =>
						r.id === skipRangeId ? { ...r, startSec, endSec } : r,
					),
				},
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ skipRangeId, startSec, endSec }),
				summary: `moved skip to ${formatSec(startSec)} – ${formatSec(endSec)}`,
			};
		}

		case "setClipRange": {
			const parsed = setClipRangeArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { clipId } = parsed.data;
			if (!document.timeline.clips.some((c) => c.id === clipId)) {
				return failure(`Unknown clip: ${clipId}`);
			}
			const sourceStartSec = Math.min(parsed.data.sourceStartSec, parsed.data.sourceEndSec);
			const sourceEndSec = Math.max(parsed.data.sourceStartSec, parsed.data.sourceEndSec);
			const clips = resequenceClips(
				document.timeline.clips.map((c) =>
					c.id === clipId
						? {
								...c,
								sourceStartSec,
								sourceEndSec,
								// ponytail: zero the timeline span so resequenceClips derives the
								// clip length from the new source range instead of the stale one.
								timelineStartSec: 0,
								timelineEndSec: 0,
							}
						: c,
				),
			);
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips },
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ clipId, sourceStartSec, sourceEndSec }),
				summary: `trimmed clip to ${formatSec(sourceStartSec)} – ${formatSec(sourceEndSec)}`,
			};
		}

		case "replaceTimeline": {
			const parsed = replaceTimelineArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const userPlaced = document.timeline.clips.filter((c) => c.origin === "user");
			if (userPlaced.length > 0) {
				return {
					ok: false,
					resultJson: JSON.stringify({
						error: `Refused: ${userPlaced.length} user-placed clip(s) would be discarded. ` +
							`For 'remove silences' / 'cut pauses' use addSkip (one call per silent range), ` +
							`which preserves the placed clips and adds the cuts. ` +
							`For 'trim this clip' use setClipRange. ` +
							`Only call replaceTimeline when the user explicitly asks to rebuild the timeline from scratch ` +
							`(after they have already cleared their placed clips).`,
					}),
				};
			}
			let next: AxcutDocument;
			try {
				next = replaceTimeline(document, parsed.data.intervals, parsed.data.reason, "agent");
			} catch (err) {
				return failure(err instanceof Error ? err.message : String(err));
			}
			const kept = parsed.data.intervals.length;
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					clipCount: next.timeline.clips.length,
					skipCount: next.timeline.skipRanges.length,
				}),
				summary: `rebuilt timeline from ${kept} interval${kept === 1 ? "" : "s"} (${next.timeline.clips.length} clips, ${next.timeline.skipRanges.length} skips)`,
			};
		}

		default:
			return failure(`Unknown tool: ${name}`);
	}
}
