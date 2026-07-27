// electron-builder beforePack hook: refuse to package a compositor addon that is older than its
// Rust sources.
//
// `compositor_view.node` is an untracked build artifact, and plain `npm run build` does NOT rebuild
// it (only `build:win` runs `build:native:compositor`). So a bare `npm run build` — or a fresh
// worktree that inherited a copy from the main checkout — happily ships a `.node` built from
// whatever the sources looked like days ago.
//
// That failure is silent, which is what makes it worth a hard error. Scene fields the app sends are
// `#[serde(default)]` on the Rust side, so an addon predating a contract change does not reject the
// payload: it ignores the unknown key, takes the default, and falls back to older art. The feature
// simply does nothing, with no error in any log — it reads exactly like a bug in the TypeScript, and
// it has already cost one full false-trail investigation (custom cursor themes, 2026-07-27, where
// the shipped addon was 3 days older than the commit adding `cursorSprites`).
//
// ponytail: mtime comparison, not content hashing. A `git checkout` restamps source mtimes, so this
// can fire when the addon is actually fine. That trade is deliberate — the false positive costs one
// rebuild, the false negative ships a broken installer. Switch to hashing the sources into a stamp
// file next to the `.node` if branch-switching makes the noise annoying.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ADDON = path.join(ROOT, "electron/native/compositor-view/build/compositor_view.node");

// Everything the addon is compiled from. shaders.hlsl lives under src/, so it is covered.
// crates/poc-d3d/ is deliberately absent: nothing links it, so editing the POC cannot
// invalidate the shipped addon.
const SOURCE_PATHS = [
	"crates/compositor/src",
	"crates/compositor-view-napi/src",
	"crates/Cargo.toml",
	"crates/compositor/Cargo.toml",
	"crates/compositor-view-napi/Cargo.toml",
].map((p) => path.join(ROOT, p));

const FIX =
	"Rebuild it with:\n\n    npm run build:native:compositor\n\nor use `npm run build:win`, which does that for you.";

/** Newest mtime under `target` (file or directory), or 0 if it does not exist. */
function newestMtimeMs(target) {
	let stat;
	try {
		stat = fs.statSync(target);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) {
		return stat.mtimeMs;
	}
	let newest = 0;
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		newest = Math.max(newest, newestMtimeMs(path.join(target, entry.name)));
	}
	return newest;
}

function checkCompositorAddonFreshness() {
	if (!fs.existsSync(ADDON)) {
		throw new Error(
			`Refusing to package: the D3D11 compositor addon is missing.\n\n  expected: ${ADDON}\n\n${FIX}`,
		);
	}

	const addonMs = fs.statSync(ADDON).mtimeMs;
	const stale = SOURCE_PATHS.map((source) => ({ source, ms: newestMtimeMs(source) })).filter(
		(entry) => entry.ms > addonMs,
	);
	if (stale.length === 0) {
		return;
	}

	const newest = stale.reduce((a, b) => (a.ms > b.ms ? a : b));
	throw new Error(
		"Refusing to package a stale D3D11 compositor addon.\n\n" +
			`  addon built: ${new Date(addonMs).toISOString()}\n` +
			`  newer source: ${path.relative(ROOT, newest.source)} (${new Date(newest.ms).toISOString()})\n\n` +
			"Packaging this would silently ship an addon that ignores newer scene fields\n" +
			"(they are #[serde(default)], so it falls back instead of erroring).\n\n" +
			FIX,
	);
}

exports.default = async function beforePack(context) {
	// The compositor addon is Windows-only; skip when packing any other target.
	const platform = context?.electronPlatformName ?? process.platform;
	if (platform !== "win32") {
		return;
	}
	checkCompositorAddonFreshness();
};

// Runnable on its own for debugging: `node scripts/before-pack.cjs`
if (require.main === module) {
	try {
		checkCompositorAddonFreshness();
		console.log("compositor addon is up to date with its Rust sources.");
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}
