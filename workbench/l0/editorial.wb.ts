// L0 — the editorial oracles, driven through the REAL tools.
//
// Every document here is produced by `executeAgentTool`, not written by hand:
// an oracle that only ever sees documents its own test authored is measuring
// the test. The one exception is the overlapping-zoom case, which the tools
// cannot produce — the repel rule (`timelineMap.ts:113`) clamps it away, which
// is precisely why an overlap found in a stored document is a defect.
//
// The numbers below are stated as arithmetic, never as a constant copied from a
// run: `2.5` is the silence, `0.5 + 0.5` is the speech a mis-placed cut eats.

import { describe, expect, it } from "vitest";
import { executeAgentTool } from "../../electron/ai-edition/agent-tools";
// ponytail: the pure rebuild, used ONLY for setup and for the one fixture that
// has to reproduce a destruction the tool no longer permits. Everything an
// oracle is asked to judge still comes out of `executeAgentTool`.
import { replaceTimeline } from "../../src/lib/ai-edition/document/timeline";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import {
	addedTrims,
	cutBalance,
	documentDelta,
	orphanFragments,
	outOfScopeCalls,
	outOfScopeEdits,
	silenceSpans,
	speechDamage,
	speechSpans,
	trimMargins,
	zoomIssues,
} from "../lib/editorial";
import {
	DEMO_INTEREST_POINTS,
	fixtureTruth,
	recordingWithSilences,
	recordingWithWordTimings,
	singleClip,
	twoClipsWithTrim,
} from "../lib/fixtures";
import { totalSec } from "../lib/spans";

const SILENCES: Array<[number, number]> = [
	[10, 12.5],
	[31, 36.2],
];
const DURATION_SEC = 62;
const SILENCE_TOTAL_SEC = 2.5 + 5.2;

function recording(withWords = false): AxcutDocument {
	return recordingWithSilences({
		durationSec: DURATION_SEC,
		silences: SILENCES,
		withWords,
	});
}

/** Runs a tool exactly as the agent loop would. */
function apply(document: AxcutDocument, name: string, args: unknown): AxcutDocument {
	const execution = executeAgentTool(document, name, JSON.stringify(args));
	if (!execution.ok) throw new Error(`${name} refusé : ${execution.resultJson}`);
	return execution.document ?? document;
}

describe("speechSpans / silenceSpans", () => {
	it("reads the declared segments when there are no word timings", () => {
		const document = recording();
		expect(speechSpans(document)).toEqual([
			{ startSec: 0, endSec: 10 },
			{ startSec: 12.5, endSec: 31 },
			{ startSec: 36.2, endSec: 62 },
		]);
		expect(silenceSpans(document)).toEqual([
			{ startSec: 10, endSec: 12.5 },
			{ startSec: 31, endSec: 36.2 },
		]);
	});

	it("prefers word timings, which do not reach the segment's edges", () => {
		// The whole point of word timings: a speech SEGMENT runs 12.5 → 31, but
		// the speaker does not talk for all 18.5 s of it. Silence stays declared
		// (the fixture still emits silence segments), speech gets tighter.
		const withWords = recording(true);
		const speech = speechSpans(withWords);
		expect(totalSec(speech)).toBeLessThan(totalSec(speechSpans(recording())));
		expect(speech.length).toBeGreaterThan(3);
	});

	it("derives silence from the gaps when the transcript declares none", () => {
		// A real Whisper transcript carries speech segments only.
		const document = recordingWithWordTimings();
		expect(document.transcripts[0].words.length).toBeGreaterThan(50);
		const silence = silenceSpans(document);
		// The 9.72 → 12.46 pause is the long one and must be found.
		expect(silence.some((s) => s.startSec > 9.5 && s.endSec < 12.6)).toBe(true);
	});
});

describe("speechDamage — the property 'cut the silences' is actually about", () => {
	it("is zero when the cut lands inside the silence", () => {
		const before = recording();
		const after = apply(before, "addTrim", { startSec: 10, endSec: 12.5, reason: "silence" });
		const damage = speechDamage(before, after);
		expect(damage.destroyedSec).toBeCloseTo(0, 6);
		expect(damage.removedSec).toBeCloseTo(2.5, 6);
		expect(damage.spans).toEqual([]);
	});

	it("counts every second of speech a sloppy cut removes", () => {
		// This is the case `dsl.trims.cover-silences` PASSES: it allows ±0.4 s of
		// slop on each edge and never looks at what is inside that slop.
		const before = recording();
		const after = apply(before, "addTrim", { startSec: 9.5, endSec: 13, reason: "silence" });
		const damage = speechDamage(before, after);
		expect(damage.destroyedSec).toBeCloseTo(0.5 + 0.5, 6);
		expect(damage.spans).toEqual([
			{ startSec: 9.5, endSec: 10 },
			{ startSec: 12.5, endSec: 13 },
		]);
	});

	it("sees material lost to a deleted clip, not only to trims", () => {
		// `removeClip` records NO trim: it drops the clip and reflows the
		// timeline. An oracle reading `trimRanges` would report a spotless edit
		// on a turn that deleted two thirds of the recording — which is why the
		// damage is measured on the playback layout instead.
		// Setup only, and through the pure function: `replaceTimeline` the TOOL
		// now refuses to shorten a placed clip out of existence, which is the
		// point of D-DESTRUCT and not the subject of this test.
		const before = replaceTimeline(
			recording(),
			[
				{ startSec: 0, endSec: 20 },
				{ startSec: 22, endSec: 62 },
			],
			"split",
			"agent",
			{ preserveIds: false, preserveTrims: false },
		);
		expect(before.timeline.clips).toHaveLength(2);
		const after = apply(before, "removeClip", { clipId: before.timeline.clips[1].id });
		expect(addedTrims(before, after)).toEqual([]);
		const damage = speechDamage(before, after);
		expect(damage.removedSec).toBeCloseTo(40, 6);
		// Speech between 22→31 and 36.2→62; the 31→36.2 silence is not speech.
		expect(damage.destroyedSec).toBeCloseTo(9 + 25.8, 6);
	});

	it("says whether it is standing on word timings or on segment edges", () => {
		expect(speechDamage(recording(), recording()).fromWordTimings).toBe(false);
		expect(speechDamage(recording(true), recording(true)).fromWordTimings).toBe(true);
	});
});

describe("orphanFragments", () => {
	it("catches the sub-half-second island two cuts leave behind", () => {
		const before = recording();
		const first = apply(before, "addTrim", { startSec: 10, endSec: 12.5, reason: "silence" });
		const after = apply(first, "addTrim", { startSec: 12.8, endSec: 15, reason: "silence" });
		const orphans = orphanFragments(before, after);
		expect(orphans).toHaveLength(1);
		expect(orphans[0].durationSec).toBeCloseTo(0.3, 6);
	});

	it("stays quiet when the cuts leave whole passages", () => {
		const before = recording();
		const after = apply(before, "addTrim", { startSec: 31, endSec: 36.2, reason: "silence" });
		expect(orphanFragments(before, after)).toEqual([]);
	});

	it("does not charge the model for a short fragment it inherited", () => {
		const before = apply(
			apply(recording(), "addTrim", { startSec: 10, endSec: 12.5, reason: "silence" }),
			"addTrim",
			{ startSec: 12.8, endSec: 15, reason: "silence" },
		);
		expect(orphanFragments(before, before)).toEqual([]);
		// …and still catches a NEW one on top of it.
		const after = apply(before, "addTrim", { startSec: 40, endSec: 45, reason: "silence" });
		const later = apply(after, "addTrim", { startSec: 45.4, endSec: 50, reason: "silence" });
		expect(orphanFragments(before, later)).toHaveLength(1);
	});
});

describe("trimMargins", () => {
	it("reports how much silence was left breathing on each edge", () => {
		const before = recording();
		const after = apply(before, "addTrim", { startSec: 10.4, endSec: 12.2, reason: "silence" });
		const [margin] = trimMargins(before, after);
		expect(margin.silence).toEqual({ startSec: 10, endSec: 12.5 });
		expect(margin.leadMarginSec).toBeCloseTo(0.4, 6);
		expect(margin.tailMarginSec).toBeCloseTo(0.3, 6);
		expect(margin.speechEatenSec).toBeCloseTo(0, 6);
	});

	it("goes negative when the cut started inside the speech", () => {
		const before = recording();
		const after = apply(before, "addTrim", { startSec: 9.8, endSec: 12.5, reason: "silence" });
		const [margin] = trimMargins(before, after);
		expect(margin.leadMarginSec).toBeCloseTo(-0.2, 6);
		expect(margin.speechEatenSec).toBeCloseTo(0.2, 6);
	});

	it("reports no silence at all when the cut targets none", () => {
		const before = recording();
		const after = apply(before, "addTrim", { startSec: 2, endSec: 4, reason: "tighten" });
		const [margin] = trimMargins(before, after);
		expect(margin.silence).toBeNull();
		expect(margin.leadMarginSec).toBeNull();
		expect(margin.speechEatenSec).toBeCloseTo(2, 6);
	});

	it("ignores the trims that were already there", () => {
		const before = twoClipsWithTrim();
		expect(trimMargins(before, before)).toEqual([]);
	});
});

describe("cutBalance", () => {
	it("is perfect when both silences are cut and nothing else", () => {
		const before = recording();
		let after = apply(before, "addTrim", { startSec: 10, endSec: 12.5, reason: "silence" });
		after = apply(after, "addTrim", { startSec: 31, endSec: 36.2, reason: "silence" });
		const balance = cutBalance(before, after);
		expect(balance.coverage).toBeCloseTo(1, 6);
		expect(balance.overcutSec).toBeCloseTo(0, 6);
		expect(balance.undercutRatio).toBeCloseTo(0, 6);
	});

	it("splits under-cut from over-cut instead of averaging them", () => {
		// One silence missed entirely, the other cut too wide: a single "accuracy"
		// number would land near the middle and describe neither failure.
		const before = recording();
		const after = apply(before, "addTrim", { startSec: 9.5, endSec: 13, reason: "silence" });
		const balance = cutBalance(before, after);
		expect(balance.silenceBeforeSec).toBeCloseTo(SILENCE_TOTAL_SEC, 6);
		expect(balance.coverage).toBeCloseTo(2.5 / SILENCE_TOTAL_SEC, 6);
		expect(balance.undercutRatio).toBeCloseTo(5.2 / SILENCE_TOTAL_SEC, 6);
		expect(balance.overcutSec).toBeCloseTo(1, 6);
		expect(balance.overcutRatio).toBeCloseTo(1 / 3.5, 6);
	});

	it("reports a spotless balance when nothing was cut at all", () => {
		const before = singleClip();
		const balance = cutBalance(before, before);
		expect(balance.coverage).toBe(1);
		expect(balance.overcutRatio).toBe(0);
	});
});

describe("zoomIssues", () => {
	/** Two zooms the tools would never let coexist — the repel rule clamps one
	 * away — so an overlap in a stored document means something bypassed it. */
	function withOverlappingZooms(): AxcutDocument {
		const document = singleClip({ durationSec: 40 });
		const zoom = (id: string, startSec: number, endSec: number, depth: 3 | 5) => ({
			id,
			startMs: startSec * 1000,
			endMs: endSec * 1000,
			clipId: "clip_1",
			sourceStartSec: startSec,
			sourceEndSec: endSec,
			depth,
			focus: { cx: 0.5, cy: 0.5 },
			focusMode: "manual" as const,
			source: "manual" as const,
		});
		return documentSchema.parse({
			...document,
			zoomRanges: [zoom("zoom_1", 5, 12, 3), zoom("zoom_2", 10, 16, 5)],
		});
	}

	it("catches an overlap the repel rule is about to eat", () => {
		const issues = zoomIssues(withOverlappingZooms());
		expect(issues.filter((i) => i.kind === "overlap")).toHaveLength(1);
		expect(issues[0].ids).toEqual(["zoom_1", "zoom_2"]);
	});

	it("catches a flash and a zoom that has become the framing", () => {
		const flashed = apply(singleClip({ durationSec: 40 }), "addZoom", {
			startSec: 3,
			endSec: 3.2,
			depth: 3,
		});
		expect(zoomIssues(flashed).map((i) => i.kind)).toContain("too-short");

		const held = apply(singleClip({ durationSec: 40 }), "addZoom", {
			startSec: 0,
			endSec: 30,
			depth: 3,
		});
		expect(zoomIssues(held).map((i) => i.kind)).toContain("too-long");
	});

	it("accepts an ordinary zoom", () => {
		const document = apply(singleClip({ durationSec: 40 }), "addZoom", {
			startSec: 8,
			endSec: 14,
			depth: 3,
		});
		expect(zoomIssues(document)).toEqual([]);
	});

	it("judges placement only when the fixture declares interest points", () => {
		const document = apply(recordingWithWordTimings(), "addZoom", {
			startSec: 3,
			endSec: 6,
			depth: 3,
		});
		// No declared interest: silence, not an invented preference.
		expect(zoomIssues(document)).toEqual([]);

		const truth = fixtureTruth(document);
		if (!truth) throw new Error("la fixture doit déclarer ses points d'intérêt");
		expect(truth.interestPoints).toEqual(DEMO_INTEREST_POINTS);
		const judged = zoomIssues(document, { interest: truth.interestPoints });
		expect(judged.filter((i) => i.kind === "missed-interest")).toHaveLength(2);
		expect(judged.filter((i) => i.kind === "unmotivated")).toHaveLength(1);
	});

	it("clears a zoom that sits on a declared moment", () => {
		const document = apply(recordingWithWordTimings(), "addZoom", {
			startSec: 13.5,
			endSec: 15.5,
			depth: 3,
		});
		const issues = zoomIssues(document, { interest: [DEMO_INTEREST_POINTS[0]] });
		expect(issues).toEqual([]);
	});
});

describe("the edit `cut-silences-clean` is looking for", () => {
	// The scenario's demo, replayed through the tools and put to every oracle at
	// once. Two purposes: it proves a green editorial line is REACHABLE (a pack
	// that is red everywhere carries no information), and it pins the fixture —
	// if a future edit to `DEMO_SPEECH_SPANS` breaks the clean edit, this fails
	// here rather than showing up as a mysterious live regression.
	const LONG_PAUSES: Array<[number, number]> = [
		[9.72, 12.46],
		[31.07, 36.29],
	];

	function cut(document: AxcutDocument, pauses: Array<[number, number]>): AxcutDocument {
		let next = document;
		for (const [startSec, endSec] of pauses) {
			next = apply(next, "addTrim", { startSec, endSec, reason: "silence" });
		}
		return next;
	}

	it("passes every editorial oracle when it cuts the two long pauses", () => {
		const before = recordingWithWordTimings();
		const after = cut(before, LONG_PAUSES);
		expect(speechDamage(before, after).destroyedSec).toBeLessThanOrEqual(0.02);
		expect(orphanFragments(before, after)).toEqual([]);
		expect(cutBalance(before, after).overcutSec).toBeLessThanOrEqual(0.02);
		expect(outOfScopeEdits(before, after, { families: ["trim"] })).toEqual([]);
		for (const margin of trimMargins(before, after)) {
			expect(margin.silence).not.toBeNull();
			expect(margin.leadMarginSec ?? -1).toBeGreaterThanOrEqual(-0.02);
			expect(margin.tailMarginSec ?? -1).toBeGreaterThanOrEqual(-0.02);
		}
	});

	it("strands the 0:20 aside when the two breaths around it are cut too", () => {
		// The trap. Every conformity check stays green: valid document, honest
		// trims, silences covered. Only `orphanFragments` sees the stutter.
		const before = recordingWithWordTimings();
		const after = cut(before, [...LONG_PAUSES, [20.18, 20.63], [20.94, 21.42]]);
		expect(documentSchema.safeParse(after).success).toBe(true);
		expect(speechDamage(before, after).destroyedSec).toBeLessThanOrEqual(0.02);
		const orphans = orphanFragments(before, after);
		expect(orphans).toHaveLength(1);
		expect(orphans[0].durationSec).toBeCloseTo(20.94 - 20.63, 6);
	});

	it("sees the damage of a cut placed on the tidy number instead of the pause", () => {
		// 9.5 → 12.5 is what a model reaching for round numbers writes. The
		// silence runs 9.72 → 12.46, so both edges land in a word.
		const before = recordingWithWordTimings();
		const after = cut(before, [[9.5, 12.5]]);
		const damage = speechDamage(before, after);
		expect(damage.fromWordTimings).toBe(true);
		expect(damage.destroyedSec).toBeGreaterThan(0.1);
		const [margin] = trimMargins(before, after);
		expect(margin.leadMarginSec ?? 0).toBeLessThan(0);
	});
});

describe("outOfScopeEdits / outOfScopeCalls — 'and nothing more'", () => {
	it("names the family the request never licensed", () => {
		const before = twoClipsWithTrim();
		const after = apply(before, "addZoom", { startSec: 35, endSec: 40, depth: 3 });
		expect(outOfScopeEdits(before, after, { families: ["trim"] })).toEqual([
			{ family: "zoom", added: [after.zoomRanges[0].id], removed: [], changed: [] },
		]);
		expect(outOfScopeEdits(before, after, { families: ["zoom"] })).toEqual([]);
	});

	it("catches the collateral damage of the reorder workaround", () => {
		// The live failure of 2026-07-31, as a class rather than as one check:
		// asked to swap two clips, the turn destroyed a trim the user had placed.
		//
		// ponytail: the tool refuses this call now, and the pure rebuild preserves
		// the trim, so the damage has to be MANUFACTURED — `preserveIds: false,
		// preserveTrims: false` is precisely the old behaviour. Keeping the
		// historical document as the fixture is the point: the oracle's job is to
		// catch this shape of damage whatever produces it next, and an oracle
		// tested only against inputs the current code can still emit stops being
		// a net the day something else emits them.
		const before = twoClipsWithTrim();
		const after = replaceTimeline(
			before,
			[
				{ startSec: 30, endSec: 60 },
				{ startSec: 0, endSec: 30 },
			],
			"swap",
			"agent",
			{ preserveIds: false, preserveTrims: false },
		);
		const collateral = outOfScopeEdits(before, after, { families: ["clip"] });
		expect(collateral.map((delta) => delta.family)).toEqual(["trim"]);
		expect(collateral[0].removed).toEqual(["trim_1"]);
	});

	it("reports nothing for a turn that changed nothing", () => {
		const document = twoClipsWithTrim();
		expect(documentDelta(document, document)).toEqual([]);
		expect(outOfScopeEdits(document, document, { families: [] })).toEqual([]);
	});

	it("flags a mutating call to a tool outside the licensed set", () => {
		const calls = [
			{ name: "getCurrentDocument", mutating: false },
			{ name: "addTrim", mutating: true },
			{ name: "replaceTimeline", mutating: true },
		];
		expect(outOfScopeCalls(calls, ["addTrim"]).map((c) => c.name)).toEqual(["replaceTimeline"]);
		expect(outOfScopeCalls(calls, ["addTrim", "replaceTimeline"])).toEqual([]);
	});
});
