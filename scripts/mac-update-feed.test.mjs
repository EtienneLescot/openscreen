import { describe, expect, it } from "vitest";
import { archOf, buildFeedYml } from "./mac-update-feed.mjs";

const ARM = {
	version: "1.9.3",
	url: "Openscreen-Mac-arm64-1.9.3.zip",
	sha512: "ARMDIGEST==",
	size: 111,
};
const X64 = {
	version: "1.9.3",
	url: "Openscreen-Mac-x64-1.9.3.zip",
	sha512: "X64DIGEST==",
	size: 222,
};
const NOW = new Date("2026-08-13T09:00:00.000Z");

describe("archOf", () => {
	it("reads the substring electron-updater actually matches on", () => {
		expect(archOf("Openscreen-Mac-arm64-1.9.3.zip")).toBe("arm64");
		expect(archOf("Openscreen-Mac-x64-1.9.3.zip")).toBe("x64");
	});

	// The whole reason this helper exists. Our DMGs are named for the user; the ZIPs must be
	// named for the updater, and the two conventions collide.
	it("refuses a marketing-named ZIP instead of silently calling it x64", () => {
		expect(() => archOf("Openscreen-macOS-Apple-Silicon-1.9.3.zip")).toThrow(/arm64/);
		expect(() => archOf("Openscreen-macOS-Intel-1.9.3.zip")).toThrow(/marketing/);
	});
});

describe("buildFeedYml", () => {
	it("emits one feed listing both architectures", () => {
		const yml = buildFeedYml([ARM, X64], NOW);
		expect(yml).toContain("version: 1.9.3");
		expect(yml).toContain("  - url: Openscreen-Mac-arm64-1.9.3.zip");
		expect(yml).toContain("  - url: Openscreen-Mac-x64-1.9.3.zip");
		expect(yml).toContain("releaseDate: '2026-08-13T09:00:00.000Z'");
		// Two entries, not one — the failure mode of electron-builder#5592 is a feed that
		// silently lists a single arch after the second job overwrites the first.
		expect(yml.match(/^ {2}- url:/gm)).toHaveLength(2);
	});

	it("points the arch-blind fallback at x64 so it degrades to Rosetta, never to broken", () => {
		const yml = buildFeedYml([ARM, X64], NOW);
		expect(yml).toMatch(/^path: Openscreen-Mac-x64-1\.9\.3\.zip$/m);
		expect(yml).toMatch(/^sha512: X64DIGEST==$/m);
	});

	it("is order-independent", () => {
		expect(buildFeedYml([X64, ARM], NOW)).toBe(buildFeedYml([ARM, X64], NOW));
	});

	it("refuses a half-built feed rather than publishing one arch", () => {
		expect(() => buildFeedYml([ARM], NOW)).toThrow(/exactly 2/);
		expect(() => buildFeedYml([ARM, X64, X64], NOW)).toThrow(/exactly 2/);
		expect(() => buildFeedYml([ARM, ARM], NOW)).toThrow(/one arm64/);
	});

	it("refuses to mix versions, which is what a stale artifact looks like", () => {
		expect(() => buildFeedYml([ARM, { ...X64, version: "1.9.2" }], NOW)).toThrow(/disagree/);
	});
});
