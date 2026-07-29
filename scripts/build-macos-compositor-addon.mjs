// Builds the native Metal/VideoToolbox compositor addon (crates/compositor-view-napi)
// and vendors it to electron/native/compositor-view/build/compositor_view.node — the
// path compositorViewService.ts's candidate list resolves at runtime.
//
// The macOS twin of build-windows-compositor-addon.mjs. Where that one has to sweep
// for vcvarsall to put MSVC on PATH, this one only needs the Xcode command-line tools
// (`xcrun` finds the SDK and libclang for bindgen, see crates/compositor/build.rs).
//
// FFMPEG — the one thing that is NOT symmetric. On Windows, scripts/fetch-ffmpeg.mjs
// vendors BtbN's pinned "-lgpl-shared" build into crates/thirdparty/. BtbN publishes
// no macOS target (that script exits 1 on darwin, by design), so there is no
// equivalent download and the tree has to be built locally. `--print-ffmpeg-recipe`
// prints the exact configure line; the LGPL posture is the part that matters and is
// not negotiable:
//
//   * NO --enable-gpl and NO --enable-nonfree. ffmpeg is LGPL by default and becomes
//     GPL the moment either is passed (x264/x265 come in with --enable-gpl), which
//     would relicense this MIT app. Same rule fetch-ffmpeg.mjs enforces on Windows
//     with `ffmpeg -L`.
//   * --enable-shared: the addon dynamically links libavcodec/libavformat/… .
//
// A Homebrew ffmpeg will NOT do as a drop-in: brew's formula builds with
// --enable-gpl. It is fine to develop against, never fine to ship.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CRATES_DIR = path.join(ROOT, "crates");
const BUILD_OUT_DIR = path.join(ROOT, "electron", "native", "compositor-view", "build");

/** Where crates/compositor/build.rs looks for the macOS ffmpeg tree when MAC_FFMPEG_DIR is unset. */
const VENDORED_FFMPEG_DIR = path.join(
	CRATES_DIR,
	"thirdparty",
	"ffmpeg-n8.1.2-macos64-lgpl-shared",
);

const FFMPEG_RECIPE = `
# ffmpeg 8.1.2, LGPL, shared — the tree crates/compositor/build.rs expects.
# Run from an unpacked https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz:

./configure \\
  --prefix="${VENDORED_FFMPEG_DIR}" \\
  --enable-shared --disable-static \\
  --disable-doc --disable-debug \\
  --enable-videotoolbox --enable-audiotoolbox \\
  --disable-x86asm --arch=arm64 --enable-neon --cc=clang
make -j"$(sysctl -n hw.ncpu)" && make install

# No --enable-gpl, no --enable-nonfree: either one relicenses OpenScreen under the GPL.
`.trim();

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit", cwd: CRATES_DIR, ...options });
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
		);
	});
}

if (process.argv.includes("--print-ffmpeg-recipe")) {
	console.log(FFMPEG_RECIPE);
	process.exit(0);
}

if (process.platform !== "darwin") {
	console.log("Skipping native Metal compositor addon build: macOS-only.");
	process.exit(0);
}

// The addon links ffmpeg, so a missing tree is a hard stop with the recipe attached
// rather than a bindgen error 200 lines deep in cargo output.
const macFfmpegDir = process.env.MAC_FFMPEG_DIR ?? VENDORED_FFMPEG_DIR;
if (!fs.existsSync(path.join(macFfmpegDir, "include"))) {
	throw new Error(
		`No ffmpeg SDK at ${macFfmpegDir} (looked for its include/).\n` +
			"Set MAC_FFMPEG_DIR, or build the vendored tree:\n\n" +
			`${FFMPEG_RECIPE}\n`,
	);
}

const cargo = path.join(os.homedir(), ".cargo", "bin", "cargo");
if (!fs.existsSync(cargo)) {
	throw new Error(`cargo not found at ${cargo}. Install Rust (https://rustup.rs) first.`);
}

// cwd = crates/ so cargo picks up crates/.cargo/config.toml, same as the Windows script.
await run(cargo, ["build", "-p", "compositor-view-napi", "--release"], {
	env: { ...process.env, MAC_FFMPEG_DIR: macFfmpegDir },
});

// cdylib on macOS is a .dylib; node's require() wants the .node extension but does not
// care what is inside — it dlopens it and calls the napi entry point either way.
const builtDylib = path.join(CRATES_DIR, "target", "release", "libcompositor_view.dylib");
if (!fs.existsSync(builtDylib)) {
	throw new Error(`Compositor addon build completed but ${builtDylib} was not found.`);
}

fs.mkdirSync(BUILD_OUT_DIR, { recursive: true });
const dest = path.join(BUILD_OUT_DIR, "compositor_view.node");
fs.copyFileSync(builtDylib, dest);

// The arch-tagged dir is the first candidate compositorViewService.ts probes, and the
// one electron-builder ships via extraResources. Keeping both in sync means a dev build
// and a packaged build load the same binary.
const archBinDir = path.join(ROOT, "electron", "native", "bin", `darwin-${process.arch}`);
fs.mkdirSync(archBinDir, { recursive: true });
const archDest = path.join(archBinDir, "compositor_view.node");
fs.copyFileSync(builtDylib, archDest);

console.log(`Built  ${builtDylib}`);
console.log(`Copied ${dest}`);
console.log(`Copied ${archDest}`);
console.log(
	"\nNOTE: this .node hardcodes absolute paths to the ffmpeg dylibs it was linked\n" +
		"against (see `otool -L`). That is fine for a dev build. Packaging still needs an\n" +
		"install_name_tool/@rpath pass plus the dylibs in extraResources — the macOS\n" +
		"equivalent of the PATH-prepend ensureFfmpegSharedDllsOnPath() does on Windows.",
);
