// Builds the native Vulkan compositor addon (crates/compositor-view-napi) and
// vendors it to electron/native/bin/<platform>-<arch>/compositor_view.node, the
// first path compositorViewService.ts's candidate list resolves at runtime.
//
// The Linux counterpart of build-windows-compositor-addon.mjs. Two things
// differ from Windows, and both are load-bearing:
//
//   1. FFMPEG_DIR is NOT supplied by crates/.cargo/config.toml. That file pins
//      the win64 tree only (`[env]` has no per-target form in cargo), so on
//      Linux the caller must vendor a Linux *shared* build and point at it. Note
//      that scripts/fetch-ffmpeg.mjs vendors a *static* linux binary for the app
//      itself — that one has no headers or import libs and cannot be used here.
//
//   2. Shared libraries are found by RUNPATH, not by PATH. Windows gets away
//      with prepending the DLL dir to PATH at runtime
//      (ensureFfmpegSharedDllsOnPath), but glibc reads LD_LIBRARY_PATH once at
//      process start, so the equivalent trick cannot work after Electron is
//      already running. Instead the addon is linked with `-rpath,$ORIGIN` and
//      the five ffmpeg sonames are copied next to it, which makes the .node
//      self-contained wherever it is installed — no env var, no PATH surgery.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run as spawnStep } from "./msvcEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CRATES_DIR = path.join(ROOT, "crates");

/** The sonames the addon links against. Kept explicit so a version bump fails loudly. */
const FFMPEG_SONAMES = [
	"libavformat.so.62",
	"libavcodec.so.62",
	"libavutil.so.60",
	"libswscale.so.9",
	"libswresample.so.6",
];

const run = (command, args, options = {}) =>
	spawnStep(command, args, { cwd: CRATES_DIR, ...options });

if (process.platform !== "linux") {
	console.log("Skipping native Vulkan compositor addon build: Linux-only.");
	process.exit(0);
}

// `linux-x64` / `linux-arm64` — must match platformArchTag() in
// electron/native-bridge/services/compositorViewService.ts.
const tag = `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const OUT_DIR = path.join(ROOT, "electron", "native", "bin", tag);

/**
 * Resolve the ffmpeg shared tree: an explicit FFMPEG_DIR wins, otherwise fall
 * back to the conventional vendored location, mirroring how build.rs looks for
 * MAC_FFMPEG_DIR then thirdparty/ on macOS.
 */
function resolveFfmpegDir() {
	const candidates = [
		process.env.FFMPEG_DIR,
		path.join(CRATES_DIR, "thirdparty", "ffmpeg-linux64-lgpl-shared"),
	].filter(Boolean);

	for (const candidate of candidates) {
		if (
			fs.existsSync(path.join(candidate, "include")) &&
			fs.existsSync(path.join(candidate, "lib"))
		) {
			return candidate;
		}
	}

	throw new Error(
		"No Linux ffmpeg shared build found. Set FFMPEG_DIR to a tree containing include/ and lib/, " +
			`or vendor one at ${path.join(CRATES_DIR, "thirdparty", "ffmpeg-linux64-lgpl-shared")}.\n` +
			"BtbN publishes suitable LGPL builds as ffmpeg-<version>-linux64-lgpl-shared-<major>.tar.xz. " +
			"It must be the *shared* artifact — the static one fetch-ffmpeg.mjs vendors has no headers.",
	);
}

/**
 * bindgen loads libclang at runtime. crates/.cargo/config.toml hardcodes a
 * Windows LLVM path, so on Linux we locate it ourselves rather than making
 * every contributor export LIBCLANG_PATH by hand.
 */
function resolveLibclangDir() {
	if (process.env.LIBCLANG_PATH) {
		return process.env.LIBCLANG_PATH;
	}
	const roots = ["/usr/lib/x86_64-linux-gnu", "/usr/lib64", "/usr/lib"];
	for (const llvmRoot of ["/usr/lib"]) {
		if (!fs.existsSync(llvmRoot)) continue;
		for (const entry of fs.readdirSync(llvmRoot)) {
			if (entry.startsWith("llvm-")) {
				roots.unshift(path.join(llvmRoot, entry, "lib"));
			}
		}
	}
	const found = roots.find(
		(dir) =>
			fs.existsSync(dir) &&
			fs.readdirSync(dir).some((f) => /^libclang(-\d+)?\.so(\.\d+)*$/.test(f)),
	);
	if (!found) {
		throw new Error(
			"libclang not found — bindgen needs it to parse the ffmpeg headers. Install your " +
				"distribution's libclang package (e.g. libclang-dev on Debian/Ubuntu) or set LIBCLANG_PATH.",
		);
	}
	return found;
}

/**
 * On distributions that ship only `libclang.so.1` (no -dev package) clang also
 * cannot find its own `stddef.h`. Point it at gcc's copy in that case rather
 * than making the caller discover it.
 */
function bindgenClangArgs() {
	if (process.env.BINDGEN_EXTRA_CLANG_ARGS) {
		return process.env.BINDGEN_EXTRA_CLANG_ARGS;
	}
	const gccIncludeRoot = "/usr/lib/gcc/x86_64-linux-gnu";
	if (!fs.existsSync(gccIncludeRoot)) {
		return "";
	}
	const withStddef = fs
		.readdirSync(gccIncludeRoot)
		.map((version) => path.join(gccIncludeRoot, version, "include"))
		.filter((dir) => fs.existsSync(path.join(dir, "stddef.h")));
	return withStddef.length > 0 ? `-I${withStddef[0]}` : "";
}

const ffmpegDir = resolveFfmpegDir();

await run("cargo", ["build", "-p", "compositor-view-napi", "--release"], {
	env: {
		...process.env,
		FFMPEG_DIR: ffmpegDir,
		LIBCLANG_PATH: resolveLibclangDir(),
		BINDGEN_EXTRA_CLANG_ARGS: bindgenClangArgs(),
		// `$ORIGIN` is resolved by the dynamic linker against the directory the
		// .node itself lives in, so the ffmpeg copies below are found wherever the
		// app is installed. Single-quoted on purpose: the shell must not expand it.
		RUSTFLAGS: `${process.env.RUSTFLAGS ?? ""} -C link-arg=-Wl,-rpath,$ORIGIN`.trim(),
	},
});

const builtSo = path.join(CRATES_DIR, "target", "release", "libcompositor_view.so");
if (!fs.existsSync(builtSo)) {
	throw new Error(`Compositor addon build completed but ${builtSo} was not found.`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const dest = path.join(OUT_DIR, "compositor_view.node");
fs.copyFileSync(builtSo, dest);
console.log(`Built  ${builtSo}`);
console.log(`Copied ${dest}`);

// Dereference the symlinks: the shipped file must be the real library under its
// soname, since nothing recreates the lib*.so -> lib*.so.N chain at install time.
for (const soname of FFMPEG_SONAMES) {
	const source = path.join(ffmpegDir, "lib", soname);
	if (!fs.existsSync(source)) {
		throw new Error(
			`${soname} not found in ${path.join(ffmpegDir, "lib")}. The vendored ffmpeg tree does not ` +
				"match the sonames the addon links against — check the pinned release.",
		);
	}
	fs.copyFileSync(fs.realpathSync(source), path.join(OUT_DIR, soname));
}
console.log(`Copied ${FFMPEG_SONAMES.length} ffmpeg shared libraries alongside the addon`);
