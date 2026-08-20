// L0 — the oracles have to catch the defects the cartography reproduced by
// hand. A workbench whose oracles miss them measures nothing.

import { describe, expect, it } from "vitest";
import { executeAgentTool } from "../../electron/ai-edition/agent-tools";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { recordingWithSilences, singleClip, twoClipsWithTrim } from "../lib/fixtures";
import {
	assetDuration,
	classifyFailure,
	compressedDurationSec,
	diffMatches,
	documentInvariants,
	unplayableRegions,
} from "../lib/oracles";
import { EMPTY_RESPONSE_ERROR, LANGCHAIN_SCHEMA_ERROR } from "../lib/prompts";
import type { WireCall } from "../lib/wire";

/** Runs a tool exactly as the agent loop would, and returns both the new
 * document and the wire-shaped call it produced. */
function apply(
	document: AxcutDocument,
	name: string,
	args: unknown,
): { document: AxcutDocument; call: WireCall } {
	const argsJson = JSON.stringify(args);
	const execution = executeAgentTool(document, name, argsJson);
	return {
		document: execution.document ?? document,
		call: {
			round: 0,
			id: `call_${name}`,
			name,
			argsJson,
			args,
			mutating: true,
			resultJson: execution.resultJson,
			resultOk: execution.ok,
		},
	};
}

describe("compressedDurationSec", () => {
	it("is the played length, not the ruler length", () => {
		// The fixture's trim removes 5 s of a 60 s recording. The ruler still
		// reads 60; playback runs for 55. The model is told the effect time-base
		// is the latter and the code means the former.
		const doc = twoClipsWithTrim();
		expect(assetDuration(doc)).toBe(60);
		expect(compressedDurationSec(doc)).toBeCloseTo(55, 5);
	});
});

describe("unplayableRegions", () => {
	it("catches a zoom stored beyond the timeline (DSL-2)", () => {
		// The oracle is tested on a document built by hand, NOT through the tool:
		// `addZoom` now refuses this span (see below), but the region shape is
		// still reachable — a v4 project migrating against a zero-extent clip
		// keeps its unanchored regions by design (timelineMap.ts:360-375). An
		// oracle that only fires on what today's executor happens to produce
		// stops being an oracle the moment the executor changes.
		const base = singleClip();
		const document = documentSchema.parse({
			...base,
			zoomRanges: [
				{
					id: "zoom_far",
					startMs: 120_000,
					endMs: 130_000,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
					focusMode: "manual",
					source: "manual",
				},
			],
		});
		expect(unplayableRegions(document).map((r) => r.kind)).toEqual(["zoom"]);
	});

	it("no longer has to: the tool refuses a span that covers no clip", () => {
		// D-HONEST. `addZoom 120→130` on a 24.7 s recording used to answer ok:true
		// with "added zoom 2:00.0 – 2:10.0" and store a region that can never
		// play. The refusal carries the real extent so the model can retry once
		// rather than loop.
		const { document, call } = apply(singleClip(), "addZoom", { startSec: 120, endSec: 130 });
		expect(call.resultOk).toBe(false);
		expect(call.resultJson).toContain("covers no clip");
		expect(call.resultJson).toContain("24.7");
		expect(document.zoomRanges).toEqual([]);
		expect(unplayableRegions(document)).toEqual([]);
	});

	it("leaves a region inside the timeline alone", () => {
		const { document } = apply(singleClip(), "addZoom", { startSec: 3, endSec: 6 });
		expect(unplayableRegions(document)).toEqual([]);
	});

	it("catches a region buried entirely under a trim", () => {
		const base = recordingWithSilences({ durationSec: 62, silences: [[10, 20]] });
		const trimmed = apply(base, "addTrim", { startSec: 10, endSec: 20 }).document;
		const zoomed = apply(trimmed, "addZoom", { startSec: 12, endSec: 15 }).document;
		expect(unplayableRegions(zoomed).map((r) => r.kind)).toEqual(["zoom"]);
	});
});

describe("diffMatches", () => {
	it("accepts a tool whose report matches the document", () => {
		const { document, call } = apply(singleClip(), "addTrim", { startSec: 5, endSec: 8 });
		expect(diffMatches(document, call)).toBe(true);
	});

	it("vérifie CHAQUE élément d'un appel par lot, pas seulement l'enveloppe", () => {
		// Un lot ne porte aucun id au premier niveau : ils sont dans `applied`.
		// Sans la branche qui les lit, ce check rendrait « vrai à vide » sur
		// exactement les appels qui écrivent le plus, et il s'éteindrait sans
		// qu'un seul test devienne rouge.
		const { document, call } = apply(singleClip(), "addTrims", {
			ranges: [
				{ startSec: 2, endSec: 4 },
				{ startSec: 8, endSec: 10 },
			],
		});
		expect(JSON.parse(call.resultJson ?? "{}").appliedCount).toBe(2);
		expect(diffMatches(document, call)).toBe(true);

		// Le même appel dont UN élément ment sur ses bornes doit tomber.
		const lying: WireCall = {
			...call,
			resultJson: JSON.stringify({
				requested: 2,
				appliedCount: 2,
				refusedCount: 0,
				applied: [
					{ index: 0, ...JSON.parse(call.resultJson ?? "{}").applied[0] },
					{ index: 1, trimRangeId: "trim_nope", startSec: 30, endSec: 40 },
				],
			}),
		};
		expect(diffMatches(document, lying)).toBe(false);
	});

	it("catches a report about a region the document does not carry", () => {
		// The shape of DSL-4 and of a silently re-derived-away region: the tool
		// answers with the bounds it was ASKED for, the document says otherwise.
		const doc = singleClip();
		const call: WireCall = {
			round: 0,
			id: "c1",
			name: "setZoom",
			argsJson: "{}",
			args: {},
			mutating: true,
			resultJson: JSON.stringify({ zoomId: "zoom_ghost", startSec: 0, endSec: 20 }),
			resultOk: true,
		};
		expect(diffMatches(doc, call)).toBe(false);
	});

	it("catches bounds that were clamped on the way in", () => {
		const { document } = apply(singleClip(), "addZoom", { startSec: 2, endSec: 6 });
		const zoomId = document.zoomRanges[0].id;
		const lying: WireCall = {
			round: 0,
			id: "c1",
			name: "setZoom",
			argsJson: "{}",
			args: {},
			mutating: true,
			resultJson: JSON.stringify({ zoomId, startSec: 0, endSec: 20 }),
			resultOk: true,
		};
		expect(diffMatches(document, lying)).toBe(false);
	});

	it("stays silent when there is nothing to falsify", () => {
		const doc = singleClip();
		const readOnly: WireCall = {
			round: 0,
			id: "c1",
			name: "getCurrentDocument",
			argsJson: "{}",
			args: {},
			mutating: false,
			resultJson: "{}",
			resultOk: true,
		};
		expect(diffMatches(doc, readOnly)).toBe(true);
	});
});

describe("documentInvariants", () => {
	it("passes a healthy document", () => {
		expect(documentInvariants(twoClipsWithTrim())).toEqual([]);
		expect(documentInvariants(singleClip())).toEqual([]);
	});

	it("catches a gap between clips that resequenceClips would never leave", () => {
		const doc = twoClipsWithTrim();
		const broken = {
			...doc,
			timeline: {
				...doc.timeline,
				clips: [
					doc.timeline.clips[0],
					{ ...doc.timeline.clips[1], timelineStartSec: 40, timelineEndSec: 70 },
				],
			},
		} as AxcutDocument;
		expect(documentInvariants(broken).map((v) => v.rule)).toContain("clips.contiguous");
	});

	it("validates the legacyEditor collections the schema does not look at", () => {
		// legacyEditorSchema is z.object({}).passthrough(), so this document is
		// perfectly schema-valid with a negative speed.
		const doc = singleClip();
		const broken = documentSchema.parse({
			...doc,
			legacyEditor: { speedRegions: [{ id: "sp_1", startMs: 0, endMs: 1000, speed: -2 }] },
		});
		expect(documentSchema.safeParse(broken).success).toBe(true);
		expect(documentInvariants(broken).map((v) => v.rule)).toContain("legacy.speed-positive");
	});

	it("catches duplicate ids of the kind replaceTimeline mints (DSL-8)", () => {
		const doc = singleClip();
		const broken = {
			...doc,
			timeline: {
				...doc.timeline,
				clips: [doc.timeline.clips[0], { ...doc.timeline.clips[0] }],
			},
		} as AxcutDocument;
		expect(documentInvariants(broken).map((v) => v.rule)).toContain("ids.unique");
	});
});

describe("classifyFailure", () => {
	it("separates the model's bad DSL from a mute provider", () => {
		// Both surface to the user as "Empty response from model": a zod
		// rejection kills the turn in deep-agent/service.ts:288-312 and
		// chat-service.ts:362-372 relabels it. Only the inner substring tells
		// them apart, which is why this test locks the substring itself.
		expect(
			classifyFailure({
				ok: false,
				error: `${EMPTY_RESPONSE_ERROR} (Error invoking tool 'addZoom': ${LANGCHAIN_SCHEMA_ERROR})`,
			}),
		).toBe("INVALID_DSL");
		expect(classifyFailure({ ok: false, error: `${EMPTY_RESPONSE_ERROR} (error=)` })).toBe(
			"EMPTY_TEXT",
		);
		expect(classifyFailure({ ok: false, error: "workbench timeout after 120000 ms" })).toBe(
			"TIMEOUT",
		);
		expect(classifyFailure({ ok: false, error: "fetch failed: ECONNREFUSED" })).toBe("TRANSPORT");
		expect(classifyFailure({ ok: true })).toBe("NONE");
	});
});
