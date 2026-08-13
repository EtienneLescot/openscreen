import { describe, expect, it } from "vitest";
import { blockedFromInstalling, type InstallReadiness } from "./auto-updater";

function state(overrides: Partial<InstallReadiness> = {}): InstallReadiness {
	return { recording: false, inApplicationsFolder: true, platform: "linux", ...overrides };
}

describe("blockedFromInstalling", () => {
	it("allows an install when nothing is in the way", () => {
		for (const platform of ["win32", "darwin", "linux"] as const) {
			expect(blockedFromInstalling(state({ platform }))).toBeNull();
		}
	});

	// Quitting mid-recording loses the take. On Windows it is worse than losing it: the capture
	// helpers spawn from inside the install directory, and NSIS cannot overwrite a running .exe.
	it("refuses while a recording is in progress, on every platform", () => {
		for (const platform of ["win32", "darwin", "linux"] as const) {
			expect(blockedFromInstalling(state({ platform, recording: true }))).toBe("recording");
		}
	});

	// App Translocation: a quarantined app runs from a read-only image where Squirrel cannot
	// replace the bundle. Pinned per-platform because CI is Linux-only and an unpinned branch
	// would be green here and wrong on the one platform it applies to.
	it("refuses a macOS install running outside /Applications", () => {
		expect(blockedFromInstalling(state({ platform: "darwin", inApplicationsFolder: false }))).toBe(
			"not-in-applications",
		);
	});

	it("does not apply the Applications-folder rule off macOS", () => {
		for (const platform of ["win32", "linux"] as const) {
			expect(blockedFromInstalling(state({ platform, inApplicationsFolder: false }))).toBeNull();
		}
	});

	it("reports the recording veto first when both apply", () => {
		expect(
			blockedFromInstalling(
				state({ platform: "darwin", recording: true, inApplicationsFolder: false }),
			),
		).toBe("recording");
	});
});
