// Guards the macOS deployment floor of the native Swift helpers (issue #515).
//
// The floor is declared ONCE, package-wide, and SwiftPM offers no per-target
// override — so it silently governs every executable in the package. That is
// exactly how the bug happened: b9e21347 set `.macOS(.v13)` when ScreenCaptureKit
// was the only target, then b2f9afab added `openscreen-macos-cursor-helper`
// beside it, which needs nothing newer than 10.15 and inherited 13 anyway.
//
// The consequence is not cosmetic. At a deployment target >= 13 the linker
// resolves the Swift Foundation overlay symbols against Foundation.framework and
// drops /usr/lib/swift/libswiftFoundation.dylib from the load commands; on
// macOS 12 those symbols live only in that dylib, so the helper dies in the
// loader before it can speak — which the app then reported to the user as a
// denied Accessibility grant.
//
// A text assertion rather than a build: this has to fail on Linux and Windows CI
// too, where no Swift toolchain exists. Native ScreenCaptureKit capture still
// requires macOS 13 — that floor is enforced in Swift by `@available`, and is
// deliberately NOT this file's business.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_SWIFT = path.join(ROOT, "electron", "native", "screencapturekit", "Package.swift");

/** The lowest macOS anything can ship on: Electron 41's own floor. */
const SUPPORTED_FLOOR = 12;

/**
 * Reads the major version out of the `platforms:` block, accepting both spellings
 * SwiftPM allows — `.macOS(.v12)` and `.macOS("12.3")`.
 */
function declaredMacOsFloor(source) {
	const enumMatch = source.match(/\.macOS\(\s*\.v(\d+)(?:_\d+)?\s*\)/);
	if (enumMatch) {
		return Number(enumMatch[1]);
	}

	const stringMatch = source.match(/\.macOS\(\s*"(\d+)(?:\.\d+)*"\s*\)/);
	return stringMatch ? Number(stringMatch[1]) : null;
}

describe("macOS native helper deployment target", () => {
	const source = readFileSync(PACKAGE_SWIFT, "utf8");

	it("declares a floor the shipped app can actually run on", () => {
		const floor = declaredMacOsFloor(source);

		expect(floor, `no .macOS(...) platform found in ${PACKAGE_SWIFT}`).not.toBeNull();
		expect(
			floor,
			`Package.swift declares macOS ${floor}, above the app's supported floor of ` +
				`${SUPPORTED_FLOOR}. This block is package-wide and also governs ` +
				"openscreen-macos-cursor-helper, which needs nothing newer than 10.15. " +
				"Raising it strands every macOS " +
				`${SUPPORTED_FLOOR} user: the helper dies in the loader and the app reports ` +
				"it as a denied Accessibility grant. See issue #515.",
		).toBeLessThanOrEqual(SUPPORTED_FLOOR);
	});

	it("parses both spellings SwiftPM accepts", () => {
		expect(declaredMacOsFloor("platforms: [ .macOS(.v12) ]")).toBe(12);
		expect(declaredMacOsFloor("platforms: [ .macOS(.v10_15) ]")).toBe(10);
		expect(declaredMacOsFloor('platforms: [ .macOS("12.3") ]')).toBe(12);
		expect(declaredMacOsFloor("platforms: [ .iOS(.v16) ]")).toBeNull();
	});
});
