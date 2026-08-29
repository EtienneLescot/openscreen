// Guards the macOS deployment floor of the native Swift helpers (issue #515).
//
// The floor is declared in THREE places that must agree: `mac.minimumSystemVersion` in
// electron-builder.json5 (what the .app tells LaunchServices), the README's system
// requirements (what we promise), and the `platforms:` block in Package.swift (what the
// helpers are actually built for). This file ties the third to the first.
//
// The direction matters. Package.swift may not declare a floor HIGHER than the app
// advertises — that is exactly #515: the floor here was set to 13 when ScreenCaptureKit
// was the only target, openscreen-macos-cursor-helper was added later and inherited it
// because SwiftPM has no per-target override, and the bundle went on advertising macOS 12
// (Electron's own LSMinimumSystemVersion, inherited because the key was unset).
//
// The damage was not the version number. At a deployment target >= 13 the linker resolves
// the Swift Foundation overlay symbols against Foundation.framework and drops
// /usr/lib/swift/libswiftFoundation.dylib from the load commands; on macOS 12 those
// symbols live only in that dylib, so the helper died in the loader before it could speak
// — and the app reported that as a denied Accessibility grant.
//
// A text assertion rather than a build: this has to fail on Linux and Windows CI too,
// where no Swift toolchain exists.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_SWIFT = path.join(ROOT, "electron", "native", "screencapturekit", "Package.swift");
const BUILDER_CONFIG = path.join(ROOT, "electron-builder.json5");

/**
 * The floor the .app itself declares, read rather than duplicated — a second copy of this
 * number is the thing most likely to drift, and drift is the whole failure mode.
 *
 * Regex rather than a JSON5 parse to keep this dependency-free and runnable anywhere; the
 * key is a plain string literal in a hand-maintained config.
 */
function declaredAppFloor() {
	const source = readFileSync(BUILDER_CONFIG, "utf8");
	const match = source.match(/"minimumSystemVersion"\s*:\s*"(\d+)(?:\.\d+)*"/);
	return match ? Number(match[1]) : null;
}

/**
 * Reads the major version out of the `platforms:` block, accepting both spellings
 * SwiftPM allows — `.macOS(.v12)` and `.macOS("12.3")`.
 */
function declaredMacOsFloor(source) {
	// Scoped to the platforms block, with comments stripped from it, rather than matched
	// across the whole manifest. That block is preceded by a long comment discussing these
	// very version numbers, so a file-wide match is one careless edit away from reading the
	// prose instead of the declaration — and reporting a floor the build does not use is
	// the one failure this guard must not have.
	const block = source.match(/\bplatforms\s*:\s*\[([\s\S]*?)\]/)?.[1];
	if (!block) {
		return null;
	}
	const declarations = block.replace(/\/\/[^\n]*/g, "");

	const enumMatch = declarations.match(/\.macOS\(\s*\.v(\d+)(?:_\d+)?\s*\)/);
	if (enumMatch) {
		return Number(enumMatch[1]);
	}

	const stringMatch = declarations.match(/\.macOS\(\s*"(\d+)(?:\.\d+)*"\s*\)/);
	return stringMatch ? Number(stringMatch[1]) : null;
}

describe("macOS native helper deployment target", () => {
	const source = readFileSync(PACKAGE_SWIFT, "utf8");

	it("declares a floor no higher than the app itself advertises", () => {
		const floor = declaredMacOsFloor(source);
		const appFloor = declaredAppFloor();

		expect(floor, `no .macOS(...) platform found in ${PACKAGE_SWIFT}`).not.toBeNull();
		expect(
			appFloor,
			'no "minimumSystemVersion" found in electron-builder.json5 — without it the .app ' +
				"inherits Electron's own floor, which is what let #515 ship",
		).not.toBeNull();
		expect(
			floor,
			`Package.swift builds the native helpers for macOS ${floor}, above the ${appFloor} ` +
				"the .app advertises to LaunchServices. This block is package-wide and also " +
				"governs openscreen-macos-cursor-helper, which needs nothing newer than 10.15. " +
				"Every user between the two versions gets a helper that dies in the loader, " +
				"reported as a denied Accessibility grant. See issue #515.",
		).toBeLessThanOrEqual(appFloor);
	});

	it("parses both spellings SwiftPM accepts", () => {
		expect(declaredMacOsFloor("platforms: [ .macOS(.v12) ]")).toBe(12);
		expect(declaredMacOsFloor("platforms: [ .macOS(.v10_15) ]")).toBe(10);
		expect(declaredMacOsFloor('platforms: [ .macOS("12.3") ]')).toBe(12);
		expect(declaredMacOsFloor("platforms: [ .iOS(.v16) ]")).toBeNull();
	});

	it("reads the declaration, not prose that happens to mention a version", () => {
		// The real manifest carries exactly this shape: a comment about the floor sitting
		// directly above the floor. Matching file-wide would report 12 while the build used
		// 13 — a guard that passes for the very bug it exists to catch.
		const decoyAbove = [
			"// It was .macOS(.v12) until this changed; see issue #515.",
			"platforms: [",
			"\t.macOS(.v13)",
			"],",
		].join("\n");
		expect(declaredMacOsFloor(decoyAbove)).toBe(13);

		const decoyInside = ["platforms: [", "\t// was .macOS(.v12)", "\t.macOS(.v13)", "],"].join(
			"\n",
		);
		expect(declaredMacOsFloor(decoyInside)).toBe(13);

		expect(declaredMacOsFloor("// .macOS(.v12) with no platforms block at all")).toBeNull();
	});
});
