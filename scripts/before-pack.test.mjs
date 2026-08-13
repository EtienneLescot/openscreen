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

/** Same dotted numeric compare before-pack.cjs uses, so 3.4.9 sorts below 3.4.30. */
function compareVersions(a, b) {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
	}
	return 0;
}

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

	// Reads this machine's own libc/libstdc++, so it asserts the shape and the direction
	// of the swap rather than any particular version: the point is that every prefix the
	// pinned floor names came back, and that a host ceiling is never the stricter one.
	it.runIf(process.platform === "linux")(
		"raises the ceiling to what this machine provides in host mode",
		() => {
			withEnv({ OPENSCREEN_SYMBOL_FLOOR: "host", CI: undefined }, (t) => {
				const { ceiling, pinned } = t.resolveSymbolCeiling();

				expect(pinned).toBe(false);
				expect(Object.keys(ceiling).sort()).toEqual(Object.keys(t.MAX_SYMBOL_VERSION).sort());
				for (const [prefix, pinnedMax] of Object.entries(t.MAX_SYMBOL_VERSION)) {
					expect(
						compareVersions(ceiling[prefix], pinnedMax),
						`${prefix}: host ${ceiling[prefix]} vs floor ${pinnedMax}`,
					).toBeGreaterThanOrEqual(0);
				}
			});
		},
	);
});
