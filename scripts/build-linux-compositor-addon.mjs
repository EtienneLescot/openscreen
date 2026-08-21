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
//      the six ffmpeg sonames are copied next to it, which makes the .node
//      self-contained wherever it is installed — no env var, no PATH surgery.

import { spawnSync } from "node:child_process";
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
	"libavfilter.so.11",
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
 * Debian/Ubuntu multiarch triplet for the host. Hardcoding the x86_64 one made
 * both libclang and gcc's stddef.h invisible on arm64, where the same libraries
 * live under /usr/lib/aarch64-linux-gnu.
 */
const MULTIARCH = process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";

/**
 * bindgen loads libclang at runtime. crates/.cargo/config.toml hardcodes a
 * Windows LLVM path, so on Linux we locate it ourselves rather than making
 * every contributor export LIBCLANG_PATH by hand.
 */
function resolveLibclangDir() {
	if (process.env.LIBCLANG_PATH) {
		return process.env.LIBCLANG_PATH;
	}
	const roots = [`/usr/lib/${MULTIARCH}`, "/usr/lib64", "/usr/lib"];
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

// No BINDGEN_EXTRA_CLANG_ARGS is set below, on purpose. On distributions shipping only
// `libclang.so.1` (no -dev package) clang cannot find its own `stddef.h`, and this
// script used to paper over that by pointing bindgen at gcc's copies. That only ever
// covered the build that goes through here: `cargo check -p openscreen-compositor` on a
// stock Ubuntu still died on `'stddef.h' file not found`, x86_64 included. The fallback
// now lives in crates/compositor/build.rs (`freestanding_header_args()`), which covers
// both entry points — and, being the only claimant, cannot lose to a worse guess made
// here. Setting the variable again would suppress it, since build.rs defers to a
// caller-supplied value.

/**
 * Prefix applied to every ffmpeg dynamic symbol. Anything unique works; this one is
 * short (the rename must fit ELF's string table, which patchelf grows for us) and
 * greppable.
 */
const SYMBOL_PREFIX = "osff_";

/** `nm -D --defined-only` over the vendored libraries, keeping the ffmpeg namespace. */
function collectFfmpegSymbols(ffmpegDir) {
	const names = new Set();
	for (const soname of FFMPEG_SONAMES) {
		const lib = path.join(ffmpegDir, "lib", soname);
		const out = spawnSync("nm", ["-D", "--defined-only", lib], { encoding: "utf8" });
		if (out.status !== 0) {
			throw new Error(`nm -D failed on ${lib}: ${out.stderr}`);
		}
		for (const line of out.stdout.split("\n")) {
			// "0000000000012345 T av_frame_alloc@@LIBAVUTIL_60"
			const match = line.match(/^\s*[0-9a-f]+\s+\S+\s+(\S+)$/);
			if (!match) continue;
			const name = match[1].split("@")[0];
			if (/^(av|sws_|swr_)/.test(name)) {
				names.add(name);
			}
		}
	}
	if (names.size === 0) {
		throw new Error(
			"No ffmpeg symbols found in the vendored libraries. Either the tree is wrong or " +
				"`nm` could not read .dynsym — the addon would silently bind to Chromium's ffmpeg.",
		);
	}
	return [...names].sort();
}

/**
 * Stage renamed copies of the ffmpeg libraries and return the directory holding them.
 *
 * WHY THIS EXISTS. Electron links `libffmpeg.so` — Chromium's own stripped ffmpeg — as a
 * DT_NEEDED dependency, so it occupies the global symbol scope before any addon is
 * dlopen'd. ELF has a single flat namespace, so the addon's `avformat_open_input` and
 * friends bind to Chromium's build no matter what the addon's RUNPATH says: the symbols
 * are already satisfied. The user-visible result is
 * AVERROR_PROTOCOL_NOT_FOUND on an ordinary path, because Chromium's ffmpeg carries no
 * `file` protocol; the quieter result is an addon running against an ffmpeg it was
 * neither built nor tested against.
 *
 * Renaming removes the collision outright. The alternative — RTLD_DEEPBIND, which
 * reorders the lookup scope instead — was measured to crash the process: Electron
 * interposes malloc/free globally, and deep-binding desynchronises the allocator, so a
 * buffer allocated by glibc's realpath() inside PartitionAlloc gets freed by glibc's
 * free(). Changing NAMES is safe; changing SCOPE is not.
 *
 * Symbol versioning is not an option either: the references are already versioned
 * (`avformat_open_input@LIBAVFORMAT_62`) and still bind to Chromium's definition.
 */
function stageRenamedFfmpeg(ffmpegDir) {
	const patchelf = resolvePatchelf();
	const symbols = collectFfmpegSymbols(ffmpegDir);
	const staging = path.join(CRATES_DIR, "target", "ffmpeg-renamed");

	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(path.join(staging, "lib"), { recursive: true });
	// bindgen still parses the ORIGINAL headers: only the binary symbol names change,
	// never the C declarations.
	fs.cpSync(path.join(ffmpegDir, "include"), path.join(staging, "include"), {
		recursive: true,
	});

	const mapFile = path.join(staging, "symbols.map");
	fs.writeFileSync(mapFile, `${symbols.map((s) => `${s} ${SYMBOL_PREFIX}${s}`).join("\n")}\n`);

	for (const soname of FFMPEG_SONAMES) {
		const staged = path.join(staging, "lib", soname);
		fs.copyFileSync(fs.realpathSync(path.join(ffmpegDir, "lib", soname)), staged);
		fs.chmodSync(staged, 0o755);
		// Renames DEFINED symbols and UNDEFINED ones alike, which matters: the ffmpeg
		// libraries call into each other, so libavformat's reference to libavutil's
		// av_frame_alloc has to move in lockstep with the definition.
		const renamed = spawnSync(patchelf, ["--rename-dynamic-symbols", mapFile, staged], {
			encoding: "utf8",
		});
		if (renamed.status !== 0) {
			throw new Error(`patchelf failed on ${soname}: ${renamed.stderr}`);
		}
		// `-lavformat` resolves through the unversioned name at link time.
		fs.symlinkSync(soname, path.join(staging, "lib", soname.replace(/\.so\..*$/, ".so")));
	}

	console.log(`Renamed ${symbols.length} ffmpeg symbols with the "${SYMBOL_PREFIX}" prefix`);
	return staging;
}

/** patchelf from PATH, or a user-local build — it is not installed by default anywhere. */
function resolvePatchelf() {
	const candidates = [
		process.env.PATCHELF,
		path.join(process.env.HOME ?? "", ".local", "bin", "patchelf"),
		"/usr/bin/patchelf",
	].filter(Boolean);
	const found = candidates.find((candidate) => fs.existsSync(candidate));
	if (found) {
		return found;
	}
	const onPath = spawnSync("patchelf", ["--version"], { encoding: "utf8" });
	if (onPath.status === 0) {
		return "patchelf";
	}
	throw new Error(
		"patchelf not found — it rewrites the ffmpeg symbol names so the addon cannot bind to " +
			"Chromium's bundled ffmpeg. Install it (apt install patchelf, or nix: pkgs.patchelf), " +
			"or set PATCHELF to a built copy.",
	);
}

/**
 * Fail the build if any ffmpeg symbol is still imported under its original name.
 *
 * Without this the failure is SILENT: the addon loads, binds to Chromium's ffmpeg, and
 * the editor merely says "Preview unavailable on this machine" at runtime.
 */
function assertNoUnprefixedFfmpegImports(nodePath) {
	const out = spawnSync("nm", ["-D", "--undefined-only", nodePath], { encoding: "utf8" });
	if (out.status !== 0) {
		throw new Error(`nm -D failed on ${nodePath}: ${out.stderr}`);
	}
	const leaked = out.stdout
		.split("\n")
		.map((line) => (line.match(/^\s*U\s+(\S+)$/) ?? [])[1])
		.filter(Boolean)
		.map((name) => name.split("@")[0])
		.filter((name) => /^(av|sws_|swr_)/.test(name) && !name.startsWith(SYMBOL_PREFIX));

	if (leaked.length > 0) {
		throw new Error(
			`${leaked.length} ffmpeg symbols are still imported unprefixed (${leaked.slice(0, 5).join(", ")}` +
				`${leaked.length > 5 ? ", …" : ""}). The addon would bind to Chromium's ffmpeg at runtime.`,
		);
	}
	console.log("Verified: no unprefixed ffmpeg imports remain in the addon");
}

const ffmpegDir = resolveFfmpegDir();
const stagedFfmpegDir = stageRenamedFfmpeg(ffmpegDir);

await run("cargo", ["build", "-p", "compositor-view-napi", "--release"], {
	env: {
		...process.env,
		FFMPEG_DIR: stagedFfmpegDir,
		OPENSCREEN_FFMPEG_SYMBOL_PREFIX: SYMBOL_PREFIX,
		LIBCLANG_PATH: resolveLibclangDir(),
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

// Ship the RENAMED libraries, not the originals: the addon now imports the prefixed
// names and a stock libavformat.so.62 would not satisfy it. The two are a matched set.
for (const soname of FFMPEG_SONAMES) {
	const source = path.join(stagedFfmpegDir, "lib", soname);
	if (!fs.existsSync(source)) {
		throw new Error(
			`${soname} not found in ${path.join(stagedFfmpegDir, "lib")}. The vendored ffmpeg tree ` +
				"does not match the sonames the addon links against — check the pinned release.",
		);
	}
	fs.copyFileSync(fs.realpathSync(source), path.join(OUT_DIR, soname));
}
console.log(`Copied ${FFMPEG_SONAMES.length} renamed ffmpeg shared libraries alongside the addon`);

assertNoUnprefixedFfmpegImports(dest);
