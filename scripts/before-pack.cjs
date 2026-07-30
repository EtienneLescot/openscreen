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

const FIX_MAC =
	"Rebuild it with:\n\n    npm run build:native:compositor:mac\n\nor use `npm run build:mac`, which does that for you.";

/**
 * Everything that has to be inside `electron/native/bin/darwin-<arch>/` for the .app to
 * work, keyed by what breaks when it is absent.
 *
 * This list exists because the macOS deliverable had no guard at all: `beforePack`
 * returned early on any non-win32 platform, so a mac package built without the compositor
 * addon shipped silently — the preview and the export come up dead, with nothing in any
 * log to say why. That is precisely the failure mode the staleness check below was written
 * to prevent, and the platform guard was letting it through on the other OS.
 *
 * `mac.extraResources` ships this directory wholesale (`filter: ["darwin-*​/*"]`), so
 * "present here" is the same thing as "present in the installed app".
 */
const MAC_REQUIRED = [
	{
		match: (name) => name === "compositor_view.node",
		what: "the Metal compositor addon",
		breaks: "the preview and every export render nothing",
		fix: FIX_MAC,
	},
	{
		match: (name) => /^libav(codec|format|util)\.\d+\.dylib$/.test(name),
		what: "the LGPL ffmpeg dylibs the compositor links",
		breaks: "the compositor addon cannot be loaded at all (dyld error at require())",
		fix: FIX_MAC,
		atLeast: 3,
	},
	{
		match: (name) => name === "whisper-stt-server",
		what: "the whisper.cpp STT helper",
		breaks: "transcription and captions fail with a developer error shown to end users",
		fix: "Build it with:\n\n    npm run build:whisper-binaries\n\nor stage CI's with `bash scripts/stage-whisper-stt.sh darwin-<arch>`.",
	},
	{
		match: (name) => /^libggml.*\.dylib$/.test(name),
		what: "the ggml backend dylibs the STT helper links",
		breaks: "whisper-stt-server dies in dyld before main(), so STT times out with no diagnostic",
		fix: "Build it with:\n\n    npm run build:whisper-binaries",
		atLeast: 1,
	},
	{
		match: (name) => name === "openscreen-screencapturekit-helper",
		what: "the ScreenCaptureKit capture helper",
		breaks: "native screen capture is unavailable",
		fix: "Build it with:\n\n    npm run build:native:mac",
	},
];

/** electron-builder passes `context.arch` as a numeric enum; map it to our directory tag. */
function archTagFor(context) {
	const BY_INDEX = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
	const name = BY_INDEX[context?.arch];
	return name && name !== "universal" ? name : process.arch;
}

function checkMacNativePayload(context) {
	const tag = `darwin-${archTagFor(context)}`;
	const dir = path.join(ROOT, "electron", "native", "bin", tag);
	if (!fs.existsSync(dir)) {
		throw new Error(
			`Refusing to package: ${path.relative(ROOT, dir)} does not exist, so the .app would ` +
				"ship with no native modules at all.\n\n" +
				`${FIX_MAC}\n\nThe STT helper and the capture helper are separate builds — see\n` +
				"technical-documentation/engineering/build-and-packaging.md.",
		);
	}

	const present = fs.readdirSync(dir);
	const missing = MAC_REQUIRED.filter(
		(req) => present.filter((name) => req.match(name)).length < (req.atLeast ?? 1),
	);
	if (missing.length === 0) {
		return;
	}

	const detail = missing
		.map(
			(req) =>
				`  - ${req.what}\n      without it: ${req.breaks}\n      ${req.fix.replace(/\n+/g, " ")}`,
		)
		.join("\n");
	throw new Error(
		`Refusing to package an incomplete macOS payload.\n\n` +
			`  looked in: ${path.relative(ROOT, dir)}\n\n` +
			`Missing:\n${detail}\n\n` +
			"Every one of these fails silently or as an unactionable timeout in the installed\n" +
			"app, which is why this is a hard error at pack time rather than a warning.",
	);
}

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

function checkCompositorAddonFreshness(addon = ADDON, fix = FIX, label = "D3D11") {
	if (!fs.existsSync(addon)) {
		throw new Error(
			`Refusing to package: the ${label} compositor addon is missing.\n\n  expected: ${addon}\n\n${fix}`,
		);
	}

	const addonMs = fs.statSync(addon).mtimeMs;
	const stale = SOURCE_PATHS.map((source) => ({ source, ms: newestMtimeMs(source) })).filter(
		(entry) => entry.ms > addonMs,
	);
	if (stale.length === 0) {
		return;
	}

	const newest = stale.reduce((a, b) => (a.ms > b.ms ? a : b));
	throw new Error(
		`Refusing to package a stale ${label} compositor addon.\n\n` +
			`  addon: ${path.relative(ROOT, addon)}\n` +
			`  addon built: ${new Date(addonMs).toISOString()}\n` +
			`  newer source: ${path.relative(ROOT, newest.source)} (${new Date(newest.ms).toISOString()})\n\n` +
			"Packaging this would silently ship an addon that ignores newer scene fields\n" +
			"(they are #[serde(default)], so it falls back instead of erroring).\n\n" +
			fix,
	);
}

exports.default = async function beforePack(context) {
	const platform = context?.electronPlatformName ?? process.platform;
	if (platform === "win32") {
		checkCompositorAddonFreshness();
		return;
	}
	if (platform === "darwin") {
		// The addon that actually ships is the arch-tagged copy under
		// electron/native/bin/ (mac.extraResources), not the dev copy this hook used to
		// be the sole guardian of — so that is the one whose freshness matters.
		const tag = `darwin-${archTagFor(context)}`;
		const shipped = path.join(ROOT, "electron", "native", "bin", tag, "compositor_view.node");
		checkMacNativePayload(context);
		checkCompositorAddonFreshness(shipped, FIX_MAC, "Metal");
		return;
	}
	// Linux ships no native addon of its own; nothing to assert.
};

// Runnable on its own for debugging: `node scripts/before-pack.cjs`
if (require.main === module) {
	try {
		if (process.platform === "darwin") {
			checkMacNativePayload({ arch: undefined });
			const tag = `darwin-${process.arch}`;
			checkCompositorAddonFreshness(
				path.join(ROOT, "electron", "native", "bin", tag, "compositor_view.node"),
				FIX_MAC,
				"Metal",
			);
			console.log(`macOS native payload complete in electron/native/bin/${tag}, addon up to date.`);
		} else {
			checkCompositorAddonFreshness();
			console.log("compositor addon is up to date with its Rust sources.");
		}
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}
