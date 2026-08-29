// The ONNX Runtime pin is coupled to a pin in a DIFFERENT LANGUAGE, and nothing
// else notices when they drift apart.
//
// `crates/Cargo.toml` gives `ort` the feature `api-NN`. That NN is the minimum ONNX
// Runtime minor version the crate accepts: `ort_sys` computes `ORT_API_VERSION` from
// it and asks the library for that API, and a library older than NN returns null —
// at which point `ort` PANICS rather than erroring (it is documented doing so in
// segmentation.rs, and it took down a render thread once already). So bumping `ort`
// without re-pinning this script ships a build where the effect is not merely off
// but actively fatal on the first frame that asks for it.
//
// The reverse drift is quieter and worse: pinning a NEWER runtime than the crate was
// built for makes `ort` log a compatibility warning to stderr and carry on, which in
// a packaged Electron app nobody reads.
//
// Neither direction is visible in review — the two lines are in different files, in
// different languages, edited by different tasks. This test is the thing that sees it.
//
// Read as source text rather than imported: fetch-onnxruntime.mjs calls main() at
// import and would start downloading. The property under test is a property of the
// literal table anyway.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(HERE, "fetch-onnxruntime.mjs"), "utf8");
const cargoToml = fs.readFileSync(path.join(HERE, "..", "crates", "Cargo.toml"), "utf8");

const version = source.match(/^const VERSION = "([^"]+)";/m)?.[1];
// Anchored at the property so the file's (extensive) prose cannot match.
const digests = [...source.matchAll(/^\s*sha256:\s*"([^"]+)"/gm)].map((m) => m[1]);
const slugs = [...source.matchAll(/^\s*slug:\s*"([^"]+)"/gm)].map((m) => m[1]);
const tags = [...source.matchAll(/^\t"([a-z0-9]+-[a-z0-9]+)":\s*\{$/gm)].map((m) => m[1]);

/** The `api-NN` feature `crates/Cargo.toml` gives `ort`, as a number. */
const ortApiFloor = () => {
	const block = cargoToml.match(/^ort = \{[\s\S]*?^\]\s*\}/m)?.[0] ?? "";
	const found = [...block.matchAll(/"api-(\d+)"/g)].map((m) => Number(m[1]));
	return found.length ? Math.max(...found) : null;
};

describe("fetch-onnxruntime pins", () => {
	// Without this, a reformat that breaks the regexes above would leave every other
	// assertion iterating an empty array and passing vacuously.
	it("still finds the pin table", () => {
		expect(version, "VERSION not found in fetch-onnxruntime.mjs").toMatch(/^\d+\.\d+\.\d+$/);
		expect(slugs.length).toBeGreaterThanOrEqual(4);
		expect(digests).toHaveLength(slugs.length);
		expect(tags).toHaveLength(slugs.length);
	});

	// THE point of this file.
	it("pins a runtime that satisfies the `api-NN` floor in crates/Cargo.toml", () => {
		const floor = ortApiFloor();
		expect(floor, "no api-NN feature found on `ort` in crates/Cargo.toml").toBeGreaterThan(0);
		const minor = Number(version.split(".")[1]);
		expect(
			minor,
			`crates/Cargo.toml asks ort for api-${floor}, so ONNX Runtime must be >= 1.${floor}.x, ` +
				`but fetch-onnxruntime.mjs pins ${version}. A runtime below the floor makes GetApi ` +
				"return null and ort PANICS. Re-pin VERSION and every sha256 together.",
		).toBeGreaterThanOrEqual(floor);
	});

	// Above the floor is not free either: ort warns at load and carries on, which in a
	// packaged app goes to a stderr nobody reads. Exact match is the intended state.
	it("pins the runtime the crate was actually built for, not merely a compatible one", () => {
		const floor = ortApiFloor();
		expect(
			Number(version.split(".")[1]),
			`ONNX Runtime ${version} does not match the api-${floor} ort was built against. ` +
				"Below it, ort panics; above it, ort logs a compatibility warning at every " +
				"startup, into a stderr no packaged app shows. If the mismatch is deliberate, " +
				"move ort to the matching api-NN feature in the same change.",
		).toBe(floor);
	});

	// The gpu_cuda variants are 200-320 MB and carry NVIDIA runtime redistribution
	// terms. Nothing in this app uses a GPU execution provider — the CPU EP was the
	// measured choice (webcam-segmentation.md), and it is what makes ONNX Runtime
	// shippable at all.
	it("pins only the plain CPU assets", () => {
		for (const slug of slugs) {
			expect(slug, `${slug} is not a plain CPU asset`).not.toMatch(
				/gpu|cuda|tensorrt|qnn|training/,
			);
		}
	});

	it("pins a full sha-256 for every asset", () => {
		for (const digest of digests) {
			expect(digest).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	// The keys are matched against `${process.platform}-${process.arch}`, so a
	// plausible-looking typo (`darwin-aarch64`, `win-x64`) silently provisions
	// nothing and the effect is off with no error anywhere.
	it("keys the table by real process.platform-process.arch tags", () => {
		for (const tag of tags) {
			expect(tag).toMatch(/^(win32|darwin|linux)-(x64|arm64)$/);
		}
		expect(new Set(tags).size, "duplicate tag in the pin table").toBe(tags.length);
	});

	// Microsoft publishes no osx-x86_64 asset from 1.27 on. main() has a branch that
	// explains that and exits 0 so the Intel release build still succeeds; if someone
	// adds a darwin-x64 entry, that branch makes it dead and the effect stays off.
	it("does not pin darwin-x64, which upstream does not publish", () => {
		expect(tags).not.toContain("darwin-x64");
		expect(source).toMatch(/tag === "darwin-x64"/);
	});
});
