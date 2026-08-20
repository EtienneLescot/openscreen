import { describe, expect, it } from "vitest";
import {
	classifyInstall,
	type InstallProbe,
	ownsItsUpdates,
	platformOwnsUpdates,
} from "./install-channel";

/** A packaged Linux install with no channel markers at all. Every case overrides only the
 *  fields it is about, so a test never accidentally depends on the host it runs on. */
function probe(overrides: Partial<InstallProbe> = {}): InstallProbe {
	return {
		platform: "linux",
		isPackaged: true,
		execPath: "/opt/Openscreen/openscreen",
		windowsStore: false,
		env: {},
		hasFlatpakInfo: false,
		packageType: null,
		...overrides,
	};
}

describe("classifyInstall", () => {
	it("reports dev for an unpacked build regardless of platform", () => {
		for (const platform of ["win32", "darwin", "linux"] as const) {
			expect(classifyInstall(probe({ platform, isPackaged: false }))).toBe("dev");
		}
	});

	it("classifies the installers we build and own", () => {
		expect(classifyInstall(probe({ platform: "win32" }))).toBe("nsis");
		expect(classifyInstall(probe({ platform: "darwin" }))).toBe("dmg");
		expect(classifyInstall(probe({ env: { APPIMAGE: "/home/u/Apps/Openscreen.AppImage" } }))).toBe(
			"appimage",
		);
		for (const packageType of ["deb", "rpm", "pacman"] as const) {
			expect(classifyInstall(probe({ packageType }))).toBe(packageType);
		}
	});

	it("classifies the channels a package manager owns", () => {
		expect(classifyInstall(probe({ platform: "win32", windowsStore: true }))).toBe("store");
		expect(classifyInstall(probe({ env: { FLATPAK_ID: "com.getopenscreen.OpenScreen" } }))).toBe(
			"flatpak",
		);
		expect(classifyInstall(probe({ hasFlatpakInfo: true }))).toBe("flatpak");
		expect(
			classifyInstall(probe({ env: { SNAP: "/snap/openscreen/42", SNAP_REVISION: "42" } })),
		).toBe("snap");
		expect(classifyInstall(probe({ execPath: "/nix/store/abc-openscreen/bin/openscreen" }))).toBe(
			"nix",
		);
	});

	// The ordering cases. Each of these markers coexists with a self-owned one, and getting the
	// order wrong is what produces a second parallel installation.
	it("prefers the platform owner when both kinds of marker are present", () => {
		expect(classifyInstall(probe({ env: { FLATPAK_ID: "x" }, packageType: "deb" }))).toBe(
			"flatpak",
		);
		expect(
			classifyInstall(probe({ env: { SNAP: "/snap/x", SNAP_REVISION: "1" }, packageType: "deb" })),
		).toBe("snap");
		expect(
			classifyInstall(
				probe({ execPath: "/nix/store/x/bin/openscreen", env: { APPIMAGE: "/x.AppImage" } }),
			),
		).toBe("nix");
		// The Microsoft Store build is still a win32 packaged app; without the check it is "nsis".
		expect(classifyInstall(probe({ platform: "win32", windowsStore: true }))).toBe("store");
	});

	it("does not mistake a stray SNAP variable for a snap install", () => {
		expect(classifyInstall(probe({ env: { SNAP: "/snap/something" } }))).toBe("unknown");
	});

	it("returns unknown rather than guessing when a Linux build carries no marker", () => {
		// package-type is only written when a publish config resolves. Guessing "appimage" here
		// would hand a .deb to the AppImage updater, which fails on the missing APPIMAGE var.
		expect(classifyInstall(probe())).toBe("unknown");
		expect(classifyInstall(probe({ packageType: "tar.gz" }))).toBe("unknown");
	});
});

describe("ownsItsUpdates", () => {
	it("allows self-update only for the artifacts we build and can replace", () => {
		for (const channel of ["nsis", "dmg", "appimage", "deb", "rpm", "pacman"] as const) {
			expect(ownsItsUpdates(channel)).toBe(true);
		}
	});

	it("refuses self-update wherever a package manager owns it", () => {
		for (const channel of ["store", "flatpak", "snap", "nix", "dev", "unknown"] as const) {
			expect(ownsItsUpdates(channel)).toBe(false);
		}
	});
});

describe("platformOwnsUpdates", () => {
	it("is true exactly where a package manager keeps the app current", () => {
		for (const channel of ["store", "flatpak", "snap", "nix"] as const) {
			expect(platformOwnsUpdates(channel)).toBe(true);
		}
	});

	// The distinction that matters: these cannot self-update either, but they should still be
	// able to point the user at the release page. Collapsing the two predicates into one would
	// silently remove the only update affordance a dev or unclassified build has.
	it("is false for builds that merely cannot self-update", () => {
		for (const channel of ["dev", "unknown"] as const) {
			expect(ownsItsUpdates(channel)).toBe(false);
			expect(platformOwnsUpdates(channel)).toBe(false);
		}
	});

	it("never claims both ownerships for the same channel", () => {
		const all = [
			"nsis",
			"dmg",
			"appimage",
			"deb",
			"rpm",
			"pacman",
			"store",
			"flatpak",
			"snap",
			"nix",
			"dev",
			"unknown",
		] as const;
		for (const channel of all) {
			expect(ownsItsUpdates(channel) && platformOwnsUpdates(channel)).toBe(false);
		}
	});
});
