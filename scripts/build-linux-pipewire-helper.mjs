// Builds the Linux cursor/capture helper (electron/native/pipewire-capture) and
// vendors it to electron/native/bin/linux-<arch>/, the folder
// pipeWireCursorRecordingSession.ts resolves at runtime.
//
// The Linux counterpart of build-macos-screencapturekit-helper.mjs and
// build-windows-wgc-helper.mjs. Two things are deliberately absent compared to
// the compositor addon's Linux build script:
//
//   1. No pkg-config, no FFMPEG_DIR, no libclang. The helper's C shim compiles
//      against headers vendored in the repo and resolves libpipewire with
//      dlopen at runtime, so `cargo` and a C compiler are the entire toolchain.
//      That is the point: libpipewire-0.3-dev is not installable on every
//      contributor's box, and requiring it would gate the Linux build on a
//      package Ubuntu does not ship by default.
//
//   2. No RUNPATH surgery. Nothing is dynamically linked beyond libc, so the
//      binary is relocatable as-is.
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
