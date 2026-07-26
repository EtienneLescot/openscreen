// Builds the native D3D11 compositor addon (poc-d3d/compositor-view-napi) and
// vendors it to electron/native/compositor-view/build/compositor_view.node,
// the path compositorViewService.ts's candidate list resolves at runtime.
//
// Mirrors build-windows-wgc-helper.mjs's MSVC-environment discovery (vcvarsall
// sweep), but drives `cargo build` instead of CMake/Ninja — poc-d3d is a Rust
// workspace. FFMPEG_DIR and LIBCLANG_PATH come from poc-d3d/.cargo/config.toml
// (portable, relative to poc-d3d/), not from this script: cargo picks those up
// automatically because the build runs with cwd = poc-d3d/.
//
// The addon links against ffmpeg's shared DLLs (avcodec/avformat/avutil/…),
// so it MUST be built against the same pinned ffmpeg release that
// fetch-ffmpeg.mjs vendors into electron/native/bin/<tag>/ — otherwise the
// DLL filenames the addon imports (avcodec-NN.dll etc.) won't match what's
// shipped, and require() fails at runtime even with the right dir on PATH.
// See poc-d3d/.cargo/config.toml for the pin.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findVcVarsAll, run as spawnStep } from "./msvcEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const POC_D3D_DIR = path.join(ROOT, "poc-d3d");
const BUILD_OUT_DIR = path.join(ROOT, "electron", "native", "compositor-view", "build");

// cwd defaults to poc-d3d/, not ROOT: cargo reads FFMPEG_DIR and LIBCLANG_PATH
// from poc-d3d/.cargo/config.toml, which only applies when it runs from there.
const run = (command, args, options = {}) =>
	spawnStep(command, args, { cwd: POC_D3D_DIR, ...options });

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
		await run("cmd.exe", ["/d", "/c", cmdPath], { cwd: POC_D3D_DIR });
	} finally {
		fs.rmSync(path.dirname(cmdPath), { recursive: true, force: true });
	}
}

if (process.platform !== "win32") {
	console.log("Skipping native D3D11 compositor addon build: Windows-only.");
	process.exit(0);
}

const ffmpegDir = fs.readFileSync(path.join(POC_D3D_DIR, ".cargo", "config.toml"), "utf8");
const pinMatch = ffmpegDir.match(/value = "([^"]+)"/);
if (pinMatch) {
	const pinnedDir = path.join(POC_D3D_DIR, pinMatch[1]);
	if (!fs.existsSync(pinnedDir)) {
		throw new Error(
			`FFMPEG_DIR pin (poc-d3d/.cargo/config.toml) points at ${pinnedDir}, which doesn't exist.\n` +
				"Vendor the pinned ffmpeg shared SDK there before building the compositor addon " +
				"(see poc-d3d/.cargo/config.toml for the pinned release).",
		);
	}
}

const cargoExeQuoted = `"%USERPROFILE%\\.cargo\\bin\\cargo.exe"`;
await runInVsEnv(`${cargoExeQuoted} build -p compositor-view-napi --release`);

const builtDll = path.join(POC_D3D_DIR, "target", "release", "compositor_view.dll");
if (!fs.existsSync(builtDll)) {
	throw new Error(`Compositor addon build completed but ${builtDll} was not found.`);
}

fs.mkdirSync(BUILD_OUT_DIR, { recursive: true });
const dest = path.join(BUILD_OUT_DIR, "compositor_view.node");
fs.copyFileSync(builtDll, dest);

console.log(`Built ${builtDll}`);
console.log(`Copied ${dest}`);
