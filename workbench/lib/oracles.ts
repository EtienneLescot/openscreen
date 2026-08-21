// ponytail: the truth about what an edit DID is the document, never the tool's
// own `resultJson` and never the sink.
//
// `agent-tools.ts` returns the bounds the model ASKED for, not the ones that
// landed: `setZoom 0→20` clipped by the repel rule to 0→10 still reports
// `{"startSec":0,"endSec":20}` (:824, and the same at :889, :975, :1040, :782).
// Scoring "did the model describe what it did?" against those returns would
// grade it on a lie it was handed. Hence `diffMatches`: resultJson vs the real
// before→after diff.

import { isMutatingTool } from "../../electron/ai-edition/agent-tools";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { projectRegionsToSource } from "../../src/lib/ai-edition/timeline/timelineMap";
import {
	cutBalance,
	type EditScope,
	legacyRegions,
	ORPHAN_MAX_SEC,
	orphanFragments,
	outOfScopeCalls,
	outOfScopeEdits,
	playbackSegments,
	regionFamilies,
	speechDamage,
	trimMargins,
	zoomIssues,
} from "./editorial";
import { isPhantomTool, LANGCHAIN_SCHEMA_ERROR } from "./prompts";
import {
	type CoverageOptions,
	cutPrecision,
	type PauseOptions,
	pauses,
	type ScopeRequest,
	scopeBreaches,
	silenceCoverage,
	speechDamageDetail,
	type TruthZone,
	type ZoomPlacementOptions,
	zoomPlacement,
} from "./quality";
import type { EvalContext, FailureClass } from "./scenario";
import type { WireCall, WireTranscript } from "./wire";

const EPSILON_SEC = 0.002;

// ponytail: the document geometry moved to `editorial.ts` so the import stays
// one-way — the editorial oracles need `playbackSegments`, and this module
// needs the editorial oracles for `buildEvalContext`. Re-exported because the
// two names are part of this module's published surface.
export { playbackSegments, type Region, regionFamilies } from "./editorial";

/**
 * Total time the edit actually plays for. The model is never told this number
 * and cannot derive it without redoing the trim arithmetic — yet the written
 * contract (`agent-tools.ts:536-537`, `deep-agent/service.ts:61`) tells it that
 * effect times are measured on this compressed base, while the code anchors
 * them in RAW virtual time. Every check that quotes a duration needs both.
 */
export function compressedDurationSec(document: AxcutDocument): number {
	return playbackSegments(document).reduce(
		(total, seg) => total + Math.max(0, seg.timelineEndSec - seg.timelineStartSec),
		0,
	);
}

/**
 * Regions stored in the document that playback will never emit — the only way
 * to catch DSL-2, where `addZoom 120→130` on a 60 s timeline answers `ok:true`,
 * "added zoom 2:00.0 – 2:10.0", and lands a region nothing will ever render.
 */
export function unplayableRegions(document: AxcutDocument): Array<{ kind: string; id: string }> {
	const segments = playbackSegments(document);
	// With no visible segments at all there is no layout to resolve against and
	// `projectRegionsToSource` passes everything through; calling those regions
	// unplayable would be an artefact of an empty timeline, not of the model.
	if (segments.length === 0) return [];
	const dead: Array<{ kind: string; id: string }> = [];
	let counter = 0;
	// ponytail: `projectRegionsToSource` mints an id for every copy after the
	// first when a region straddles two kept segments. The ids are thrown away
	// here — only membership matters — but they must stay distinct.
	const nextId = () => {
		counter += 1;
		return `wb_projected_${counter}`;
	};
	for (const family of regionFamilies(document)) {
		if (family.regions.length === 0) continue;
		const projected = projectRegionsToSource(
			family.regions,
			segments,
			document.timeline.clips,
			nextId,
		);
		const alive = new Set(projected.map((r) => r.id));
		for (const region of family.regions) {
			// A zero-length span is stored and listed but can never play either.
			if (!alive.has(region.id) || region.endMs <= region.startMs) {
				dead.push({ kind: family.kind, id: region.id });
			}
		}
	}
	return dead;
}

export interface Violation {
	rule: string;
	detail: string;
}

/**
 * The invariants the schema does NOT cover. `documentSchema` only checks shapes
 * and `end >= start`; it says nothing about clip layout, about regions staying
 * inside their clip's source window, and NOTHING AT ALL about `legacyEditor`,
 * which is a `z.object({}).passthrough()` — so speed and camera-fullscreen
 * regions reach disk entirely unvalidated.
 */
export function documentInvariants(document: AxcutDocument): Violation[] {
	const violations: Violation[] = [];

	// 1. Clips: sorted, contiguous, non-overlapping (`resequenceClips`).
	const clips = [...document.timeline.clips].sort(
		(a, b) => a.timelineStartSec - b.timelineStartSec,
	);
	let cursor = 0;
	for (const [index, clip] of clips.entries()) {
		if (Math.abs(clip.timelineStartSec - cursor) > EPSILON_SEC) {
			violations.push({
				rule: "clips.contiguous",
				detail: `clip ${clip.id} starts at ${clip.timelineStartSec}, expected ${cursor}`,
			});
		}
		if (clip.timelineEndSec < clip.timelineStartSec) {
			violations.push({ rule: "clips.ordered", detail: `clip ${clip.id} ends before it starts` });
		}
		if (index > 0 && clip.timelineStartSec < clips[index - 1].timelineEndSec - EPSILON_SEC) {
			violations.push({
				rule: "clips.no-overlap",
				detail: `clip ${clip.id} overlaps its left neighbour`,
			});
		}
		cursor = clip.timelineEndSec;
	}

	// 2. Anchored regions stay inside their clip's source window
	//    (`rederiveRegionMs` drops them otherwise, silently).
	const clipById = new Map(document.timeline.clips.map((c) => [c.id, c]));
	for (const family of regionFamilies(document)) {
		for (const region of family.regions) {
			if (region.clipId === undefined) continue;
			const clip = clipById.get(region.clipId);
			if (!clip) {
				violations.push({
					rule: "regions.anchor-exists",
					detail: `${family.kind} ${region.id} anchors to missing clip ${region.clipId}`,
				});
				continue;
			}
			const start = region.sourceStartSec ?? 0;
			const end = region.sourceEndSec ?? start;
			const clipEnd = clip.sourceEndSec ?? clip.sourceStartSec;
			if (start < clip.sourceStartSec - EPSILON_SEC || end > clipEnd + EPSILON_SEC) {
				violations.push({
					rule: "regions.anchor-in-window",
					detail:
						`${family.kind} ${region.id} spans source ${start}-${end}, ` +
						`outside clip ${clip.id} ${clip.sourceStartSec}-${clipEnd}`,
				});
			}
		}
	}

	// 3. Hand validation of the two unvalidated legacyEditor collections.
	for (const region of legacyRegions(document, "speedRegions")) {
		const speed = (region as unknown as { speed?: unknown }).speed;
		if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) {
			violations.push({
				rule: "legacy.speed-positive",
				detail: `speed region ${region.id} carries speed=${JSON.stringify(speed)}`,
			});
		}
	}
	for (const family of ["speedRegions", "cameraFullscreenRegions"]) {
		for (const region of legacyRegions(document, family)) {
			if (typeof region.id !== "string" || !region.id) {
				violations.push({ rule: "legacy.id", detail: `${family} entry without an id` });
			}
			if (
				typeof region.startMs !== "number" ||
				typeof region.endMs !== "number" ||
				region.endMs < region.startMs
			) {
				violations.push({
					rule: "legacy.span",
					detail: `${family} ${String(region.id)} has span ${region.startMs}-${region.endMs}`,
				});
			}
		}
	}

	// 4. Ids stay unique per family. `replaceTimeline` used to mint `clip_1..N`
	//    and `trim_1..N` by hand (DSL-8) instead of going through `createId`;
	//    it now reuses the id of any clip an interval reproduces exactly and
	//    mints the rest, which is what makes uniqueness worth checking — a
	//    positional scheme mixed with preserved ids collides by construction.
	const seen = new Map<string, Set<string>>();
	const collect = (family: string, ids: string[]) => {
		const bucket = seen.get(family) ?? new Set<string>();
		for (const id of ids) {
			if (bucket.has(id)) {
				violations.push({ rule: "ids.unique", detail: `duplicate ${family} id ${id}` });
			}
			bucket.add(id);
		}
		seen.set(family, bucket);
	};
	collect(
		"clip",
		document.timeline.clips.map((c) => c.id),
	);
	collect(
		"trim",
		document.timeline.trimRanges.map((t) => t.id),
	);
	for (const family of regionFamilies(document)) {
		collect(
			family.kind,
			family.regions.map((r) => r.id),
		);
	}

	// 5. The document must survive a structured clone — the renderer receives it
	//    over IPC, which the workbench does not exercise otherwise.
	try {
		structuredClone(document);
	} catch (error) {
		violations.push({ rule: "document.clonable", detail: String(error) });
	}

	return violations;
}

const ID_KEYS = [
	"zoomId",
	"trimRangeId",
	"speedId",
	"annotationId",
	"cameraFullscreenId",
	"clipId",
] as const;

interface Span {
	startSec: number;
	endSec: number;
}

function spanOfId(document: AxcutDocument, id: string): Span | null {
	for (const trim of document.timeline.trimRanges) {
		if (trim.id === id) return { startSec: trim.startSec, endSec: trim.endSec };
	}
	for (const clip of document.timeline.clips) {
		if (clip.id === id) {
			return { startSec: clip.sourceStartSec, endSec: clip.sourceEndSec ?? clip.sourceStartSec };
		}
	}
	for (const family of regionFamilies(document)) {
		for (const region of family.regions) {
			if (region.id === id) return { startSec: region.startMs / 1000, endSec: region.endMs / 1000 };
		}
	}
	return null;
}

/**
 * Does the tool's own report survive contact with the document?
 *
 * Vacuously true when there is nothing to falsify (no id, no bounds, an errored
 * call, a read-only call). False when the result names bounds the document does
 * not carry — the repel clamp (DSL-4), the multi-clip pill amputation (DSL-1),
 * and a silently dropped region (invariant 2) all land here.
 */
export function diffMatches(after: AxcutDocument, call: WireCall): boolean {
	if (!call.mutating || !call.resultOk || call.resultJson === undefined) return true;
	let result: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(call.resultJson);
		if (!parsed || typeof parsed !== "object") return true;
		result = parsed as Record<string, unknown>;
	} catch {
		return true;
	}
	// ponytail: a batch tool (`addTrims`, `addZooms`) reports one entry per
	// element under `applied`, and nothing at the top level this check can
	// falsify. Reading only the envelope would return "vacuously true" for
	// exactly the calls that write the most — the check would go dark without a
	// single test turning red. Every entry has to hold.
	const applied = result.applied;
	if (Array.isArray(applied)) {
		return applied.every((entry) =>
			entry && typeof entry === "object"
				? claimSurvives(after, entry as Record<string, unknown>)
				: true,
		);
	}
	return claimSurvives(after, result);
}

/** One reported write against the document it claims to have produced. */
function claimSurvives(after: AxcutDocument, result: Record<string, unknown>): boolean {
	const idKey = ID_KEYS.find((key) => typeof result[key] === "string");
	if (!idKey) return true;
	const id = result[idKey] as string;
	const claimedStart = result.startSec ?? result.sourceStartSec;
	const claimedEnd = result.endSec ?? result.sourceEndSec;
	if (typeof claimedStart !== "number" || typeof claimedEnd !== "number") return true;
	const actual = spanOfId(after, id);
	// The region the tool says it wrote is not in the document at all: the
	// strongest possible mismatch (a region re-derived out of existence).
	if (!actual) return false;
	return (
		Math.abs(actual.startSec - claimedStart) <= EPSILON_SEC &&
		Math.abs(actual.endSec - claimedEnd) <= EPSILON_SEC
	);
}

export function assetDuration(document: AxcutDocument, assetId?: string): number {
	const wanted = assetId ?? document.project.primaryAssetId ?? document.assets[0]?.id;
	return document.assets.find((a) => a.id === wanted)?.durationSec ?? 0;
}

/**
 * Attributes a failed turn. The discrimination matters because a zod rejection
 * of the MODEL's arguments and a mute provider produce the same user-facing
 * string; without this, an infrastructure hiccup would be scored as bad DSL and
 * a bad emission would be excused as a provider problem.
 */
export function classifyFailure(run: { ok: boolean; error?: string }): FailureClass {
	if (run.ok) return "NONE";
	const error = run.error ?? "";
	if (error.includes(LANGCHAIN_SCHEMA_ERROR)) return "INVALID_DSL";
	if (/workbench timeout/i.test(error)) return "TIMEOUT";
	if (/ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|\b(4\d\d|5\d\d)\b/i.test(error)) {
		return "TRANSPORT";
	}
	return "EMPTY_TEXT";
}

export interface EvalInput {
	answer: string;
	wire: WireTranscript;
	before: AxcutDocument;
	after: AxcutDocument;
	mutated: boolean;
	/**
	 * Le réglage sous lequel le tour a tourné. Par défaut `true`, comme le
	 * produit (`config.allowAgentEdits !== false`).
	 *
	 * ponytail: il est ici parce qu'un check JUGÉ ne peut pas s'en passer et ne
	 * peut pas le retrouver. Le bloc de prompt qui le porte vit dans
	 * `systemBlocks`, et `systemBlocks` ne survit pas au fichier — un check qui
	 * le lirait verrait un tableau vide, ce qui ressemble à « rien n'a été
	 * envoyé ». Le drapeau, lui, EST persisté ; il ne manquait que le chemin
	 * jusqu'au contexte. Sans lui, on demanderait à un juge si l'assistant devait
	 * demander la permission sans lui dire s'il en avait besoin.
	 */
	allowAgentEdits?: boolean;
	run: { ok: boolean; error?: string; ms: number };
}

export function buildEvalContext(input: EvalInput): EvalContext {
	const { wire, before, after } = input;
	return {
		answer: input.answer,
		wire,
		before,
		after,
		mutated: input.mutated,
		allowAgentEdits: input.allowAgentEdits ?? true,
		run: input.run,
		calls: (name) => wire.calls.filter((c) => c.name === name),
		callsToPhantomTools: () => wire.calls.filter((c) => isPhantomTool(c.name)),
		firstIndexOf: (name) => wire.calls.findIndex((c) => c.name === name),
		firstMutatingIndex: () => {
			const index = wire.calls.findIndex((c) => c.mutating);
			return index === -1 ? Number.POSITIVE_INFINITY : index;
		},
		unplayableRegions: () => unplayableRegions(after),
		diffMatches: (call) => diffMatches(after, call),
		assetDuration: (assetId) => assetDuration(after, assetId),
		compressedDurationSec: () => compressedDurationSec(after),
		classifyFailure: () => classifyFailure(input.run),
		// ponytail: the editorial oracles all read before AND after — they measure
		// what the TURN did, not what the document looks like. Wiring them here
		// rather than letting each scenario call the module keeps that pairing
		// impossible to get wrong (an oracle handed `after` twice reports no
		// damage, which is the failure mode that would be hardest to notice).
		speechDamage: () => speechDamage(before, after),
		orphanFragments: (maxSec) => orphanFragments(before, after, maxSec ?? ORPHAN_MAX_SEC),
		trimMargins: () => trimMargins(before, after),
		cutBalance: () => cutBalance(before, after),
		zoomIssues: (options) => zoomIssues(after, options),
		outOfScopeEdits: (scope: EditScope) => outOfScopeEdits(before, after, scope),
		outOfScopeCalls: (allowedTools) => outOfScopeCalls(wire.calls, allowedTools),
		// ponytail: `pauses` is the only one of these that reads `before` ALONE —
		// it describes the material, not the edit. Passing `after` would silently
		// return the pauses that SURVIVED the cut, against which every coverage
		// number is 0 and every check green.
		pauses: (options?: PauseOptions) => pauses(before, options),
		speechDamageDetail: () => speechDamageDetail(before, after),
		cutPrecision: (options?: PauseOptions) => cutPrecision(before, after, options),
		silenceCoverage: (options?: CoverageOptions) => silenceCoverage(before, after, options),
		zoomPlacement: (zones: TruthZone[], options?: ZoomPlacementOptions) =>
			zoomPlacement(after, zones, options),
		scopeBreaches: (scope: ScopeRequest) => scopeBreaches(before, after, wire.calls, scope),
	};
}

/** Convenience for scenarios: did any mutating tool run at all? */
export function anyMutatingCall(wire: WireTranscript): WireCall[] {
	return wire.calls.filter((c) => c.mutating && isMutatingTool(c.name));
}

/** Re-export so scenarios import one module. */
export { documentSchema };
