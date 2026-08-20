import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type AboutFacts,
	COPYRIGHT,
	formatAboutDetail,
	usesNativeAboutPanel,
	WEBSITE_URL,
} from "./about";

function facts(overrides: Partial<AboutFacts> = {}): AboutFacts {
	return {
		version: "1.9.6",
		channel: "dmg",
		platform: "darwin",
		arch: "arm64",
		electron: "41.2.1",
		chrome: "138.0.7204.100",
		node: "22.22.1",
		...overrides,
	};
}

describe("formatAboutDetail", () => {
	it("lays the runtime, the install and the project out one per line", () => {
		expect(formatAboutDetail(facts())).toBe(
			[
				"Electron 41.2.1 · Chromium 138.0.7204.100 · Node 22.22.1",
				"darwin arm64 · dmg",
				WEBSITE_URL,
			].join("\n"),
		);
	});

	// The macOS About panel prints the copyright in a field of its own, so a detail block that
	// carried it would show it twice there. Every other surface appends it itself.
	it("leaves the copyright line to the caller", () => {
		expect(formatAboutDetail(facts())).not.toContain(COPYRIGHT);
	});

	// The channel is the whole reason a Store or Flathub copy shows no update item, so it has
	// to be legible to whoever is reading the bug report rather than inferred from the platform.
	it("names the install channel, not just the platform", () => {
		expect(
			formatAboutDetail(facts({ platform: "win32", arch: "x64", channel: "store" })),
		).toContain("win32 x64 · store");
		expect(
			formatAboutDetail(facts({ platform: "linux", arch: "x64", channel: "appimage" })),
		).toContain("linux x64 · appimage");
	});
});

// Both about.ts and electron-builder.json5 state in prose that these two must stay
// byte-identical, and within one commit's lifetime they already came apart: the string moved
// here while the config key was still missing, which is precisely the second attribution on the
// binary — Get Info and the Windows file properties falling back to package.json's `author` —
// that declaring the key exists to prevent. A comment in two files cannot hold that; this can.
describe("COPYRIGHT", () => {
	it("matches the copyright electron-builder stamps into the bundle", () => {
		const config = readFileSync(new URL("../electron-builder.json5", import.meta.url), "utf8");
		const declared = config.match(/["']?copyright["']?\s*:\s*["']([^"']*)["']/)?.[1];
		expect(declared).toBe(COPYRIGHT);
	});
});

// CI is Linux-only, so the platform is pinned rather than read from `process` — the macOS
// branch is the one no automated run would otherwise ever execute.
describe("usesNativeAboutPanel", () => {
	it("sends macOS to its own panel", () => {
		expect(usesNativeAboutPanel("darwin")).toBe(true);
	});

	it("leaves every other platform on the message box we build", () => {
		expect(usesNativeAboutPanel("win32")).toBe(false);
		expect(usesNativeAboutPanel("linux")).toBe(false);
	});
});
