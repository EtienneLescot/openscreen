// ponytail: explicit imports, not a glob. The CLI is bundled with esbuild, and
// a dynamic `import(dir + name)` would resolve at runtime against a path that
// does not exist inside the bundle. An explicit list also means a malformed
// scenario fails at import — before a paid live run starts, not halfway in.

import { defineScenario, type Scenario } from "../lib/scenario";
import cameraWithoutTrack, { cameraWithTrack } from "./camera-track.scn";
import consent from "./consent.scn";
import cursorQuestion, { cursorBlind } from "./cursor-question.scn";
import cutSilencesClean from "./cut-silences-clean.scn";
import describeProject from "./describe-project.scn";
import describeZooms, { describeZoomsMigrated } from "./describe-zooms.scn";
import noInventedBounds from "./no-invented-bounds.scn";
import outOfScopeStyling from "./out-of-scope-styling.scn";
import realWizardEnhance, {
	realCutSilences,
	realZoomGrounding,
	realZooms,
} from "./real-screencast.scn";
import removeOneModifier from "./remove-one-modifier.scn";
import reorderClips from "./reorder-clips.scn";
import targetRightClip from "./target-right-clip.scn";
import wizardEnhance from "./wizard-enhance.scn";
import wizardEnhanceBare from "./wizard-enhance-bare.scn";

// ponytail: ordered by what they interrogate, not alphabetically — the report
// prints them in this order and reads as an argument when they are grouped.
// Known defects first (they set the reader's expectations), then the
// environment-understanding probes, then the healthy controls that prove a
// green line is reachable at all. A pack that is red top to bottom stops
// carrying information.
export const SCENARIOS: Scenario[] = [
	// Recorded defects — D1, D2, D3.
	wizardEnhance,
	wizardEnhanceBare,
	cursorQuestion,
	cursorBlind,
	describeZooms,
	describeZoomsMigrated,
	consent,
	// Environment understanding: what does the model believe it is looking at?
	describeProject,
	cameraWithoutTrack,
	cameraWithTrack,
	noInventedBounds,
	outOfScopeStyling,
	reorderClips,
	// Editorial quality: is the MONTAGE any good, not just the JSON?
	cutSilencesClean,
	// …and the same questions on material the workbench did not write.
	realWizardEnhance,
	realCutSilences,
	realZooms,
	realZoomGrounding,
	// Controls: reachable, and expected green.
	targetRightClip,
	removeOneModifier,
];

/** Guards against two scenarios claiming the same id — their baselines,
 * cassettes and report sections are all keyed by it. */
function assertUniqueIds(scenarios: Scenario[]): void {
	const seen = new Set<string>();
	for (const scenario of scenarios) {
		if (seen.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
		seen.add(scenario.id);
	}
}
assertUniqueIds(SCENARIOS);

export function allScenarios(): Scenario[] {
	return SCENARIOS;
}

export function getScenario(id: string): Scenario {
	const found = SCENARIOS.find((s) => s.id === id);
	if (!found) {
		throw new Error(`unknown scenario: ${id} (connus: ${SCENARIOS.map((s) => s.id).join(", ")})`);
	}
	return found;
}

/** Selects by id and/or tag. An empty selection returns everything. */
export function selectScenarios(options: { ids?: string[]; tags?: string[] }): Scenario[] {
	const ids = options.ids ?? [];
	const tags = options.tags ?? [];
	if (ids.length === 0 && tags.length === 0) return allScenarios();
	// Validate ids eagerly: a typo should say so, not silently run nothing.
	for (const id of ids) getScenario(id);
	return SCENARIOS.filter((s) => ids.includes(s.id) || s.tags.some((tag) => tags.includes(tag)));
}

export { defineScenario };
