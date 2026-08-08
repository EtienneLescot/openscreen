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

const FIX_LINUX =
	"Rebuild it with:\n\n    npm run build:native:compositor:linux\n\nor use `npm run build:linux`, which does that for you.";

const FIX_LINUX_HELPER =
	"Rebuild it with:\n\n    npm run build:native:linux\n\nor use `npm run build:linux`, which does that for you.";

/** Everything the PipeWire capture helper is compiled from. */
const HELPER_SOURCE_PATHS = [
	"electron/native/pipewire-capture/src",
	"electron/native/pipewire-capture/csrc",
	"electron/native/pipewire-capture/build.rs",
	"electron/native/pipewire-capture/Cargo.toml",
].map((p) => path.join(ROOT, p));

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

/**
 * The Linux counterpart of MAC_REQUIRED. It exists for the same reason: until this
 * hook grew a Linux branch, `beforePack` asserted nothing at all on Linux — the
 * comment said "Linux ships no native addon of its own", which stopped being true
 * when the wgpu compositor addon and the PipeWire capture helper landed.
 *
 * `linux.extraResources` ships this directory wholesale (`filter: ["linux-*​/**"]`),
 * so "present here" is the same thing as "present in the installed app".
 *
 * Note the two ffmpeg sets, which is why `ffmpeg/` is required separately below:
 * the `.so` files sitting directly in this directory are the compositor's copies,
 * with every symbol renamed to `osff_*` so the addon cannot bind to Chromium's
 * bundled ffmpeg. The helper needs the *unrenamed* originals, which is what the
 * `ffmpeg/` subdirectory holds.
 */
const LINUX_REQUIRED = [
	{
		match: (name) => name === "compositor_view.node",
		what: "the wgpu/Vulkan compositor addon",
		breaks: "the preview renders nothing and every export falls back to the no-op compositor",
		fix: FIX_LINUX,
	},
	// Une exigence par famille, plutôt qu'`atLeast: 5` sur une regex combinée. Le
	// compte total était satisfait par cinq copies versionnées d'une même
	// bibliothèque — libavcodec.so.58 à .62 laissées par un build précédent —
	// pendant qu'une autre manquait. Le paquet passait alors la garde et le
	// compositeur ne chargeait pas : exactement le mode de panne que cette garde
	// existe pour attraper.
	...["avcodec", "avformat", "avutil", "swresample", "swscale"].map((library) => ({
		match: (name) => new RegExp(`^lib${library}\\.so\\.\\d+$`).test(name),
		what: `the symbol-renamed lib${library} shared object the compositor links`,
		breaks: "the compositor addon cannot be loaded at all (ld.so error at require())",
		fix: FIX_LINUX,
	})),
	{
		match: (name) => name === "openscreen-pipewire-helper",
		what: "the PipeWire screen-capture helper",
		breaks: "Wayland capture is unavailable and cursor recording throws",
		fix: FIX_LINUX_HELPER,
	},
	{
		match: (name) => name === "whisper-stt-server",
		what: "the whisper.cpp STT helper",
		breaks: "transcription and captions fail with a developer error shown to end users",
		fix: "Build it with:\n\n    npm run build:whisper-binaries\n\nor stage CI's with `bash scripts/stage-whisper-stt.sh linux-x64`.",
	},
	{
		match: (name) => /^libggml.*\.so(\.\d+)*$/.test(name),
		what: "the ggml backend shared objects the STT helper links",
		breaks: "whisper-stt-server dies in ld.so before main(), so STT times out with no diagnostic",
		fix: "Build it with:\n\n    npm run build:whisper-binaries",
		atLeast: 1,
	},
];

/** electron-builder passes `context.arch` as a numeric enum; map it to our directory tag. */
function archTagFor(context) {
	const BY_INDEX = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
	const name = BY_INDEX[context?.arch];
	return name && name !== "universal" ? name : process.arch;
}

/**
 * Shared by the macOS and Linux payload checks — same contract on both: the arch-tagged
 * directory under electron/native/bin/ is what extraResources ships, so a missing entry
 * here is a missing entry in the installed app.
 */
function checkNativePayload({ dir, required, osLabel, bundleNoun, emptyDirFix }) {
	if (!fs.existsSync(dir)) {
		throw new Error(
			`Refusing to package: ${path.relative(ROOT, dir)} does not exist, so ${bundleNoun} would ` +
				"ship with no native modules at all.\n\n" +
				emptyDirFix,
		);
	}

	const present = fs.readdirSync(dir);
	const missing = required.filter(
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
		`Refusing to package an incomplete ${osLabel} payload.\n\n` +
			`  looked in: ${path.relative(ROOT, dir)}\n\n` +
			`Missing:\n${detail}\n\n` +
			"Every one of these fails silently or as an unactionable timeout in the installed\n" +
			"app, which is why this is a hard error at pack time rather than a warning.",
	);
}

/**
 * The Windows addon must sit in the SAME directory as the ffmpeg DLLs it links
 * against, because that is the only arrangement that loads under MSIX.
 *
 * The addon dlopens avcodec/avformat/avutil at require() time. While it shipped from
 * app.asar.unpacked — one directory away from the DLLs — loading it depended on
 * `ensureFfmpegSharedDllsOnPath` prepending their directory to PATH. That works for
 * the NSIS installer and does not work under MSIX, which resolves dependent DLLs
 * through the package graph and ignores PATH. Measured inside a registered package,
 * with the directory correctly on PATH: `require` failed both before and after the
 * PATH was set; with the addon beside its DLLs it loaded with no PATH at all.
 *
 * That shipped as 1.9.0 on the Store: no compositor loaded, so the editor showed no
 * preview at all while audio kept playing — and it looked like an app bug, not a
 * packaging one, because every file was present and the NSIS build of the same commit
 * was fine.
 *
 * `win.extraResources` ships this directory wholesale (filter `win32-*​/*`), so
 * "together here" is the same thing as "together in the installed app".
 */
const WIN_REQUIRED = [
	{
		match: (name) => name === "compositor_view.node",
		what: "the D3D11 compositor addon",
		breaks: "the preview renders nothing and every export falls back to the no-op compositor",
		fix: FIX,
	},
	// One requirement per library, not `atLeast: 3` over a combined regex — the same
	// trap LINUX_REQUIRED documents above. Several versioned copies of one library
	// (avcodec-60/61/62.dll left by an earlier fetch) would satisfy a combined count
	// while another library was missing entirely, and the addon would still fail to
	// load.
	...["avcodec", "avformat", "avutil"].map((library) => ({
		match: (name) => new RegExp(`^${library}-\\d+\\.dll$`).test(name),
		what: `the ${library} DLL the compositor links`,
		breaks: "the addon cannot be loaded at all under MSIX, which ignores PATH",
		fix: "Fetch them with:\n\n    npm run fetch:ffmpeg",
	})),
];

function checkWinNativePayload() {
	checkNativePayload({
		dir: path.join(ROOT, "electron", "native", "bin", "win32-x64"),
		required: WIN_REQUIRED,
		osLabel: "Windows",
		bundleNoun: "the installer",
		emptyDirFix: `${FIX}\n\nThe STT helper and the capture helper are separate builds — see\ntechnical-documentation/engineering/build-and-packaging.md.`,
	});
}

function checkMacNativePayload(context) {
	checkNativePayload({
		dir: path.join(ROOT, "electron", "native", "bin", `darwin-${archTagFor(context)}`),
		required: MAC_REQUIRED,
		osLabel: "macOS",
		bundleNoun: "the .app",
		emptyDirFix: `${FIX_MAC}\n\nThe STT helper and the capture helper are separate builds — see\ntechnical-documentation/engineering/build-and-packaging.md.`,
	});
}

function checkLinuxNativePayload(context) {
	const dir = path.join(ROOT, "electron", "native", "bin", `linux-${archTagFor(context)}`);
	checkNativePayload({
		dir,
		required: LINUX_REQUIRED,
		osLabel: "Linux",
		bundleNoun: "the package",
		emptyDirFix: `${FIX_LINUX}\n\nThe capture helper and the STT helper are separate builds — see\ntechnical-documentation/engineering/build-and-packaging.md.`,
	});

	// Checked apart from LINUX_REQUIRED because "something named ffmpeg exists" is not the
	// property that matters — it has to be a directory holding the *unrenamed* libraries.
	// An empty one, or the wrong kind of entry, passes a name match and still ships a
	// helper that cannot start.
	const helperFfmpeg = path.join(dir, "ffmpeg");
	const isDir = fs.existsSync(helperFfmpeg) && fs.statSync(helperFfmpeg).isDirectory();
	if (fs.existsSync(helperFfmpeg) && !isDir) {
		// `fetch:ffmpeg` vendors the *static* ffmpeg binary to exactly this path, while
		// `build:native:linux` wants a directory here. They collide, and the loser is
		// whichever ran first. CI never sees it — `build:linux` only runs
		// `fetch:ffmpeg:sdk`, which does not write the executable — so this fires on
		// local packaging after someone has run the full fetch by hand.
		throw new Error(
			`Refusing to package: ${path.relative(ROOT, helperFfmpeg)} is a file, not a directory.\n\n` +
				"That path is where the PipeWire helper's ffmpeg libraries live, but the static\n" +
				"ffmpeg binary that `npm run fetch:ffmpeg` vendors lands on the same name and\n" +
				"overwrote it. Delete it and re-run:\n\n    npm run build:native:linux\n\n" +
				"(`npm run build:linux` uses fetch:ffmpeg:sdk, which does not write that file.)",
		);
	}
	const libs = isDir
		? fs.readdirSync(helperFfmpeg).filter((name) => /^lib(av|sw)\w+\.so\.\d+$/.test(name))
		: [];
	if (libs.length === 0) {
		throw new Error(
			"Refusing to package an incomplete Linux payload.\n\n" +
				`  looked in: ${path.relative(ROOT, helperFfmpeg)}\n\n` +
				"Missing:\n  - the PipeWire helper's own ffmpeg shared objects\n" +
				"      without it: openscreen-pipewire-helper dies in ld.so, so capture never starts\n" +
				`      ${FIX_LINUX_HELPER.replace(/\n+/g, " ")}\n\n` +
				"These are deliberately not the copies one level up: those have every symbol\n" +
				"renamed to `osff_*` for the compositor addon, and the helper needs the originals.",
		);
	}
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

// `label` is a full noun ("D3D11 compositor addon", "PipeWire capture helper"): this now
// guards artifacts that are not all compositor addons.
function checkCompositorAddonFreshness(
	addon = ADDON,
	fix = FIX,
	label = "D3D11 compositor addon",
	sources,
) {
	if (!fs.existsSync(addon)) {
		throw new Error(
			`Refusing to package: the ${label} is missing.\n\n  expected: ${addon}\n\n${fix}`,
		);
	}

	const addonMs = fs.statSync(addon).mtimeMs;
	const stale = (sources ?? SOURCE_PATHS)
		.map((source) => ({ source, ms: newestMtimeMs(source) }))
		.filter((entry) => entry.ms > addonMs);
	if (stale.length === 0) {
		return;
	}

	const newest = stale.reduce((a, b) => (a.ms > b.ms ? a : b));
	throw new Error(
		`Refusing to package a stale ${label}.\n\n` +
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
		// The copy that ships is the arch-tagged one under electron/native/bin/
		// (win.extraResources), beside its ffmpeg DLLs — not the dev copy this hook
		// used to be the sole guardian of. Same reasoning as the darwin branch below.
		const shipped = path.join(
			ROOT,
			"electron",
			"native",
			"bin",
			"win32-x64",
			"compositor_view.node",
		);
		checkWinNativePayload();
		checkCompositorAddonFreshness(shipped, FIX, "D3D11");
		return;
	}
	if (platform === "darwin") {
		// The addon that actually ships is the arch-tagged copy under
		// electron/native/bin/ (mac.extraResources), not the dev copy this hook used to
		// be the sole guardian of — so that is the one whose freshness matters.
		const tag = `darwin-${archTagFor(context)}`;
		const shipped = path.join(ROOT, "electron", "native", "bin", tag, "compositor_view.node");
		checkMacNativePayload(context);
		checkCompositorAddonFreshness(shipped, FIX_MAC, "Metal compositor addon");
		return;
	}
	if (platform === "linux") {
		const tag = `linux-${archTagFor(context)}`;
		const dir = path.join(ROOT, "electron", "native", "bin", tag);
		checkLinuxNativePayload(context);
		checkCompositorAddonFreshness(
			path.join(dir, "compositor_view.node"),
			FIX_LINUX,
			"wgpu/Vulkan compositor addon",
		);
		checkCompositorAddonFreshness(
			path.join(dir, "openscreen-pipewire-helper"),
			FIX_LINUX_HELPER,
			"PipeWire capture helper",
			HELPER_SOURCE_PATHS,
		);
		return;
	}
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
				"Metal compositor addon",
			);
			console.log(`macOS native payload complete in electron/native/bin/${tag}, addon up to date.`);
		} else if (process.platform === "linux") {
			// Was falling through to the Windows branch below, so running this on Linux
			// reported a missing D3D11 addon at a win32 path — noise, on the one platform
			// where the hook now has something to say.
			const tag = `linux-${process.arch}`;
			const dir = path.join(ROOT, "electron", "native", "bin", tag);
			checkLinuxNativePayload({ arch: undefined });
			checkCompositorAddonFreshness(
				path.join(dir, "compositor_view.node"),
				FIX_LINUX,
				"wgpu/Vulkan compositor addon",
			);
			checkCompositorAddonFreshness(
				path.join(dir, "openscreen-pipewire-helper"),
				FIX_LINUX_HELPER,
				"PipeWire capture helper",
				HELPER_SOURCE_PATHS,
			);
			console.log(`Linux native payload complete in electron/native/bin/${tag}, addon up to date.`);
		} else if (process.platform === "win32") {
			const shipped = path.join(
				ROOT,
				"electron",
				"native",
				"bin",
				"win32-x64",
				"compositor_view.node",
			);
			checkWinNativePayload();
			checkCompositorAddonFreshness(shipped, FIX, "D3D11");
			console.log(
				"Windows native payload complete in electron/native/bin/win32-x64 (addon beside its ffmpeg DLLs), addon up to date.",
			);
		} else {
			checkCompositorAddonFreshness();
			console.log("compositor addon is up to date with its Rust sources.");
		}
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
}
