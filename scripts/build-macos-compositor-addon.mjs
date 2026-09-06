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

import { execFileSync, spawn } from "node:child_process";
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

/**
 * Install by atomic rename, NEVER by copying over the existing file.
 *
 * macOS validates code pages lazily against the Mach-O signature. Overwriting a
 * loaded `.node` in place leaves the kernel's page cache holding pages from the OLD
 * binary on a vnode whose signature is now the NEW one, and the next process to fault
 * one of those pages is killed outright:
 *
 *     signal: SIGKILL (Code Signature Invalid)
 *     termination: { namespace: "CODESIGNING", indicator: "Invalid Page" }
 *
 * No JS error, no stack — the app just dies at `require()`. It only bites on the
 * SECOND build onwards, which is what makes it so confusing: the addon works, you
 * change one line of Rust, and now nothing loads.
 *
 * Writing to a temp name in the same directory and renaming gives the new content a
 * fresh inode, so the stale pages belong to a vnode nothing will fault again.
 */
function installAtomically(from, to) {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	const tmp = `${to}.${process.pid}.tmp`;
	fs.copyFileSync(from, tmp);
	fs.renameSync(tmp, to);
}

/**
 * Every Mach-O load command that points outside the OS's own prefixes. `otool -D`/`-L`
 * both echo the filename on the first line, so both lists skip it.
 */
function absolutePaths(file) {
	const id = execFileSync("otool", ["-D", file], { encoding: "utf8" })
		.split("\n")
		.slice(1) // first line is the filename echoed back
		.map((l) => l.trim())
		.filter(Boolean);
	const deps = execFileSync("otool", ["-L", file], { encoding: "utf8" })
		.split("\n")
		.slice(1) // ditto
		.map((l) => l.trim().split(" ")[0])
		.filter(Boolean);
	return [...id, ...deps].filter(
		(p) => p.startsWith("/") && !p.startsWith("/usr/lib/") && !p.startsWith("/System/"),
	);
}

/**
 * Vendors the ffmpeg dylibs next to the addon and rewrites every install name to
 * `@rpath`, so the packaged app loads its own copies instead of a build-machine path.
 *
 * Straight out of `cargo`, the `.node` references its dependencies by ABSOLUTE path
 * (`otool -L` shows `/Users/…/crates/thirdparty/…/libavcodec.62.dylib`). That works on
 * the machine that built it and nowhere else — the installed app would fail at
 * `require()` with a dyld error naming a directory the user has never had. Windows does
 * not hit this because `LoadLibrary` searches `PATH`, which is what
 * `ensureFfmpegSharedDllsOnPath()` prepends; macOS has no such search, so the fix has to
 * be baked into the binary.
 *
 * Three edits per artefact:
 *   - each dylib's own id becomes `@rpath/<name>`;
 *   - every inter-library reference (libavcodec -> libavutil, and so on) is rewritten;
 *   - the addon gains `@loader_path` as an rpath, so `@rpath/libavutil.60.dylib`
 *     resolves next to `compositor_view.node` — which is exactly where electron-builder
 *     puts them via the mac `extraResources` filter `darwin-*​/*`.
 *
 * Re-signing is required and not optional: `install_name_tool` invalidates the existing
 * ad-hoc signature, and macOS kills a process that faults a page of a binary whose
 * signature no longer matches (the same `SIGKILL (Code Signature Invalid)` documented on
 * `installAtomically` above).
 */
function vendorFfmpegDylibs(nodePath, ffmpegDir) {
	const outDir = path.dirname(nodePath);
	const libDir = path.join(ffmpegDir, "lib");
	const linked = execFileSync("otool", ["-L", nodePath], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim().split(" ")[0])
		.filter((p) => /\/lib(av|sw)\w+\.\d+\.dylib$/.test(p));
	if (linked.length === 0) {
		throw new Error(`${nodePath} links no ffmpeg dylib — nothing to vendor, which is wrong.`);
	}

	const names = linked.map((p) => path.basename(p));
	for (const name of names) {
		const from = path.join(libDir, name);
		if (!fs.existsSync(from)) {
			throw new Error(`Missing ${from}; the addon links it but the SDK does not ship it.`);
		}
		const to = path.join(outDir, name);
		fs.copyFileSync(from, to);
		fs.chmodSync(to, 0o755);
		execFileSync("install_name_tool", ["-id", `@rpath/${name}`, to]);
	}
	// Inter-library references, and the addon's own.
	for (const target of [...names.map((n) => path.join(outDir, n)), nodePath]) {
		const deps = execFileSync("otool", ["-L", target], { encoding: "utf8" })
			.split("\n")
			.map((line) => line.trim().split(" ")[0])
			.filter((p) => p.startsWith("/") && /lib(av|sw)\w+\.\d+\.dylib$/.test(p));
		for (const dep of deps) {
			execFileSync("install_name_tool", ["-change", dep, `@rpath/${path.basename(dep)}`, target]);
		}
		execFileSync("install_name_tool", ["-add_rpath", "@loader_path", target]);
		// install_name_tool invalidates the signature; re-sign ad-hoc.
		execFileSync("codesign", ["--force", "--sign", "-", target]);
	}

	// cargo stamps the cdylib's own id with the absolute path it was built at
	// (`crates/target/release/deps/libcompositor_view.dylib`). Nothing resolves
	// through it — `require()` dlopens the file by path and never reads
	// LC_ID_DYLIB — so this is not a load failure. It is a build-machine path,
	// complete with the builder's home directory and checkout name, shipped
	// inside a release artefact: it defeats reproducible builds and leaks a
	// filesystem layout to anyone who runs `otool -D` on the installed app.
	execFileSync("install_name_tool", ["-id", `@rpath/${path.basename(nodePath)}`, nodePath]);
	execFileSync("codesign", ["--force", "--sign", "-", nodePath]);

	// The old check only grepped for `lib(av|sw)`, so it could not have caught
	// the id above — nor any future non-ffmpeg dependency that arrives absolute.
	// Assert the real invariant instead: nothing outside the OS's own prefixes
	// may be referenced by absolute path.
	for (const file of [nodePath, ...names.map((n) => path.join(outDir, n))]) {
		const remaining = absolutePaths(file);
		if (remaining.length > 0) {
			throw new Error(
				`${path.basename(file)} still references build-machine paths after rewriting: ` +
					remaining.join(", "),
			);
		}
	}
	console.log(`Vendored ${names.length} ffmpeg dylibs next to ${path.basename(nodePath)}`);
	console.log(`No absolute build-machine paths remain in ${path.basename(nodePath)} or its dylibs`);
}

/**
 * Stages the SDK's `ffmpeg` BINARY next to the addon's vendored dylibs, so the packaged
 * app has the CLI that `resolveFfmpeg()` (electron/media/audioPeaks.ts) and native STT
 * audio extraction (electron/stt/extractAudio.ts) spawn.
 *
 * Without it the .app carries libav*.dylib but no executable, and every transcription on
 * a machine without a system ffmpeg dies with FfmpegUnavailableError — the failure the
 * renderer can only show as "Failed to fetch" (#616). Windows never had this gap: its
 * installer ships `ffmpeg-shared.exe` beside the DLLs it links.
 *
 * The binary leaves `make install` referencing the SDK's lib/ — by absolute path or by
 * `@executable_path/../lib/`, depending on the configure — and neither survives the move
 * into electron-builder's extraResources. Rewriting every lib reference to `@rpath/<name>`
 * and adding `@loader_path` points it at the very dylibs `vendorFfmpegDylibs` put beside
 * it, whose ids already are `@rpath/<name>`.
 */
function stageFfmpegBinary(outDir, ffmpegDir) {
	const from = path.join(ffmpegDir, "bin", "ffmpeg");
	if (!fs.existsSync(from)) {
		throw new Error(`No ffmpeg binary at ${from}; the SDK tree is incomplete.`);
	}
	const to = path.join(outDir, "ffmpeg");
	installAtomically(from, to);
	fs.chmodSync(to, 0o755);

	const deps = execFileSync("otool", ["-L", to], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim().split(" ")[0])
		.filter((p) => /(^\/|@executable_path).*lib(av|sw)\w+\.\d+\.dylib$/.test(p));
	if (deps.length === 0) {
		throw new Error(`${to} links no ffmpeg dylib — nothing to rewrite, which is wrong.`);
	}
	// The CLI links more of the SDK than the addon does (libavdevice, libpostproc, …).
	// `vendorFfmpegDylibs` staged only what the addon needs, so copy anything still
	// missing — with the same `@rpath/<name>` id and inter-library rewrites, so the
	// chain resolves the same way the addon's set does.
	const copied = [];
	for (const dep of deps) {
		const name = path.basename(dep);
		const staged = path.join(outDir, name);
		if (fs.existsSync(staged)) continue;
		const sdkLib = path.join(ffmpegDir, "lib", name);
		if (!fs.existsSync(sdkLib)) {
			throw new Error(`Missing ${sdkLib}; the binary links it but the SDK does not ship it.`);
		}
		fs.copyFileSync(sdkLib, staged);
		fs.chmodSync(staged, 0o755);
		execFileSync("install_name_tool", ["-id", `@rpath/${name}`, staged]);
		copied.push(staged);
	}
	for (const file of [...copied, to]) {
		const fileDeps = execFileSync("otool", ["-L", file], { encoding: "utf8" })
			.split("\n")
			.map((line) => line.trim().split(" ")[0])
			.filter((p) => /(^\/|@executable_path).*lib(av|sw)\w+\.\d+\.dylib$/.test(p));
		for (const dep of fileDeps) {
			execFileSync("install_name_tool", ["-change", dep, `@rpath/${path.basename(dep)}`, file]);
		}
		execFileSync("install_name_tool", ["-add_rpath", "@loader_path", file]);
		// install_name_tool invalidates the signature; re-sign ad-hoc.
		execFileSync("codesign", ["--force", "--sign", "-", file]);
	}

	const remaining = absolutePaths(to);
	if (remaining.length > 0) {
		throw new Error(
			`${path.basename(to)} still references build-machine paths after rewriting: ` +
				remaining.join(", "),
		);
	}
	console.log(`Staged ffmpeg binary at ${to} (rewritten to @rpath beside the vendored dylibs)`);
}

/**
 * Refuses to package a GPL ffmpeg. `--enable-gpl` pulls x264/x265 in and relicenses this
 * MIT app; a Homebrew ffmpeg is exactly that and is an easy thing to point MAC_FFMPEG_DIR
 * at by accident. Same check `fetch-ffmpeg.mjs` runs on the Windows build.
 */
function assertLgpl(ffmpegDir) {
	const bin = path.join(ffmpegDir, "bin", "ffmpeg");
	if (!fs.existsSync(bin)) {
		console.warn(`No ffmpeg binary at ${bin}; skipping the licence check.`);
		return;
	}
	const banner = execFileSync(bin, ["-hide_banner", "-L"], { encoding: "utf8" });
	if (/GNU General Public License/i.test(banner) || !/Lesser General Public/i.test(banner)) {
		throw new Error(
			`${ffmpegDir} is not an LGPL build — its own -L banner says so.\n` +
				"Homebrew's ffmpeg is GPL (--enable-gpl). Build the LGPL tree instead:\n\n" +
				`${FFMPEG_RECIPE}\n`,
		);
	}
	console.log("ffmpeg licence: LGPL (checked via `ffmpeg -L`)");
}

assertLgpl(macFfmpegDir);

const dest = path.join(BUILD_OUT_DIR, "compositor_view.node");
installAtomically(builtDylib, dest);

// The arch-tagged dir is the first candidate compositorViewService.ts probes, and the
// one electron-builder ships via extraResources. Keeping both in sync means a dev build
// and a packaged build load the same binary.
const archBinDir = path.join(ROOT, "electron", "native", "bin", `darwin-${process.arch}`);
const archDest = path.join(archBinDir, "compositor_view.node");
installAtomically(builtDylib, archDest);

// Only the arch-tagged copy ships (mac `extraResources`, filter `darwin-*/*`), so that
// is the one that gets its dylibs and its @rpath.
vendorFfmpegDylibs(archDest, macFfmpegDir);
stageFfmpegBinary(archBinDir, macFfmpegDir);

console.log(`Built  ${builtDylib}`);
console.log(`Copied ${dest}`);
console.log(`Copied ${archDest}`);
console.log(
	`\nThe shipped copy (${archDest}) carries its own LGPL ffmpeg dylibs and resolves them\n` +
		"through @rpath/@loader_path, so the packaged app does not depend on this machine's\n" +
		"paths. The dev copy under electron/native/compositor-view/build/ keeps its absolute\n" +
		"links, which is fine — it never leaves this checkout.",
);
