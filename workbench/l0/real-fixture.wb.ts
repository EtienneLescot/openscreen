// ponytail: what the model ACTUALLY receives from the real fixture, in
// characters.
//
// Every other L0 file checks a shape. This one checks a SIZE, because size is
// the property of the telemetry path that nothing else can see: a tool that
// returns 356 points instead of 12 dwell moments is right about the data and
// still capable of eating a turn's context. The number is asserted rather than
// bounded so that any change to `buildCursorTrack`, to `timeBase`, or to the
// point shape shows up here as a diff instead of drifting quietly upward.
//
// If `getCursorTrack` on 66 s of capture ever crosses ~25 000 characters, that
// is a finding to report — not a reason to reach for a coarser default and move
// on. The whole point of the track over the digest is that the model gets the
// observation; trimming it silently is how the digest got here.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeAgentTool } from "../../electron/ai-edition/agent-tools";
import type { CursorTrack } from "../../src/lib/ai-edition/timeline/cursor-track";
import { sidecarCursorReader } from "../lib/harness";
import {
	REAL_SCREENCAST,
	realScreencastCursorReader,
	realScreencastDocument,
} from "../lib/real-fixture";

/** The exact payload `getCursorTrack` puts on the wire for this fixture. */
async function trackResult(): Promise<{ json: string; track: CursorTrack & { available: true } }> {
	const document = realScreencastDocument();
	const load = await realScreencastCursorReader().read({
		assetId: REAL_SCREENCAST.assetId,
		originalPath: document.assets[0].originalPath ?? null,
	});
	const execution = executeAgentTool(document, "getCursorTrack", "{}", {
		cursorTelemetry: { load },
	});
	expect(execution.ok).toBe(true);
	return { json: execution.resultJson, track: JSON.parse(execution.resultJson) };
}

describe("la fixture réelle — le document", () => {
	it("charge le vrai projet et le passe par le schéma de production", () => {
		const document = realScreencastDocument();
		expect(document.schemaVersion).toBe(6);
		expect(document.project.id).toBe(REAL_SCREENCAST.projectId);
		expect(document.project.primaryAssetId).toBe(REAL_SCREENCAST.assetId);
		expect(document.assets).toHaveLength(1);
		expect(document.assets[0].durationSec).toBe(REAL_SCREENCAST.durationSec);
		expect(document.timeline.clips).toHaveLength(1);
		expect(document.timeline.clips[0].sourceStartSec).toBe(0);
		expect(document.timeline.clips[0].sourceEndSec).toBe(REAL_SCREENCAST.durationSec);
		// Nothing has been edited yet: whatever a scenario measures is the turn's
		// own doing, not the fixture's.
		expect(document.timeline.trimRanges).toEqual([]);
		expect(document.annotations).toEqual([]);
		expect(document.zoomRanges).toEqual([]);
	});

	it("porte le transcript français avec ses 129 mots horodatés", () => {
		const document = realScreencastDocument();
		const transcript = document.transcripts[0];
		expect(transcript.assetId).toBe(REAL_SCREENCAST.assetId);
		expect(transcript.language).toBe(REAL_SCREENCAST.language);
		expect(transcript.segments).toHaveLength(REAL_SCREENCAST.segmentCount);
		expect(transcript.words).toHaveLength(REAL_SCREENCAST.wordCount);
		// Tous les segments sont de la parole : les silences ne sont PAS stockés,
		// ils se déduisent des écarts. Un modèle ne peut donc pas les recopier.
		expect(transcript.segments.every((s) => s.kind === "speech")).toBe(true);
		expect(transcript.words[0].startSec).toBe(2.33);
		expect(transcript.words.at(-1)?.endSec).toBe(65.97);
	});

	it("n'a PAS de piste caméra dans le document, quoi qu'il y ait sur le disque", () => {
		// Le dossier d'enregistrement contient bien un fichier webcam ; le document
		// écrit par l'app, lui, porte `cameraTrack: null`. La fixture ne corrige
		// pas ça — voir workbench/README.md § « La prise réelle ». Cette assertion
		// existe pour que personne ne « complète » la fixture sans le voir : le modèle
		// verra `hasCameraTrack: false`, et c'est l'état réel du projet.
		expect(realScreencastDocument().assets[0].cameraTrack).toBeNull();
	});

	it("rend un document neuf à chaque appel", () => {
		// `runRepetition` mute le document qu'on lui donne ; deux répétitions ne
		// doivent pas hériter des coupes l'une de l'autre.
		const first = realScreencastDocument();
		const second = realScreencastDocument();
		expect(first).not.toBe(second);
		expect(first.timeline).not.toBe(second.timeline);
		expect(first).toEqual(second);
	});
});

describe("la fixture réelle — le lecteur de télémétrie", () => {
	it("lit le vrai sidecar et répond available:true", async () => {
		const { track } = await trackResult();
		expect(track.available).toBe(true);
		expect(track.assetId).toBe(REAL_SCREENCAST.assetId);
		expect(track.sampleCount).toBe(REAL_SCREENCAST.sampleCount);
		expect(track.shapeCount).toBe(REAL_SCREENCAST.shapeCount);
		expect(track.coveredSec).toBe(66.14);
		expect(track.truncated).toBe(false);
	});

	it("distingue « cet asset n'en a pas » de « je n'ai pas pu regarder »", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wb-sidecar-"));
		// `readCursorRecordingFileAt` journalise le sidecar illisible avant de
		// relancer. On l'attend : c'est la trace qui dit qu'on a VU le fichier.
		const logged = vi.spyOn(console, "error").mockImplementation(() => {
			// avalée : le test l'attend, la sortie de suite n'en a pas besoin
		});
		try {
			const broken = join(dir, "broken.mp4");
			writeFileSync(`${broken}.cursor.json`, "{ not json");
			const reader = sidecarCursorReader({
				absent: join(dir, "nothing-here.mp4"),
				broken,
			});
			// Asset absent de la carte : un fait sur le projet.
			expect(await reader.read({ assetId: "unmapped", originalPath: null })).toEqual({
				status: "no-sidecar",
				assetId: "unmapped",
			});
			// Carte renseignée, aucun fichier : on a regardé, il n'y a rien.
			expect((await reader.read({ assetId: "absent", originalPath: null })).status).toBe(
				"no-sidecar",
			);
			// Fichier présent mais illisible : un fait sur NOUS. Le confondre avec
			// le cas précédent est exactement le défaut que ce chemin corrige.
			const unreadable = await reader.read({ assetId: "broken", originalPath: null });
			expect(unreadable.status).toBe("unavailable");
			expect(await reader.probe({ assetId: "broken", originalPath: null })).toBe(false);
			expect(logged).toHaveBeenCalled();
		} finally {
			logged.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("n'ouvre jamais le chemin que porte le document", async () => {
		// La carte est la seule autorité. Un document qui nomme un autre fichier —
		// ou un fichier qui n'existe pas, ce qui est le cas ici : le MP4 de 73 Mo
		// n'est pas dans le dépôt — ne change rien à ce qui est lu.
		const reader = realScreencastCursorReader();
		const load = await reader.read({
			assetId: REAL_SCREENCAST.assetId,
			originalPath: "/nowhere/at/all.mp4",
		});
		expect(load.status).toBe("ok");
	});
});

describe("la fixture réelle — la taille de ce qui atteint le modèle", () => {
	/** Mesuré, pas prédit. Un changement ici est un changement de ce que le
	 *  modèle lit : mettez le nouveau nombre ET dites pourquoi il a bougé. */
	const TRACK_RESULT_CHARS = 7_797;
	const TRACK_POINTS = 148;
	/** Au-delà, c'est une trouvaille à signaler — pas à faire disparaître en
	 *  baissant `DEFAULT_TRACK_HZ`. */
	const REPORTABLE_CEILING_CHARS = 25_000;

	it("rend 148 points pour 7 797 caractères", async () => {
		const { json, track } = await trackResult();
		expect(track.pointCount).toBe(TRACK_POINTS);
		expect(track.points).toHaveLength(TRACK_POINTS);
		expect(json.length).toBe(TRACK_RESULT_CHARS);
		expect(json.length).toBeLessThan(REPORTABLE_CEILING_CHARS);
	});

	it("ne garde que les keyframes — 1521 échantillons, 148 points", async () => {
		const { track } = await trackResult();
		expect(track.sampleCount).toBe(1521);
		// Aucun trou ne dépasse le plancher d'écart (3 s) : un pointeur immobile se
		// lit « toujours là », jamais « plus de données ».
		const gaps = track.points.slice(1).map((p, i) => p.atSec - track.points[i].atSec);
		expect(Math.max(...gaps)).toBeLessThanOrEqual(3.05);
		// `virtualSec` a disparu des points : la timeline est intacte, l'enveloppe le
		// dit une fois. C'était 28 % du payload, le timestamp répété deux fois.
		expect(track.virtualEqualsSource).toBe(true);
		expect(track.points.every((p) => p.virtualSec === undefined)).toBe(true);
		// Aucun clic dans cette capture : le champ `kind` n'apparaît nulle part.
		expect(track.points.some((p) => p.kind !== undefined)).toBe(false);
	});

	it("reste à parité avec le transcript, plus le poste dominant", async () => {
		const document = realScreencastDocument();
		const transcript = executeAgentTool(document, "getTranscript", "{}", {});
		const snapshot = executeAgentTool(document, "getCurrentDocument", "{}", {
			cursorTelemetry: { availableByAssetId: { [REAL_SCREENCAST.assetId]: true } },
		});
		const { json } = await trackResult();
		expect(transcript.resultJson.length).toBe(10_496);
		expect(snapshot.resultJson.length).toBe(1_602);
		// Il valait 2,3× le transcript avant la réduction en keyframes ; il vaut
		// maintenant moins. Le tour entier fait ~23k caractères — soit ~6k tokens,
		// ce qui n'est PAS ce qui le rend lent : ce sont ses 19 appels en série.
		expect(json.length).toBeLessThan(transcript.resultJson.length);
	});

	it("garde lisible le balayage lent auquel un détecteur d'immobilité est aveugle", async () => {
		const { track } = await trackResult();
		// De 24,1 à 29,2 s l'auteur parcourt une image en la commentant : cy tenu à
		// ±0,04 pendant que cx progresse d'un tiers de l'écran. Un détecteur
		// d'immobilité n'y voit rien — le curseur bouge franchement — alors que les
		// keyframes le rendent en quelques points dont l'interpolation rejoue le reste.
		const sweep = track.points.filter((p) => p.atSec >= 23.5 && p.atSec <= 29.5);
		expect(sweep.length).toBeGreaterThanOrEqual(4);
		const xs = sweep.map((p) => p.cx);
		expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.25);
		const ys = sweep.map((p) => p.cy);
		expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.15);
	});
});
