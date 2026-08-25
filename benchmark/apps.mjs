/**
 * The app registry: what is in the benchmark, where it comes from, and what it costs to get.
 *
 * Separate from the drivers on purpose — `preflight` has to be able to show the user the whole
 * download list, with sizes and licence terms, and get one approval for all of it *before*
 * anything is fetched. Everything after that approval runs unattended.
 */

/**
 * Download URLs are pinned to a version wherever the vendor exposes one, because "latest"
 * makes a benchmark unreproducible: two machines run a month apart would measure two products.
 * `bench.mjs refresh-urls` re-resolves them and prints the diff.
 */
export const APPS = {
	"openscreen-cli": {
		driver: "./drivers/openscreen-cli.mjs",
		default: true,
		install: {
			method: "github-release",
			repo: "getopenscreen/openscreen",
			assetPattern: /macOS-Apple-Silicon.*\.dmg$/i,
			appName: "Openscreen.app",
			approxMB: 250,
			licence: "MIT — free, no account, no watermark",
		},
	},
	"openscreen-gui": {
		driver: "./drivers/openscreen-gui.mjs",
		default: true,
		sharesInstallWith: "openscreen-cli",
	},
	"screen-studio": {
		// Off by default: export is licence-gated, so an unactivated machine would only ever
		// record a failure. Enable it explicitly once a licence is activated.
		// macOS only, and export is licence-gated even there.
		driver: { darwin: "./drivers/screen-studio.mjs" },
		default: false,
		install: {
			method: "dmg",
			url: "https://screenstudioassets.com/releases/3.7.5-4595/Screen%20Studio%203.7.5-4595%20Apple%20Silicon.dmg",
			version: "3.7.5-4595",
			appName: "Screen Studio.app",
			approxMB: 349,
			licence: "commercial — trial exports carry a watermark (which does not change render time)",
			notes: [
				"No CLI and no scripting dictionary; only screen-studio://record-* deeplinks exist, none for export.",
			],
		},
	},
	cap: {
		driver: "./drivers/cap.mjs",
		default: true,
		install: {
			method: "dmg",
			url: "https://cap.so/download/apple-silicon",
			appName: "Cap.app",
			approxMB: 123,
			licence: "AGPL-3.0 — free; signing in is optional and not needed for a local export",
			notes: [
				"Ships a real CLI at Cap.app/Contents/MacOS/cap-cli — `cap export` renders a .cap project.",
			],
		},
	},
	camtasia: {
		driver: { darwin: "./drivers/camtasia.mjs", win32: "./drivers/camtasia-win.mjs" },
		default: true,
		install: {
			method: "dmg",
			url: "https://download.techsmith.com/camtasiamac/releases/Camtasia.dmg",
			appName: "Camtasia.app",
			approxMB: 412,
			licence: "commercial — 30-day trial, watermarked output",
			notes: ["No CLI on macOS. Driven through the File → Export menu."],
		},
	},
	focusee: {
		driver: { darwin: "./drivers/focusee.mjs", win32: "./drivers/focusee-win.mjs" },
		// On macOS the import is broken in 2.4.1 (see drivers/focusee.mjs); on Windows the
		// vendor ships the real application rather than a downloader stub, so it is in the
		// default set there.
		default: process.platform === "win32",
		install: {
			method: "manual",
			url: "https://focusee.imobie.com/go/download.php?product=fs",
			appName: "FocuSee.app",
			approxMB: 5,
			licence: "commercial — trial exports are watermarked",
			notes: ["The vendor ships a GUI installer stub; run it once during preflight."],
		},
	},
	kap: {
		// macOS only — Wulkano ships no Windows build.
		driver: { darwin: "./drivers/kap.mjs" },
		default: true,
		install: {
			method: "dmg",
			url: "https://github.com/wulkano/Kap/releases/download/v3.6.0/Kap-3.6.0-arm64.dmg",
			version: "3.6.0",
			appName: "Kap.app",
			approxMB: 119,
			licence: "MIT — free",
			notes: [
				"Has no background, zoom, corner-radius or shadow features at all, so it cannot express the",
				"full-demo scenario. It is kept as a reduced-fidelity reference: a real app doing a real",
				"export, with none of the compositing. Its row is marked partial in the report.",
			],
		},
	},
	"ffmpeg-baseline": {
		driver: "./drivers/ffmpeg-baseline.mjs",
		default: true,
		install: null,
	},
};

export async function loadDriver(id) {
	const entry = APPS[id];
	if (!entry) throw new Error(`Unknown app "${id}". Known: ${Object.keys(APPS).join(", ")}`);
	const mod = await import(driverPath(entry, id));
	return mod.default;
}

/** Apps that can run at all on this platform — the default set is filtered through this. */
export function availableOn(platform = process.platform) {
	return Object.entries(APPS)
		.filter(([, a]) => typeof a.driver === "string" || !!a.driver?.[platform])
		.map(([id]) => id);
}

/** Every distinct thing that has to be downloaded for the given app ids. */
export function installPlan(appIds) {
	const seen = new Set();
	const plan = [];
	for (const id of appIds) {
		const entry = APPS[id];
		if (!entry) continue;
		const target = entry.sharesInstallWith ?? id;
		if (seen.has(target)) continue;
		seen.add(target);
		const spec = (APPS[target] ?? entry).install;
		if (spec) plan.push({ id: target, ...spec });
	}
	return plan;
}

export const DEFAULT_APPS = Object.entries(APPS)
	.filter(([id, a]) => a.default && availableOn().includes(id))
	.map(([id]) => id);

/** Which driver file implements this app on this platform. */
function driverPath(entry, id) {
	if (typeof entry.driver === "string") return entry.driver;
	const p = entry.driver?.[process.platform];
	if (!p) {
		throw new Error(
			`"${id}" has no driver for ${process.platform}. Supported: ${Object.keys(entry.driver ?? {}).join(", ") || "none"}.`,
		);
	}
	return p;
}
