// ponytail: the one fixture the workbench did not write itself.
//
// `lib/fixtures.ts` builds documents from code. That is the right default —
// minimal, deterministic, every field justified — and it has a ceiling: the
// silences, the pointer paths and the words are all ours. A model that learns
// the shape of our generator scores well without understanding anything, and a
// detector tuned against synthetic dwells is graded by the same hand that wrote
// them.
//
// This module loads a REAL take instead: a 66 s screencast the user recorded,
// transcribed by the local Whisper helper, with its own cursor sidecar. Nothing
// is normalised, rounded or tidied on the way in — the document reaches the
// model in the state it has on disk, `originalPath`, absent `cameraTrack` and
// all. Where it comes from — and the single field removed from the sidecar (11
// base64 pointer bitmaps, 112 kB, referenced by id and never decoded) — is in
// `workbench/README.md` § "La prise réelle". `workbench/fixtures/` is gitignored,
// so it holds no README any clone can read; do not point readers into it.
//
// The ground truth of what the user was DOING lives nowhere near here. It
// belongs to the assertions; a scenario that let it reach the model would be
// grading a dictation.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CursorTelemetryReader } from "../../electron/ai-edition/deep-agent/service";
import {
	type AxcutDocument,
	documentSchema,
	migrateRawDocumentToCurrent,
} from "../../src/lib/ai-edition/schema";
import { sidecarCursorReader } from "./harness";

/**
 * ponytail: resolved from `process.cwd()`, which is the repo root for both
 * entry points — vitest (`vitest.workbench.config.ts` sits at the root) and the
 * bundled CLI (`node workbench/.build/cli.cjs`, run from the root by the npm
 * script). `__dirname` would be wrong for exactly one of the two: esbuild
 * collapses this module into `.build/cli.cjs`, so it would resolve to
 * `workbench/.build/`. Same convention as `persist.ts`'s `RUNS_DIR`.
 */
export const FIXTURES_DIR = resolve(process.cwd(), "workbench/fixtures");

const PROJECT_FILE = resolve(FIXTURES_DIR, "real-screencast.openscreen");

/**
 * The path whose `.cursor.json` sidecar holds the telemetry. The MP4 itself is
 * NOT in the repo (73 MB) and is never opened — the sidecar convention only
 * needs the name.
 */
export const REAL_SCREENCAST_VIDEO_PATH = resolve(FIXTURES_DIR, "real-screencast.mp4");

/**
 * What the fixture is, stated once so scenarios and tests can assert against it
 * instead of each re-deriving it from the file.
 *
 * These are facts about the RECORDING, all of them visible to the model through
 * `getCurrentDocument` / `getTranscript` / `getCursorTrack`. Nothing here says
 * what the user was doing.
 */
export const REAL_SCREENCAST = {
	projectId: "proj_0b319172-309f-4cd0-af3c-a3c53f1f4994",
	assetId: "asset_309a9af8-6d82-4705-b62e-c238987e2576",
	durationSec: 66.154,
	/** Whisper, local helper. Segments are all `kind:"speech"`. */
	language: "fr",
	wordCount: 129,
	segmentCount: 129,
	sampleCount: 1521,
	/** Distinct pointer bitmaps the capture used, by id, in the sidecar. */
	shapeCount: 11,
} as const;

function readProjectFile(): unknown {
	try {
		return JSON.parse(readFileSync(PROJECT_FILE, "utf8"));
	} catch (error) {
		// Named, because the two ways this fails — run from the wrong directory,
		// or the fixture never landed — look identical in a stack trace.
		throw new Error(
			`Fixture réelle introuvable ou illisible : ${PROJECT_FILE}\n` +
				"Le banc se lance depuis la racine du dépôt (`npm run wb`).\n" +
				`Cause : ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * The real project document, parsed by the production schema.
 *
 * A FRESH object every call: `runRepetition` mutates the document it is given,
 * and repetitions must not inherit each other's edits. The file is re-read each
 * time (96 kB — cheaper than the risk of a shared reference).
 *
 * `migrateRawDocumentToCurrent` runs first because that is what every other
 * on-disk reader does; the file is already v6, so the chain is a no-op today and
 * the fixture will not rot the day v7 lands.
 */
export function realScreencastDocument(): AxcutDocument {
	return documentSchema.parse(migrateRawDocumentToCurrent(readProjectFile()));
}

/** A reader wired to the fixture's own sidecar — `getCursorTrack` answers
 *  `available: true` with the real trajectory. */
export function realScreencastCursorReader(): CursorTelemetryReader {
	return sidecarCursorReader({ [REAL_SCREENCAST.assetId]: REAL_SCREENCAST_VIDEO_PATH });
}
