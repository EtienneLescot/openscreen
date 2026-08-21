// How this copy of OpenScreen was installed, and therefore WHO is allowed to update it.
//
// On the Microsoft Store, Flathub, Snap and Nix the package manager already updates the app.
// A second updater there is not merely redundant: inside an MSIX container the install
// directory is read-only, and on the Store a "download the .exe" prompt walks the user into a
// SECOND, parallel installation that then drifts from the Store copy forever. So the rule is
// not "try and fail gracefully", it is "do not offer it at all".
//
// One definition, so "may we update ourselves?" can never be asked two different ways.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

/** Where the running binary came from. */
export type InstallChannel =
	/** We own the update: an installer/bundle we built and can replace in place. */
	| "nsis"
	| "dmg"
	| "appimage"
	| "deb"
	| "rpm"
	| "pacman"
	/** A package manager owns the update; we must stay out of its way. */
	| "store"
	| "flatpak"
	| "snap"
	| "nix"
	/** Unpacked `npm run dev`, or a build we cannot classify. */
	| "dev"
	| "unknown";

/** The facts the classification needs. Passed in rather than read from globals so the
 *  decision table can be tested on every platform from any platform — CI is Linux-only,
 *  and an unpinned `process.platform` branch is green there and wrong everywhere else. */
export interface InstallProbe {
	platform: NodeJS.Platform;
	/** `false` for `npm run dev` — but NOT sufficient on its own: Flatpak and Snap are packaged. */
	isPackaged: boolean;
	execPath: string;
	/** `process.windowsStore` is `true` or **undefined**, never `false`. Normalise before passing. */
	windowsStore: boolean;
	/** `FLATPAK_ID`, `SNAP`, `SNAP_REVISION`, `APPIMAGE`. Deliberately not `NodeJS.ProcessEnv`:
	 *  this repo augments that type with required app variables, which a test fixture has no
	 *  business supplying just to name one marker. */
	env: Readonly<Record<string, string | undefined>>;
	/** `/.flatpak-info` exists. Checked as well as `FLATPAK_ID`, which is inherited by child
	 *  processes and so can be present outside the sandbox; the file only exists inside it. */
	hasFlatpakInfo: boolean;
	/** Contents of `<resourcesPath>/package-type`, or null. electron-builder writes this for
	 *  deb/rpm/pacman only, and only when a publish config resolves — see `probeInstall`. */
	packageType: string | null;
}

const SELF_UPDATING: ReadonlySet<InstallChannel> = new Set<InstallChannel>([
	"nsis",
	"dmg",
	"appimage",
	"deb",
	"rpm",
	"pacman",
]);

const PLATFORM_OWNED: ReadonlySet<InstallChannel> = new Set<InstallChannel>([
	"store",
	"flatpak",
	"snap",
	"nix",
]);

/** Pure decision table. Order matters: the platform-owned markers are checked FIRST because
 *  they coexist with the self-owned ones — a Flatpak build still carries a `package-type`
 *  file, and a Snap still looks like a plain Linux install from the inside. */
export function classifyInstall(probe: InstallProbe): InstallChannel {
	if (!probe.isPackaged) return "dev";

	// --- platform-owned ---
	if (probe.windowsStore) return "store";
	if (probe.env.FLATPAK_ID || probe.hasFlatpakInfo) return "flatpak";
	// Two markers, not one: a bare `SNAP` is a plausible collision with an unrelated variable.
	if (probe.env.SNAP && probe.env.SNAP_REVISION) return "snap";
	if (probe.execPath.startsWith("/nix/store/")) return "nix";

	// --- self-owned ---
	// electron-updater reads this same variable; if it is missing it refuses to update an
	// AppImage, so treating it as the marker keeps us consistent with the thing doing the work.
	if (probe.env.APPIMAGE) return "appimage";
	if (
		probe.packageType === "deb" ||
		probe.packageType === "rpm" ||
		probe.packageType === "pacman"
	) {
		return probe.packageType;
	}
	if (probe.platform === "win32") return "nsis";
	if (probe.platform === "darwin") return "dmg";

	// A packaged Linux build with no APPIMAGE and no package-type. Most likely `package-type`
	// went missing (it is only written when a publish config resolves), and guessing wrong
	// means handing a .deb to the AppImage updater, which then fails on the absent env var.
	return "unknown";
}

/** May this copy download and install a new version over itself? */
export function ownsItsUpdates(channel: InstallChannel): boolean {
	return SELF_UPDATING.has(channel);
}

/** Does a package manager already keep this copy up to date? When true the app must show no
 *  update affordance at all — not a disabled one, not a "go download it" link. Distinct from
 *  `!ownsItsUpdates`: a `dev` or `unknown` build cannot self-update either, but pointing its
 *  user at the release page is still useful, whereas doing so on the Store walks them into a
 *  second parallel install. */
export function platformOwnsUpdates(channel: InstallChannel): boolean {
	return PLATFORM_OWNED.has(channel);
}

/** Read the real environment. `process.windowsStore` is typed as an optional `true`, so it is
 *  normalised to a boolean here rather than at each call site. */
/** The single rule every update affordance keys off — app menu, Help menu, tray, HUD and the
 *  IPC handler — so it cannot be asked two different ways. `platformOwnsUpdates` is the
 *  permanent veto (a Store/Flathub/Snap/Nix copy is offered nothing at all, not even a disabled
 *  item); `recording` is the transient one. Pure, so the whole matrix can be pinned in a test
 *  from a Linux-only CI. */
export function offersUpdateCheck(
	channel: InstallChannel,
	state: { readonly recording: boolean },
): boolean {
	return !platformOwnsUpdates(channel) && !state.recording;
}

/** Memoized: `probeInstall()` touches the filesystem, and the answer cannot change while the
 *  process lives. Lives here rather than in main.ts so the diagnostic handler can ask too. */
let cachedChannel: InstallChannel | null = null;

export function getInstallChannel(): InstallChannel {
	if (cachedChannel === null) cachedChannel = classifyInstall(probeInstall());
	return cachedChannel;
}

export function probeInstall(): InstallProbe {
	return {
		platform: process.platform,
		isPackaged: app.isPackaged,
		execPath: process.execPath,
		windowsStore: process.windowsStore === true,
		env: process.env,
		hasFlatpakInfo: process.platform === "linux" && existsSync("/.flatpak-info"),
		packageType: readPackageType(),
	};
}

function readPackageType(): string | null {
	try {
		return readFileSync(path.join(process.resourcesPath, "package-type"), "utf8").trim();
	} catch {
		// Absent on every platform except a deb/rpm/pacman install. Not an error.
		return null;
	}
}

// ponytail: a distro that REPACKAGES our .pacman (the AUR `openscreen` package does exactly
// this) inherits our `package-type` marker, so we would classify it as a pacman install we own
// and try to `pacman -U` a file the AUR helper knows nothing about. Distinguishing them needs
// `pacman -Qoq $(readlink -f /proc/self/exe)` and a package-name comparison — a subprocess on
// every launch. Not worth it while that package is stuck at 1.7.0 and uninstallable; revisit
// if AUR is ever revived (see the AUR publishing issue).
