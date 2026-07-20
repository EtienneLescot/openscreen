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

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const POC_D3D_DIR = path.join(ROOT, "poc-d3d");
const BUILD_OUT_DIR = path.join(ROOT, "electron", "native", "compositor-view", "build");

function findVcVarsAll() {
	const explicit = process.env.VCVARSALL;
	if (explicit && fs.existsSync(explicit)) {
		return explicit;
	}

	const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
	if (fs.existsSync(vswhere)) {
		const result = spawnSync(
			vswhere,
			[
				"-latest",
				"-products",
				"*",
				"-requires",
				"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
				"-property",
				"installationPath",
			],
			{ encoding: "utf8", windowsHide: true },
		);
		const installPath = result.stdout?.trim();
		if (result.status === 0 && installPath) {
			const candidate = path.join(installPath, "VC", "Auxiliary", "Build", "vcvarsall.bat");
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}

	if (process.env.VSINSTALLDIR) {
		const candidate = path.join(process.env.VSINSTALLDIR, "VC", "Auxiliary", "Build", "vcvarsall.bat");
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	// vswhere doesn't always enumerate pre-release channels (e.g. "Insiders"
	// builds) — walk the install roots generically so new VS releases and
	// preview channels are found automatically (same policy as the wgc-capture
	// helper build script).
	const editions = ["Community", "Professional", "Enterprise", "BuildTools"];
	const installRoots = [
		"C:\\Program Files\\Microsoft Visual Studio",
		"C:\\Program Files (x86)\\Microsoft Visual Studio",
	];

	const listDirs = (dir) => {
		try {
			return fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => path.join(dir, entry.name));
		} catch {
			return [];
		}
	};

	for (const installRoot of installRoots) {
		for (const versionDir of listDirs(installRoot)) {
			for (const channelDir of [versionDir, ...listDirs(versionDir)]) {
				const direct = path.join(channelDir, "VC", "Auxiliary", "Build", "vcvarsall.bat");
				if (fs.existsSync(direct)) {
					return direct;
				}
				for (const edition of editions) {
					const nested = path.join(channelDir, edition, "VC", "Auxiliary", "Build", "vcvarsall.bat");
					if (fs.existsSync(nested)) {
						return nested;
					}
				}
			}
		}
	}

	return null;
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: POC_D3D_DIR,
			stdio: "inherit",
			windowsHide: true,
			...options,
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
			}
		});
	});
}

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
		["@echo off", `call "${vcvarsAll}" x64`, "if errorlevel 1 exit /b %errorlevel%", command, "exit /b %errorlevel%", ""].join(
			"\r\n",
		),
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
