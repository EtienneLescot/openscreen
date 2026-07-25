// Agent tool layer (P1.1/P1.2): the JSON-schema tool definitions fed to the
// LLM as `tools[]`, plus the executor that validates arguments (zod) and
// applies each tool against an AxcutDocument snapshot. Pure — no IPC, no fs.
// The chat-service tool loop owns checkpoints and persistence; this module
// only knows how to turn (document, toolName, argsJson) into a new document.
//
// Read tools return JSON the model can reason over; write tools return the
// mutated document plus a human-readable summary line for the chat panel
// ("applied: added trim 0:02.1 – 0:02.4").

import { z } from "zod";
import { createId } from "../../src/lib/ai-edition/document/ids";
import { replaceTimeline, setClipSourceRange } from "../../src/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	anchorRegionsWithDerivedMs,
	coalesceRegionsForRuler,
	replacePillSpan,
	resolvePillIds,
} from "../../src/lib/ai-edition/timeline/timelineMap";

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

function toMs(sec: number): number {
	return Math.max(0, Math.round(sec * 1000));
}

// For the effect set* tools: keep the stored span unless the caller passes new
// edges, and normalise so start ≤ end. Input seconds are virtual-timeline time.
function resolveSpanMs(
	existing: { startMs: number; endMs: number },
	startSec: number | undefined,
	endSec: number | undefined,
): { startMs: number; endMs: number } {
	if (startSec === undefined && endSec === undefined) {
		return { startMs: existing.startMs, endMs: existing.endMs };
	}
	const s = startSec ?? existing.startMs / 1000;
	const e = endSec ?? existing.endMs / 1000;
	return { startMs: toMs(Math.min(s, e)), endMs: toMs(Math.max(s, e)) };
}

// v5: a modifier is stored as clip-anchored fragment(s), and adjacent regions with the
// same properties read as ONE pill (timelineMap merge rule). The agent reasons in VIRTUAL
// seconds over whole regions, so we present exactly the pills the user sees, keyed by the
// first region under each — which every set*/remove* tool accepts as the id.
function coalesceForAgent<T extends { id: string; startMs: number; endMs: number }>(
	regions: T[],
): T[] {
	return coalesceRegionsForRuler(regions).map((pill) => ({
		...pill.member,
		id: pill.ids[0],
		startMs: Math.round(pill.start * 1000),
		endMs: Math.round(pill.end * 1000),
	}));
}

/** Every agent write anchors the region to the clip(s) it covers, exactly like the UI. */
function anchorForAgent<T extends { id: string; startMs: number; endMs: number }>(
	region: T,
	document: AxcutDocument,
	prefix: string,
) {
	return anchorRegionsWithDerivedMs([region], document.timeline.clips, () => createId(prefix));
}

const secondsSchema = z.number().finite().nonnegative();

const addTrimArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	assetId: z.string().min(1).optional(),
	reason: z.string().default(""),
});

const setTrimArgs = z.object({
	trimRangeId: z.string().min(1),
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

// Effects (zoom / speed / annotation) are authored in *virtual* (edited-
// timeline) seconds — the position on the ruler the user sees — unlike clips
// and trims, which are source-time. The executor converts to the stored ms.
const depthSchema = z.number().int().min(1).max(6);
const focusSchema = z.object({ cx: z.number().min(0).max(1), cy: z.number().min(0).max(1) });

const addZoomArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	depth: depthSchema.default(3),
	focus: focusSchema.default({ cx: 0.5, cy: 0.5 }),
});

const setZoomArgs = z.object({
	zoomId: z.string().min(1),
	startSec: secondsSchema.optional(),
	endSec: secondsSchema.optional(),
	depth: depthSchema.optional(),
	focus: focusSchema.optional(),
});

const addSpeedArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	speed: z.number().positive().default(1.5),
});

const setSpeedArgs = z.object({
	speedId: z.string().min(1),
	startSec: secondsSchema.optional(),
	endSec: secondsSchema.optional(),
	speed: z.number().positive().optional(),
});

const addAnnotationArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	text: z.string().default(""),
	x: z.number().min(0).max(100).default(50),
	y: z.number().min(0).max(100).default(50),
});

const setAnnotationArgs = z.object({
	annotationId: z.string().min(1),
	startSec: secondsSchema.optional(),
	endSec: secondsSchema.optional(),
	text: z.string().optional(),
});

export const AGENT_TOOL_SPECS: AgentToolSpec[] = [
	{
		name: "getCurrentDocument",
		description:
			"Read a compact snapshot of the current project: assets (with durations), timeline clips and trim ranges (source-time), and the zoom / speed / annotation effects (virtual, edited-timeline time). Call this before editing if the snapshot in the system prompt may be stale.",
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
		name: "addTrim",
		description:
			"Add a trim range: a cut of a span *inside* a clip that removes it from both playback and export without splitting the clip (a long clip with a big trim is cleaner than two clips). Times are seconds of the asset's source time. For shortening a clip's head/tail use setClipRange instead.",
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
		name: "setTrim",
		description: "Move or resize an existing trim range by id. Times are source-time seconds.",
		parameters: {
			type: "object",
			properties: {
				trimRangeId: { type: "string" },
				startSec: { type: "number", minimum: 0 },
				endSec: { type: "number", minimum: 0 },
			},
			required: ["trimRangeId", "startSec", "endSec"],
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
			"Replace the whole timeline with the given kept intervals of the primary asset's source time. Everything outside the intervals becomes a trim. Use for bulk edits like 'cut all silences'.",
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
	{
		name: "addZoom",
		description:
			"Add a zoom-in effect over a span of the *edited timeline* (virtual seconds, as seen on the ruler — not source time). depth 1–6 maps to 1.0×–3.5× (default 3 ≈ 2.0×). focus is the zoom centre in 0–1 fractions of the frame (default centre). Use for 'zoom in on …' and the smart-zoom pass.",
		parameters: {
			type: "object",
			properties: {
				startSec: { type: "number", minimum: 0, description: "Virtual-timeline start (seconds)." },
				endSec: { type: "number", minimum: 0, description: "Virtual-timeline end (seconds)." },
				depth: {
					type: "integer",
					minimum: 1,
					maximum: 6,
					description: "Zoom level 1–6 (default 3).",
				},
				focus: {
					type: "object",
					description: "Zoom centre, fractions of the frame (default {cx:0.5,cy:0.5}).",
					properties: {
						cx: { type: "number", minimum: 0, maximum: 1 },
						cy: { type: "number", minimum: 0, maximum: 1 },
					},
					required: ["cx", "cy"],
					additionalProperties: false,
				},
			},
			required: ["startSec", "endSec"],
			additionalProperties: false,
		},
		mutating: true,
	},
	{
		name: "setZoom",
		description:
			"Move, resize, or restyle an existing zoom by id. Times are virtual-timeline seconds. Only the fields you pass are changed.",
		parameters: {
			type: "object",
			properties: {
				zoomId: { type: "string" },
				startSec: { type: "number", minimum: 0 },
				endSec: { type: "number", minimum: 0 },
				depth: { type: "integer", minimum: 1, maximum: 6 },
				focus: {
					type: "object",
					properties: {
						cx: { type: "number", minimum: 0, maximum: 1 },
						cy: { type: "number", minimum: 0, maximum: 1 },
					},
					required: ["cx", "cy"],
					additionalProperties: false,
				},
			},
			required: ["zoomId"],
			additionalProperties: false,
		},
		mutating: true,
	},
	{
		name: "addSpeed",
		description:
			"Add a speed-change region over a span of the *edited timeline* (virtual seconds). speed > 1 fast-forwards, < 1 slows down (default 1.5×). Use to speed through slow stretches without cutting them.",
		parameters: {
			type: "object",
			properties: {
				startSec: { type: "number", minimum: 0, description: "Virtual-timeline start (seconds)." },
				endSec: { type: "number", minimum: 0, description: "Virtual-timeline end (seconds)." },
				speed: {
					type: "number",
					exclusiveMinimum: 0,
					description: "Playback multiplier (default 1.5).",
				},
			},
			required: ["startSec", "endSec"],
			additionalProperties: false,
		},
		mutating: true,
	},
	{
		name: "setSpeed",
		description:
			"Move, resize, or change the multiplier of an existing speed region by id. Times are virtual-timeline seconds. Only the fields you pass are changed.",
		parameters: {
			type: "object",
			properties: {
				speedId: { type: "string" },
				startSec: { type: "number", minimum: 0 },
				endSec: { type: "number", minimum: 0 },
				speed: { type: "number", exclusiveMinimum: 0 },
			},
			required: ["speedId"],
			additionalProperties: false,
		},
		mutating: true,
	},
	{
		name: "addAnnotation",
		description:
			"Add a text annotation over a span of the *edited timeline* (virtual seconds). Position x/y are percentages of the frame (0–100, default centre). Use for callouts and labels.",
		parameters: {
			type: "object",
			properties: {
				startSec: { type: "number", minimum: 0, description: "Virtual-timeline start (seconds)." },
				endSec: { type: "number", minimum: 0, description: "Virtual-timeline end (seconds)." },
				text: { type: "string", description: "The annotation text." },
				x: {
					type: "number",
					minimum: 0,
					maximum: 100,
					description: "Horizontal position % (default 50).",
				},
				y: {
					type: "number",
					minimum: 0,
					maximum: 100,
					description: "Vertical position % (default 50).",
				},
			},
			required: ["startSec", "endSec", "text"],
			additionalProperties: false,
		},
		mutating: true,
	},
	{
		name: "setAnnotation",
		description:
			"Move, resize, or edit the text of an existing annotation by id. Times are virtual-timeline seconds. Only the fields you pass are changed.",
		parameters: {
			type: "object",
			properties: {
				annotationId: { type: "string" },
				startSec: { type: "number", minimum: 0 },
				endSec: { type: "number", minimum: 0 },
				text: { type: "string" },
			},
			required: ["annotationId"],
			additionalProperties: false,
		},
		mutating: true,
	},
];

export function isMutatingTool(name: string): boolean {
	return AGENT_TOOL_SPECS.find((t) => t.name === name)?.mutating ?? false;
}

function roundSec(ms: number): number {
	return Math.round(ms) / 1000;
}

// Compact projection of the document for the model: everything it needs to
// reference ids and times, nothing it doesn't (no waveform paths, no history).
//
// Three clearly-separated groups, each with its OWN time-base spelled out so the
// model never has to guess:
//   • clips   — arranged segments; source-time in/out + their timeline position.
//   • trims   — source-time cuts inside a clip (do not split the clip).
//   • effects — zoom / speed / annotation, in *virtual* (edited-timeline)
//     seconds, i.e. positions on the ruler after clips + trims are applied.
export function documentSnapshotForModel(document: AxcutDocument): Record<string, unknown> {
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const speedRegions =
		(legacy?.speedRegions as
			| Array<{ id: string; startMs: number; endMs: number; speed: number }>
			| undefined) ?? [];
	return {
		timeBaseNote:
			"clips and trims are in source-time seconds; zooms, speedRegions and annotations are in virtual (edited-timeline) seconds.",
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
		trimRanges: document.timeline.trimRanges.map((s) => ({
			id: s.id,
			assetId: s.assetId,
			startSec: s.startSec,
			endSec: s.endSec,
			reason: s.reason,
		})),
		zoomRanges: coalesceForAgent(document.zoomRanges).map((z) => ({
			id: z.id,
			startSec: roundSec(z.startMs),
			endSec: roundSec(z.endMs),
			depth: z.depth,
			focus: z.focus,
		})),
		speedRegions: coalesceForAgent(speedRegions).map((s) => ({
			id: s.id,
			startSec: roundSec(s.startMs),
			endSec: roundSec(s.endMs),
			speed: s.speed,
		})),
		annotations: coalesceForAgent(document.annotations).map((a) => ({
			id: a.id,
			startSec: roundSec(a.startMs),
			endSec: roundSec(a.endMs),
			type: a.type,
			text: a.textContent ?? a.content ?? "",
		})),
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

		case "addTrim": {
			const parsed = addTrimArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const assetId =
				parsed.data.assetId ?? document.project.primaryAssetId ?? document.assets[0]?.id;
			if (!assetId) return failure("Project has no assets — nothing to trim.");
			if (!document.assets.some((a) => a.id === assetId)) {
				return failure(`Unknown asset: ${assetId}`);
			}
			const startSec = Math.min(parsed.data.startSec, parsed.data.endSec);
			const endSec = Math.max(parsed.data.startSec, parsed.data.endSec);
			const trim = {
				id: createId("trim"),
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
					trimRanges: [...document.timeline.trimRanges, trim],
				},
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ trimRangeId: trim.id, startSec, endSec }),
				summary: `added trim ${formatSec(startSec)} – ${formatSec(endSec)}`,
			};
		}

		case "setTrim": {
			const parsed = setTrimArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { trimRangeId } = parsed.data;
			if (!document.timeline.trimRanges.some((r) => r.id === trimRangeId)) {
				return failure(`Unknown trim range: ${trimRangeId}`);
			}
			const startSec = Math.min(parsed.data.startSec, parsed.data.endSec);
			const endSec = Math.max(parsed.data.startSec, parsed.data.endSec);
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: document.timeline.trimRanges.map((r) =>
						r.id === trimRangeId ? { ...r, startSec, endSec } : r,
					),
				},
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ trimRangeId, startSec, endSec }),
				summary: `moved trim to ${formatSec(startSec)} – ${formatSec(endSec)}`,
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
			// One shared mutator with the modale + op dispatcher: recomputes the clip's
			// width from the new source window AND clamps/drops the anchored pills the
			// trim removed. Hand-rolling it here is exactly what left this façade orphaning
			// stale pills the other two didn't.
			const next = setClipSourceRange(document, clipId, sourceStartSec, sourceEndSec);
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
						error:
							`Refused: ${userPlaced.length} user-placed clip(s) would be discarded. ` +
							`For 'remove silences' / 'cut pauses' use addTrim (one call per silent range), ` +
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
					trimCount: next.timeline.trimRanges.length,
				}),
				summary: `rebuilt timeline from ${kept} interval${kept === 1 ? "" : "s"} (${next.timeline.clips.length} clips, ${next.timeline.trimRanges.length} trims)`,
			};
		}

		case "addZoom": {
			const parsed = addZoomArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const startMs = toMs(Math.min(parsed.data.startSec, parsed.data.endSec));
			const endMs = toMs(Math.max(parsed.data.startSec, parsed.data.endSec));
			const zoom = {
				id: createId("zoom"),
				startMs,
				endMs,
				depth: parsed.data.depth as 1 | 2 | 3 | 4 | 5 | 6,
				focus: parsed.data.focus,
				focusMode: "manual" as const,
				source: "manual" as const,
			};
			const next: AxcutDocument = {
				...document,
				zoomRanges: [
					...document.zoomRanges,
					...anchorForAgent(zoom, document, "zoom"),
				] as AxcutDocument["zoomRanges"],
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					zoomId: zoom.id,
					startSec: startMs / 1000,
					endSec: endMs / 1000,
					depth: zoom.depth,
				}),
				summary: `added zoom ${formatSec(startMs / 1000)} – ${formatSec(endMs / 1000)}`,
			};
		}

		case "setZoom": {
			const parsed = setZoomArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { zoomId } = parsed.data;
			const existing = document.zoomRanges.find((z) => z.id === zoomId);
			if (!existing) return failure(`Unknown zoom: ${zoomId}`);
			const { startMs, endMs } = resolveSpanMs(existing, parsed.data.startSec, parsed.data.endSec);
			const zoomPill = new Set(resolvePillIds(document.zoomRanges, zoomId));
			const next: AxcutDocument = {
				...document,
				zoomRanges: replacePillSpan(
					// payload edits first, applied to every region under the pill…
					document.zoomRanges.map((z) =>
						zoomPill.has(z.id)
							? {
									...z,
									...(parsed.data.depth !== undefined
										? { depth: parsed.data.depth as 1 | 2 | 3 | 4 | 5 | 6 }
										: {}),
									...(parsed.data.focus ? { focus: parsed.data.focus } : {}),
								}
							: z,
					),
					// …then the span: clamped against different-property pills, then re-ventilated.
					zoomId,
					startMs,
					endMs,
					document.timeline.clips,
					() => createId("zoom"),
				) as AxcutDocument["zoomRanges"],
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ zoomId, startSec: startMs / 1000, endSec: endMs / 1000 }),
				summary: `updated zoom ${formatSec(startMs / 1000)} – ${formatSec(endMs / 1000)}`,
			};
		}

		case "addSpeed": {
			const parsed = addSpeedArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const startMs = toMs(Math.min(parsed.data.startSec, parsed.data.endSec));
			const endMs = toMs(Math.max(parsed.data.startSec, parsed.data.endSec));
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = (legacy.speedRegions as unknown[] | undefined) ?? [];
			const region = { id: createId("speed"), startMs, endMs, speed: parsed.data.speed };
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					speedRegions: [...prev, ...anchorForAgent(region, document, "speed")],
				},
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					speedId: region.id,
					startSec: startMs / 1000,
					endSec: endMs / 1000,
					speed: region.speed,
				}),
				summary: `added ${parsed.data.speed}× speed ${formatSec(startMs / 1000)} – ${formatSec(endMs / 1000)}`,
			};
		}

		case "setSpeed": {
			const parsed = setSpeedArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev =
				(legacy.speedRegions as
					| Array<{ id: string; startMs: number; endMs: number; speed: number }>
					| undefined) ?? [];
			const existing = prev.find((s) => s.id === parsed.data.speedId);
			const speedPill = new Set(resolvePillIds(prev, parsed.data.speedId));
			if (!existing) return failure(`Unknown speed region: ${parsed.data.speedId}`);
			const { startMs, endMs } = resolveSpanMs(existing, parsed.data.startSec, parsed.data.endSec);
			const speed = parsed.data.speed ?? existing.speed;
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					speedRegions: replacePillSpan(
						prev.map((s) => (speedPill.has(s.id) ? { ...s, speed } : s)),
						parsed.data.speedId,
						startMs,
						endMs,
						document.timeline.clips,
						() => createId("speed"),
					),
				},
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					speedId: parsed.data.speedId,
					startSec: startMs / 1000,
					endSec: endMs / 1000,
					speed,
				}),
				summary: `updated speed to ${speed}×`,
			};
		}

		case "addAnnotation": {
			const parsed = addAnnotationArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const startMs = toMs(Math.min(parsed.data.startSec, parsed.data.endSec));
			const endMs = toMs(Math.max(parsed.data.startSec, parsed.data.endSec));
			const ann = {
				id: createId("ann"),
				startMs,
				endMs,
				type: "text" as const,
				content: parsed.data.text,
				textContent: parsed.data.text,
				position: { x: parsed.data.x, y: parsed.data.y },
				size: { width: 30, height: 20 },
				style: {
					color: "#ffffff",
					backgroundColor: "transparent",
					fontSize: 32,
					fontFamily: "Inter",
					fontWeight: "bold" as const,
					fontStyle: "normal" as const,
					textDecoration: "none" as const,
					textAlign: "center" as const,
				},
				zIndex: document.annotations.length + 1,
			};
			const next: AxcutDocument = {
				...document,
				annotations: [
					...document.annotations,
					...anchorForAgent(ann, document, "ann"),
				] as AxcutDocument["annotations"],
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					annotationId: ann.id,
					startSec: startMs / 1000,
					endSec: endMs / 1000,
				}),
				summary: `added annotation "${parsed.data.text.slice(0, 24)}"`,
			};
		}

		case "setAnnotation": {
			const parsed = setAnnotationArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { annotationId } = parsed.data;
			const existing = document.annotations.find((a) => a.id === annotationId);
			const annPill = new Set(resolvePillIds(document.annotations, annotationId));
			if (!existing) return failure(`Unknown annotation: ${annotationId}`);
			const { startMs, endMs } = resolveSpanMs(existing, parsed.data.startSec, parsed.data.endSec);
			const next: AxcutDocument = {
				...document,
				annotations: replacePillSpan(
					document.annotations.map((a) =>
						annPill.has(a.id)
							? {
									...a,
									...(parsed.data.text !== undefined
										? { content: parsed.data.text, textContent: parsed.data.text }
										: {}),
								}
							: a,
					),
					annotationId,
					startMs,
					endMs,
					document.timeline.clips,
					() => createId("ann"),
				),
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					annotationId,
					startSec: startMs / 1000,
					endSec: endMs / 1000,
				}),
				summary: `updated annotation ${formatSec(startMs / 1000)} – ${formatSec(endMs / 1000)}`,
			};
		}

		default:
			return failure(`Unknown tool: ${name}`);
	}
}
