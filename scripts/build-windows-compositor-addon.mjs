// Builds the native D3D11 compositor addon (crates/compositor-view-napi) and
// vendors it to electron/native/compositor-view/build/compositor_view.node,
// the path compositorViewService.ts's candidate list resolves at runtime.
//
// Mirrors build-windows-wgc-helper.mjs's MSVC-environment discovery (vcvarsall
// sweep), but drives `cargo build` instead of CMake/Ninja — crates/ is a Rust
// workspace. FFMPEG_DIR and LIBCLANG_PATH come from crates/.cargo/config.toml
// (portable, relative to crates/), not from this script: cargo picks those up
// automatically because the build runs with cwd = crates/.
//
// The addon links against ffmpeg's shared DLLs (avcodec/avformat/avutil/…),
// so it MUST be built against the same pinned ffmpeg release that
// fetch-ffmpeg.mjs vendors into electron/native/bin/<tag>/ — otherwise the
// DLL filenames the addon imports (avcodec-NN.dll etc.) won't match what's
// shipped, and require() fails at runtime even with the right dir on PATH.
// See crates/.cargo/config.toml for the pin.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findVcVarsAll, run as spawnStep } from "./msvcEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CRATES_DIR = path.join(ROOT, "crates");
const BUILD_OUT_DIR = path.join(ROOT, "electron", "native", "compositor-view", "build");

// cwd defaults to crates/, not ROOT: cargo reads FFMPEG_DIR and LIBCLANG_PATH
// from crates/.cargo/config.toml, which only applies when it runs from there.
const run = (command, args, options = {}) =>
	spawnStep(command, args, { cwd: CRATES_DIR, ...options });

async function runInVsEnv(command) {
	const vcvarsAll = findVcVarsAll();
	if (!vcvarsAll) {
		throw new Error(
			"Could not find Visual Studio vcvarsall.bat. Install Visual Studio Build Tools with C++.",
		);
	}

	const cargoExe = path.join(process.env.USERPROFILE ?? "", ".cargo", "bin", "cargo.exe");
	if (!fs.existsSync(cargoExe)) {
		throw new Error(`cargo not found at ${cargoExe}. Install Rust (rustup) first.`);
	}

	const cmdPath = path.join(
		fs.mkdtempSync(path.join(process.env.TEMP ?? ROOT, "openscreen-build-compositor-")),
		"build.cmd",
	);
	fs.writeFileSync(
		cmdPath,
		[
			"@echo off",
			`call "${vcvarsAll}" x64`,
			"if errorlevel 1 exit /b %errorlevel%",
			command,
			"exit /b %errorlevel%",
			"",
		].join("\r\n"),
	);
	try {
		await run("cmd.exe", ["/d", "/c", cmdPath], { cwd: CRATES_DIR });
	} finally {
		fs.rmSync(path.dirname(cmdPath), { recursive: true, force: true });
	}
}

if (process.platform !== "win32") {
	console.log("Skipping native D3D11 compositor addon build: Windows-only.");
	process.exit(0);
}

const ffmpegDir = fs.readFileSync(path.join(CRATES_DIR, ".cargo", "config.toml"), "utf8");
const pinMatch = ffmpegDir.match(/value = "([^"]+)"/);
if (pinMatch) {
	const pinnedDir = path.join(CRATES_DIR, pinMatch[1]);
	if (!fs.existsSync(pinnedDir)) {
		throw new Error(
			`FFMPEG_DIR pin (crates/.cargo/config.toml) points at ${pinnedDir}, which doesn't exist.\n` +
				"Vendor the pinned ffmpeg shared SDK there before building the compositor addon " +
				"(see crates/.cargo/config.toml for the pinned release).",
		);
	}
}

const cargoExeQuoted = `"%USERPROFILE%\\.cargo\\bin\\cargo.exe"`;
await runInVsEnv(`${cargoExeQuoted} build -p compositor-view-napi --release`);

const builtDll = path.join(CRATES_DIR, "target", "release", "compositor_view.dll");
if (!fs.existsSync(builtDll)) {
	throw new Error(`Compositor addon build completed but ${builtDll} was not found.`);
}

fs.mkdirSync(BUILD_OUT_DIR, { recursive: true });
const dest = path.join(BUILD_OUT_DIR, "compositor_view.node");
fs.copyFileSync(builtDll, dest);

// Also install next to the ffmpeg DLLs the addon links against, which is the copy
// that actually ships (win `extraResources`, filter `win32-*/*`). macOS has always
// done this — see build-macos-compositor-addon.mjs's archBinDir — and Windows not
// doing it is what broke the Store build of 1.9.0:
//
// The addon dlopens avcodec/avformat/avutil at require() time. Shipped from inside
// app.asar.unpacked it sat in a different directory from those DLLs, so loading it
// depended on `ensureFfmpegSharedDllsOnPath` prepending their directory to PATH.
// That works for the NSIS installer and does NOT work under MSIX: a packaged app
// resolves dependent DLLs through its package graph and ignores PATH. Measured
// inside a registered package, with the directory correctly on PATH:
//
//   require BEFORE PATH: FAILED: The specified module could not be found.
//   require AFTER  PATH: FAILED: The specified module could not be found.
//
// and with the addon sitting beside its DLLs, no PATH involved:
//
//   require BEFORE PATH: LOADED OK
//
// Node loads .node files with LOAD_WITH_ALTERED_SEARCH_PATH, so the addon's own
// directory is searched for its dependencies. Colocating removes the PATH mechanism
// rather than repairing it. `buildCandidatePaths` already probes this location
// first, so no loader change is needed.
const archBinDir = path.join(ROOT, "electron", "native", "bin", "win32-x64");
fs.mkdirSync(archBinDir, { recursive: true });
const archDest = path.join(archBinDir, "compositor_view.node");
fs.copyFileSync(builtDll, archDest);

console.log(`Built ${builtDll}`);
console.log(`Copied ${dest}`);
console.log(`Copied ${archDest}`);
