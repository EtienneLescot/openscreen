import { describe, expect, it, vi } from "vitest";
import { checkLatestRelease, compareVersions } from "./update-checker";

function releaseResponse(payload: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: vi.fn().mockResolvedValue(payload),
	};
}

describe("compareVersions", () => {
	it("implements semantic version ordering for stable and prerelease builds", () => {
		expect(compareVersions("v2.0.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("1.9.0", "1.9.0-rc.2")).toBeGreaterThan(0);
		expect(compareVersions("1.9.0-rc.10", "1.9.0-rc.2")).toBeGreaterThan(0);
		expect(compareVersions("1.9.0+build.2", "v1.9.0+build.1")).toBe(0);
	});

	it("preserves precision for oversized core identifiers", () => {
		expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBeGreaterThan(0);
	});

	it.each([
		"01.0.0",
		"1.02.0",
		"1.0.03",
		"1.0.0-rc.01",
	])("rejects leading-zero numeric identifiers in %s", (version) => {
		expect(() => compareVersions(version, "1.0.0")).toThrow("invalid semantic version");
	});
});

describe("checkLatestRelease", () => {
	it("reports a newer official stable release", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v1.10.0",
				html_url: "https://github.com/getopenscreen/openscreen/releases/tag/v1.10.0",
				draft: false,
				prerelease: false,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).resolves.toEqual({
			kind: "available",
			currentVersion: "1.9.0",
			latestVersion: "1.10.0",
			releaseUrl: "https://github.com/getopenscreen/openscreen/releases/tag/v1.10.0",
		});
		expect(fetchLatest).toHaveBeenCalledWith(
			"https://api.github.com/repos/getopenscreen/openscreen/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({ Accept: "application/vnd.github+json" }),
			}),
		);
	});

	it("reports current when the installed version is equal or newer", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v1.9.0",
				html_url: "https://github.com/getopenscreen/openscreen/releases/tag/v1.9.0",
				draft: false,
				prerelease: false,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.1", fetchLatest })).resolves.toEqual({
			kind: "current",
			currentVersion: "1.9.1",
			latestVersion: "1.9.0",
		});
		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).resolves.toEqual({
			kind: "current",
			currentVersion: "1.9.0",
			latestVersion: "1.9.0",
		});
	});

	it("forwards the cancellation signal", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v1.9.0",
				html_url: "https://github.com/getopenscreen/openscreen/releases/tag/v1.9.0",
				draft: false,
				prerelease: false,
			}),
		);
		const controller = new AbortController();

		await checkLatestRelease({
			currentVersion: "1.9.0",
			fetchLatest,
			signal: controller.signal,
		});

		expect(fetchLatest).toHaveBeenCalledWith(
			"https://api.github.com/repos/getopenscreen/openscreen/releases/latest",
			expect.objectContaining({ signal: controller.signal }),
		);
	});

	it.each([
		{ draft: true, prerelease: false },
		{ draft: false, prerelease: true },
	])("rejects draft and prerelease payloads: %o", async ({ draft, prerelease }) => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v2.0.0",
				html_url: "https://github.com/getopenscreen/openscreen/releases/tag/v2.0.0",
				draft,
				prerelease,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).rejects.toThrow(
			"invalid GitHub release response",
		);
	});

	it("rejects a release URL outside the official repository", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v9.9.9",
				html_url: "https://example.com/openscreen-9.9.9.exe",
				draft: false,
				prerelease: false,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).rejects.toThrow(
			"untrusted release URL",
		);
	});

	it.each([
		"https://github.com/getopenscreen/openscreen/releases/download/v9.9.9/app.zip",
		"https://github.com/getopenscreen/openscreen/releases/tag/v9.9.8",
		"https://github.com/getopenscreen/openscreen/releases/tag/v9.9.9?download=1",
		"https://github.com/getopenscreen/openscreen/releases/tag/v9.9.9#notes",
	])("rejects an invalid official-repository URL: %s", async (htmlUrl) => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v9.9.9",
				html_url: htmlUrl,
				draft: false,
				prerelease: false,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).rejects.toThrow(
			"untrusted release URL",
		);
	});

	it("rejects unsuccessful or malformed GitHub responses", async () => {
		const unavailable = vi.fn().mockResolvedValue(releaseResponse({}, 503));
		await expect(
			checkLatestRelease({ currentVersion: "1.9.0", fetchLatest: unavailable }),
		).rejects.toThrow("GitHub release check failed (503)");

		const malformed = vi.fn().mockResolvedValue(releaseResponse({ tag_name: "v2.0.0" }));
		await expect(
			checkLatestRelease({ currentVersion: "1.9.0", fetchLatest: malformed }),
		).rejects.toThrow("invalid GitHub release response");
	});
});
