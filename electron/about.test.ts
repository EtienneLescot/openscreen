import { describe, expect, it } from "vitest";
import { type AboutFacts, COPYRIGHT, formatAboutDetail, WEBSITE_URL } from "./about";

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
