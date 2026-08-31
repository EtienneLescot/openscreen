// `crates/compositor/build.rs` decides which ffmpeg shared libraries the native addon
// imports. Six places have to agree with that list, and none of them is derived from it:
//
//   - scripts/fetch-ffmpeg.mjs      vendors the Windows DLLs and decides when to skip
//   - scripts/before-pack.cjs       fails the pack if one is missing (three OS tables)
//   - scripts/build-linux-compositor-addon.mjs  copies + symbol-renames the sonames
//   - nix/compositor-view.nix       builds symbols.map from a brace glob
//
// Drift is not a cosmetic problem. The addon is a cdylib, so a missing library does not
// fail the link: it fails at `require()` with "undefined symbol: osff_avfilter_graph_alloc",
// `compositorViewService` logs "native addon not present; running as no-op", and the app
// ships with a blank preview and every export dead — the exact symptom 1.9.0 shipped with.
// Every guard listed above passes in that state, because each one only knows the list it
// was written with.
//
// This test derives the truth from build.rs and checks the other five against it, so
// linking a seventh library fails here instead of in a user's installer. It reads source
// text: before-pack.cjs and fetch-ffmpeg.mjs both do work at import time, and the property
// under test is a property of the literal lists anyway.
//
// The nix derivation is the reason this file exists rather than an assertion inside
// before-pack.test.mjs: `.github/workflows/nix-build.yml` does not run on pull requests
// and there is no nix on the Windows dev box, so nix/compositor-view.nix reaches main with
// no pre-merge signal at all. A text assertion is not `nix build`, but it does catch the
// one mistake that has actually happened.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

const buildRs = read("crates/compositor/build.rs");

/** The `for lib in [...] { println!("cargo:rustc-link-lib=…") }` list, in build.rs order. */
const linked = (() => {
	const block = buildRs.match(/for lib in \[([\s\S]*?)\]\s*\{[\s\S]*?rustc-link-lib/);
	if (!block) return [];
	return [...block[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
})();

describe("the ffmpeg libraries the compositor links", () => {
	// Without this the regex could silently match nothing and every assertion below
	// would iterate an empty list and pass vacuously.
	it("is read out of build.rs", () => {
		expect(linked.length).toBeGreaterThanOrEqual(6);
		expect(linked).toContain("avcodec");
		expect(linked).toContain("avfilter");
	});

	it("is vendored in full by fetch-ffmpeg.mjs", () => {
		// The probe that decides whether a warm tree still needs a re-vendor. When it
		// listed fewer libraries than build.rs links, a tree holding the previous set
		// satisfied it and the new DLL was never fetched.
		const source = read("scripts/fetch-ffmpeg.mjs");
		const table = source.match(/REQUIRED_SHARED_DLLS = \[([\s\S]*?)\]/);
		expect(table, "fetch-ffmpeg.mjs no longer declares REQUIRED_SHARED_DLLS").not.toBeNull();
		const required = [...table[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
		expect([...required].sort()).toEqual([...linked].sort());
	});

	it("is staged and symbol-renamed for the Linux addon", () => {
		const source = read("scripts/build-linux-compositor-addon.mjs");
		const table = source.match(/FFMPEG_SONAMES = \[([\s\S]*?)\]/);
		expect(table, "build-linux-compositor-addon.mjs no longer declares FFMPEG_SONAMES").not.toBeNull();
		const sonames = [...table[1].matchAll(/"lib([a-z]+)\.so\.\d+"/g)].map((match) => match[1]);
		expect([...sonames].sort()).toEqual([...linked].sort());
	});

	it("is staged and symbol-renamed by the nix derivation", () => {
		// `for lib in ${ffmpegLgpl.lib}/lib/lib{avformat,…}.so.*` — the brace glob feeds
		// both the copy into $stage/lib and the symbols.map the addon is linked against.
		// A name missing here links against nixpkgs' un-renamed copy, and the
		// installPhase leak check only flags symbols WITHOUT the osff_ prefix, so it
		// passes either way.
		const source = read("nix/compositor-view.nix");
		const glob = source.match(/\/lib\/lib\{([a-z,]+)\}\.so\.\*/);
		expect(glob, "nix/compositor-view.nix no longer globs the ffmpeg sonames").not.toBeNull();
		expect(glob[1].split(",").sort()).toEqual([...linked].sort());
	});

	describe("is required by before-pack.cjs", () => {
		const source = read("scripts/before-pack.cjs");
		/** The `[...]` array literal a `...[…].map(` spread iterates, per OS table. */
		const listsIn = (table) => {
			const block = source.slice(source.indexOf(`const ${table} = [`));
			const end = block.indexOf("\n];");
			return [...block.slice(0, end).matchAll(/\.\.\.\[([^\]]*)\]\.map\(/g)].flatMap((match) =>
				[...match[1].matchAll(/"([a-z]+)"/g)].map((name) => name[1]),
			);
		};

		// One requirement per library rather than `atLeast: N` over a combined regex:
		// several versioned copies of one library would satisfy a count while another
		// was missing entirely, which is how a broken pack passed the guard before.
		for (const table of ["MAC_REQUIRED", "LINUX_REQUIRED", "WIN_REQUIRED"]) {
			it(table, () => {
				const required = listsIn(table);
				expect(required.length, `${table} declares no per-library spread`).toBeGreaterThan(0);
				for (const library of linked) {
					expect(required, `${table} does not require lib${library}`).toContain(library);
				}
			});
		}
	});
});
