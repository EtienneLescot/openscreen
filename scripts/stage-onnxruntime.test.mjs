// Same guard fetch-ffmpeg.test.mjs applies to its own pin table, for the same reason:
// this table decides which binary ends up inside every installer we ship.
//
// The failure it is built around is specific to this file. Asset names interpolate
// `VERSION`, so bumping the version silently re-points all three downloads while the
// digests below them keep the OLD values — a bump that edits one line and looks
// complete. That does not fail at review, it fails at build time on whichever
// platform CI happens to run first, with a checksum mismatch and no hint that the
// cause is three lines nobody touched.
//
// Read as source text rather than imported: stage-onnxruntime.mjs calls main() at
// import and would start downloading. The properties under test are properties of
// the literal table anyway.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "stage-onnxruntime.mjs"),
	"utf8",
);

// Anchored at the property names so the file's prose cannot match.
const assets = [...source.matchAll(/^\s*asset:\s*`([^`]+)`/gm)].map((m) => m[1]);
const libs = [...source.matchAll(/^\s*lib:\s*"([^"]+)"/gm)].map((m) => m[1]);
const digests = [...source.matchAll(/^\s*sha256:\s*"([^"]*)"/gm)].map((m) => m[1]);
const targets = [...source.matchAll(/^\t"([a-z0-9]+-[a-z0-9]+)":\s*\{/gm)].map((m) => m[1]);

// The consumer. `ensureOnnxRuntimeOnPath` searches for these exact names in the exact
// directory this script stages into, so the two files agree by convention and nothing
// else — and a disagreement is silent: the library ships, the lookup misses it, and the
// effect just stays off with no error anywhere.
const service = fs.readFileSync(
	path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"electron",
		"native-bridge",
		"services",
		"compositorViewService.ts",
	),
	"utf8",
);
const ortLibBody = service.slice(service.indexOf("function ortLibName"));
const expectedLibs = [
	...ortLibBody.slice(0, ortLibBody.indexOf("\n}")).matchAll(/"(\S*onnxruntime\S*)"/g),
].map((m) => m[1]);

describe("stage-onnxruntime pins", () => {
	// Without this, a reformat that breaks the regexes above would leave every other
	// assertion iterating an empty array and passing vacuously.
	it("still finds the pin table", () => {
		expect(targets.length).toBeGreaterThanOrEqual(3);
		expect(assets).toHaveLength(targets.length);
		expect(libs).toHaveLength(targets.length);
		expect(digests).toHaveLength(targets.length);
	});

	// The bump hazard this file exists for: a hardcoded version in an asset name
	// survives a VERSION bump and points at an archive whose digest is not pinned.
	it("derives every asset name from VERSION", () => {
		for (const asset of assets) {
			expect(asset, `${asset} hardcodes a version instead of interpolating VERSION`).toContain(
				"${VERSION}",
			);
			expect(asset, `${asset} carries a literal version number as well`).not.toMatch(
				/\d+\.\d+\.\d+/,
			);
		}
	});

	it("pins a full sha-256 for every asset", () => {
		for (const digest of digests) {
			expect(digest).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	// Three near-identical rows: pasting one platform's digest onto another is the
	// easy mistake, and it fails on exactly one platform, late.
	it("pins a distinct digest per asset", () => {
		expect(new Set(digests).size, `duplicate digest across platforms: ${digests}`).toBe(
			digests.length,
		);
	});

	// Catches the same paste landing on the `lib` line, which would stage a file that
	// cannot load and report success.
	it("names a shared library matching each target's platform", () => {
		const suffix = { win32: ".dll", darwin: ".dylib", linux: ".so" };
		targets.forEach((target, i) => {
			const os = target.split("-")[0];
			expect(suffix, `no known library suffix for ${os}`).toHaveProperty(os);
			expect(libs[i].endsWith(suffix[os]), `${target} stages ${libs[i]}`).toBe(true);
		});
	});

	it("stages the file names ensureOnnxRuntimeOnPath looks for", () => {
		expect(expectedLibs.length, "could not read ortLibName() out of compositorViewService.ts").toBe(
			3,
		);
		for (const lib of expectedLibs) {
			expect(libs, `ortLibName() returns ${lib}, which no target stages`).toContain(lib);
		}
	});
});
