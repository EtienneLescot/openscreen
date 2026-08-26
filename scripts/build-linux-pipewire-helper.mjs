// Builds the Linux cursor/capture helper (electron/native/pipewire-capture) and
// vendors it to electron/native/bin/linux-<arch>/, the folder
// pipeWireCursorRecordingSession.ts resolves at runtime.
//
// The Linux counterpart of build-macos-screencapturekit-helper.mjs and
// build-windows-wgc-helper.mjs.
//
// PIPEWIRE needs no pkg-config and no dev package: the C shim compiles against
// headers vendored in the repo and resolves libpipewire with dlopen at runtime.
// That is the point — libpipewire-0.3-dev is not installed on a stock Ubuntu,
// and requiring it would gate the whole Linux build on a package the base
// system does not ship.
//
// FFMPEG is different, and has been since the helper started encoding H.264.
// It is linked normally, its libraries are staged next to the binary by
// stageFfmpeg() below, and the RUNPATH points at them. Unlike the compositor
// addon there is no symbol renaming: the helper is a separate PROCESS, so
// Chromium's libffmpeg.so is never in its address space and cannot collide.
// See its Cargo.toml.
//
// The crate is NOT part of the crates/ workspace (see its Cargo.toml for why),
// so it is built by pointing cargo at its own manifest.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
	console.log("Skipping Linux PipeWire helper build: host platform is not Linux.");
	process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const helperName = "openscreen-pipewire-helper";
const crateDir = path.join(root, "electron", "native", "pipewire-capture");
const manifest = path.join(crateDir, "Cargo.toml");
// Mirrored into the crate's own build/ folder so `npm run dev` (candidate #2 in
// the session's path list) finds it without a packaging step.
const devDir = path.join(crateDir, "build");
// `linux-x64` / `linux-arm64` — must match platformArchTag() in
// electron/native-bridge/cursor/recording/pipeWireCursorRecordingSession.ts.
const tag = `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const outDir = path.join(root, "electron", "native", "bin", tag);

if (!fs.existsSync(manifest)) {
	console.error(`Helper crate not found at ${manifest}.`);
	process.exit(1);
}

const cargoVersion = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (cargoVersion.status !== 0) {
	console.error(
		[
			"Unable to build the Linux PipeWire helper because cargo is not on PATH.",
			"",
			"Install Rust (https://rustup.rs) and re-run, or source your existing toolchain:",
			"  source ~/.cargo/env",
		].join("\n"),
	);
	process.exit(1);
}

// No BINDGEN_EXTRA_CLANG_ARGS wrangling here on purpose. bindgen needs clang's
// freestanding headers (limits.h, stddef.h) and Ubuntu ships libclang.so.1 with
// no resource dir, but the crate's own build.rs already falls back to gcc's
// copies — see freestanding_header_args() there. Doing it here too would only
// cover the build that goes through this script and leave a bare `cargo build`
// broken, which is exactly the split build.rs exists to avoid.
const build = spawnSync("cargo", ["build", "--release", "--manifest-path", manifest], {
	cwd: crateDir,
	stdio: "inherit",
});
if (build.error) {
	console.error(`Failed to start cargo: ${build.error.message}`);
	process.exit(1);
}
if (build.status !== 0) {
	process.exit(build.status ?? 1);
}

const builtBinary = path.join(crateDir, "target", "release", helperName);
if (!fs.existsSync(builtBinary)) {
	console.error(`cargo build succeeded but ${builtBinary} was not found.`);
	process.exit(1);
}

for (const dir of [outDir, devDir]) {
	fs.mkdirSync(dir, { recursive: true });
	const dest = path.join(dir, helperName);
	// Unlink first. Writing over a file that is currently being executed fails
	// with ETXTBSY, and during development there is very often a helper still
	// running — a manual portal session left open, or one Electron did not reap.
	// Removing the directory entry leaves that process on its own inode, happily
	// unaffected, and frees the name for the new build.
	fs.rmSync(dest, { force: true });
	fs.copyFileSync(builtBinary, dest);
	fs.chmodSync(dest, 0o755);
	console.log(`Copied ${dest}`);
	stageFfmpeg(dir);
}

/**
 * Copies the vendored ffmpeg shared libraries into `<dir>/helper-ffmpeg/`.
 *
 * THE SUBDIRECTORY IS THE WHOLE POINT. `electron/native/bin/linux-x64/` already
 * holds libavcodec.so.62 and friends — but those are the copies whose every
 * symbol was renamed to `osff_*` by scripts/build-linux-compositor-addon.mjs,
 * so that the compositor addon does not bind to Chromium's own ffmpeg once
 * Electron dlopens it. Two different builds of the same soname, needed by two
 * different consumers, and only one of them can win a directory.
 *
 * The addon needs the renamed set next to itself; the helper needs the ordinary
 * set. So the helper's RUNPATH is `$ORIGIN/helper-ffmpeg` (see build.rs) and its
 * libraries live here. Putting them side by side produced exactly one symptom,
 * which the probe below catches:
 *
 *   undefined symbol: avcodec_send_frame, version LIBAVCODEC_62
 *
 * AND THE NAME IS PART OF IT. This was `<dir>/ffmpeg/` until a third claimant
 * turned up on the same path: fetch-ffmpeg.mjs vendors the static ffmpeg
 * EXECUTABLE to `<dir>/ffmpeg` (PINNED["linux-x64"].exe), and audioPeaks.ts
 * resolves that same path expecting a binary. Whoever ran last won, and the
 * loser failed obliquely — `EEXIST: mkdir .../ffmpeg` here, or `spawn …
 * EACCES` from audioPeaks when it found a directory where a binary belonged.
 * Two artifacts of different shapes cannot share a name; this one moved because
 * a bare `ffmpeg` means the executable to every other reader of this tree.
 */
function stageFfmpeg(dir) {
	const source = path.join(root, "crates", "thirdparty", "ffmpeg-linux64-lgpl-shared", "lib");
	if (!fs.existsSync(source)) {
		console.warn(
			`Vendored ffmpeg not found at ${source}; the helper will fall back to its ` +
				"build-time RUNPATH and will not work once packaged.",
		);
		return;
	}

	const target = path.join(dir, "helper-ffmpeg");
	fs.mkdirSync(target, { recursive: true });
	// Only the sonames the helper actually links, and only the real files —
	// the tree also holds unversioned `.so` symlinks that the loader never
	// consults at runtime.
	const wanted = /^lib(avcodec|avformat|avutil|avfilter|swscale|swresample)\.so\.\d+$/;
	let copied = 0;
	for (const entry of fs.readdirSync(source)) {
		if (!wanted.test(entry)) {
			continue;
		}
		const from = fs.realpathSync(path.join(source, entry));
		const to = path.join(target, entry);
		fs.rmSync(to, { force: true });
		fs.copyFileSync(from, to);
		copied++;
	}
	if (copied === 0) {
		throw new Error(`No ffmpeg libraries matched in ${source}; the helper cannot run.`);
	}
	console.log(`Staged ${copied} ffmpeg libraries into ${target}`);
}

// A helper that cannot dlopen libpipewire is useless, and the failure is
// otherwise invisible until someone records. `probeOnly` runs the whole
// non-interactive path — dlopen, D-Bus, AvailableCursorModes — and stops short
// of the portal's Start(), which is the only call that raises a picker.
const probe = spawnSync(path.join(outDir, helperName), ['{"probeOnly":true}'], {
	encoding: "utf8",
	timeout: 15_000,
});
if (probe.status === 0) {
	console.log(`Probe: ${probe.stdout.trim()}`);
} else {
	// Not fatal: a build machine legitimately may have no PipeWire or no portal
	// (a container, a CI runner). The binary is still correct.
	console.warn(
		`Probe failed on this machine, which is expected without a desktop session: ${(
			probe.stdout || probe.stderr
		).trim()}`,
	);
}
