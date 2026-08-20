// OPENSCREEN_SYMBOL_FLOOR=host relaxes the one guard that keeps a Linux package
// startable on the distros the README claims. That is the right trade for a developer
// building for their own machine and a shipping bug anywhere else, so the two refusals
// that keep it local — an unknown value, and CI — are tested rather than trusted.
//
// Neither needs a payload to scan: resolveSymbolCeiling() decides from the environment
// alone, which is why it is the seam this file pokes at. The comparison it feeds is
// exercised for real by every `npm run build:linux`.
//
// The mode is read once at module load, so each case re-requires before-pack.cjs with a
// different environment instead of mutating state on an already-loaded copy.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const BEFORE_PACK = path.join(path.dirname(fileURLToPath(import.meta.url)), "before-pack.cjs");

/**
 * Run `body` against a fresh copy of before-pack.cjs loaded under `env`.
 *
 * The environment has to stay set for the call and not just the require: the mode is
 * captured at module load, but the CI check reads process.env when it runs, and a
 * helper that restored before handing back made that refusal look absent.
 */
function withEnv(env, body) {
	const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		delete require.cache[require.resolve(BEFORE_PACK)];
		return body(require(BEFORE_PACK).__testing);
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("symbol-version ceiling", () => {
	it("uses the pinned floor when OPENSCREEN_SYMBOL_FLOOR is unset", () => {
		withEnv({ OPENSCREEN_SYMBOL_FLOOR: undefined, CI: undefined }, (t) => {
			const { ceiling, pinned } = t.resolveSymbolCeiling();

			expect(pinned).toBe(true);
			expect(ceiling).toBe(t.MAX_SYMBOL_VERSION);
		});
	});

	it("refuses an unknown value rather than guessing enforce or waive", () => {
		withEnv({ OPENSCREEN_SYMBOL_FLOOR: "yes-please", CI: undefined }, (t) => {
			expect(() => t.resolveSymbolCeiling()).toThrow(/not a value this guard knows/);
		});
	});

	it("refuses host mode under CI, so it cannot reach a published artifact", () => {
		withEnv({ OPENSCREEN_SYMBOL_FLOOR: "host", CI: "true" }, (t) => {
			expect(() => t.resolveSymbolCeiling()).toThrow(/refused under CI/);
		});
	});

	// Reads this machine's own libc/libstdc++, so it asserts shape rather than values:
	// every prefix the pinned floor names came back, and each one is a version this run
	// actually parsed out of an ELF.
	//
	// Deliberately NOT asserted: that the host ceiling is at least the pinned one. Host
	// mode substitutes, it does not raise — on a distro OLDER than the floor the ceiling
	// legitimately comes back lower, which makes the check stricter rather than weaker.
	// Requiring otherwise would fail this test on a correct machine.
	it.runIf(process.platform === "linux")("takes the ceiling from this machine in host mode", () => {
		withEnv({ OPENSCREEN_SYMBOL_FLOOR: "host", CI: undefined }, (t) => {
			const { ceiling, pinned } = t.resolveSymbolCeiling();

			expect(pinned).toBe(false);
			expect(ceiling).not.toBe(t.MAX_SYMBOL_VERSION);
			expect(Object.keys(ceiling).sort()).toEqual(Object.keys(t.MAX_SYMBOL_VERSION).sort());
			for (const [prefix, version] of Object.entries(ceiling)) {
				expect(version, `${prefix} came back as ${JSON.stringify(version)}`).toMatch(
					/^\d+(\.\d+)*$/,
				);
			}
		});
	});
});
