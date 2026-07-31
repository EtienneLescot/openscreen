// ponytail: the wiring, end to end — real project file, real sidecar, real
// agent loop, scripted model.
//
// `l0/real-fixture.wb.ts` calls `executeAgentTool` directly, which proves the
// payload and its size but skips everything between a Scenario and that call:
// `defineScenario` accepting `cursorReader`, the runner choosing it over
// `cursorTelemetry`, `runChat` probing every asset before building the tools.
// Each of those is a place a reader can be dropped silently, and a dropped
// reader does not crash — it answers "unavailable", which reads like an honest
// limitation and is a lie about a sidecar sitting right there.
//
// No scenario is registered on this fixture yet: the checks that would score it
// need the ground truth of what the user was doing, which lives on the
// assertion side and nowhere else.

import { describe, expect, it } from "vitest";
import {
	REAL_SCREENCAST,
	realScreencastCursorReader,
	realScreencastDocument,
} from "../lib/real-fixture";
import { runRepetition } from "../lib/runner";
import { defineScenario, pass } from "../lib/scenario";

const scenario = defineScenario({
	id: "real-fixture-wiring",
	title: "câblage — la vraie trajectoire traverse-t-elle la boucle d'agent ?",
	tags: ["wiring"],
	prompt: "What cursor or pointer tracking data does this project contain?",
	document: () => realScreencastDocument(),
	cursorReader: () => realScreencastCursorReader(),
	gate: 0,
	behaviour: [{ id: "beh.noop", weight: 1, check: () => pass() }],
	dsl: [{ id: "dsl.noop", weight: 1, check: () => pass() }],
	demoScript: [
		{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
		{ kind: "text", text: "Pointer telemetry is present for this recording." },
	],
});

describe("la fixture réelle dans la boucle d'agent", () => {
	it("livre la vraie trajectoire à getCursorTrack, pas 'unavailable'", async () => {
		const result = await runRepetition({ scenario });
		expect(result.run.ok).toBe(true);

		const call = result.run.wire.calls.find((c) => c.name === "getCursorTrack");
		expect(call?.resultOk).toBe(true);
		const payload = JSON.parse(call?.resultJson ?? "{}");
		expect(payload.available).toBe(true);
		expect(payload.reason).toBeUndefined();
		expect(payload.assetId).toBe(REAL_SCREENCAST.assetId);
		expect(payload.sampleCount).toBe(REAL_SCREENCAST.sampleCount);
		expect(payload.pointCount).toBe(148);
		// Le tour ne doit RIEN muter : la question est une question.
		expect(result.run.document).toBeUndefined();
	});

	it("reste sous le transcript — un appel, ~9 k caractères", async () => {
		// Le coût en contexte, mesuré là où il se paie : dans la requête suivante.
		// Le premier tour part à ~17 k (système + 19 définitions d'outils) ; après
		// UN getCursorTrack il en fait ~45 k. Les 24 238 caractères du track en
		// deviennent ~28 000 une fois échappés dans un message d'outil.
		//
		// Ce n'est pas une régression, c'est le prix de la donnée — mais c'est le
		// prix, et un modèle qui rappelle l'outil le paie chaque fois.
		const result = await runRepetition({ scenario });
		const bodies = result.run.requests.map((r) => JSON.stringify(r.raw).length);
		expect(bodies).toHaveLength(2);
		expect(bodies[1] - bodies[0]).toBeGreaterThan(8_000);
		// Le plafond qui sauterait si quelqu'un montait DEFAULT_MAX_TRACK_POINTS
		// sans regarder ce que ça coûte au tour.
		expect(bodies[1]).toBeLessThan(50_000);
	});

	it("annonce la télémétrie dans le snapshot avant même le premier outil", async () => {
		// `probeCursorTelemetry` tourne une fois par asset avant que les outils
		// soient construits. Si le probe du lecteur de sidecar était oublié, ce
		// champ serait `null` — « pas vérifié » — et le modèle n'aurait aucune
		// raison d'appeler getCursorTrack.
		const result = await runRepetition({
			scenario: {
				...scenario,
				demoScript: [
					{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
					{ kind: "text", text: "ok" },
				],
			},
		});
		const snapshot = JSON.parse(
			result.run.wire.calls.find((c) => c.name === "getCurrentDocument")?.resultJson ?? "{}",
		);
		expect(snapshot.assets[0].hasCursorTelemetry).toBe(true);
		// Et le document dit la vérité sur la caméra : le fichier webcam existe sur
		// le disque, la piste n'est pas dans le document.
		expect(snapshot.assets[0].hasCameraTrack).toBe(false);
	});

	it("refuse deux sources de télémétrie pour un même tour", () => {
		expect(() =>
			defineScenario({
				...scenario,
				id: "real-fixture-both",
				cursorTelemetry: () => ({}),
			}),
		).toThrow(/mutually exclusive/);
	});
});
