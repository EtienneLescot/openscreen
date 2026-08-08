// Provisions the bundled ffmpeg used by the native export encoder into
// electron/native/bin/<platform>-<arch>/, alongside wgc-capture and the whisper
// binaries. That directory is gitignored and shipped via electron-builder's
// extraResources, so this runs at build time rather than committing binaries.
//
// Why bundle ffmpeg at all: WebCodecs reaches the platform's hardware encoder
// but measures ~8 fps @1080p where native ffmpeg does ~165 on the same GPU. The
// gap is Chromium's per-frame overhead, not the silicon.
//
// SECOND PURPOSE (Windows only): the native D3D11 compositor addon
// (crates/compositor-view-napi) *dynamically links* against ffmpeg's shared
// libraries (avcodec/avformat/avutil/…) at `require()` time — a completely
// different artifact from the static `ffmpeg.exe` above (BtbN's "-shared"
// build variant vs. its default static one). Without those DLLs reachable on
// `PATH`, the addon's `require()` fails silently and the app falls back to a
// no-op compositor (see electron/native-bridge/services/compositorViewService.ts).
// This script vendors both from the *same* pinned release tag/commit so the
// static exe and the shared DLLs are always the same audited ffmpeg build.
//
// SUPPLY CHAIN. This binary is signed and shipped to every user, so nothing here
// floats:
//   - Pinned to an immutable dated release tag, never `latest` (which is an
//     alias that moves daily).
//   - Pinned to a *release-branch* build (n8.1.x), never the `N-…` master
//     snapshots BtbN also publishes. Master is not a release.
//   - 8.1.x on purpose: it is the version the 165 fps h264_amf benchmark was
//     taken with, so what we ship is what we measured.
//   - SHA-256 verified before the archive is opened. Update PINNED together —
//     tag, asset name and digest are one unit.
//   Source approved by Etienne (2026-07-16). BtbN is linked from ffmpeg.org's
//   download page and published on winget as BtbN.FFmpeg.LGPL.
//   Attribution + source offer for what we redistribute: THIRD-PARTY-NOTICES.md,
//   which electron-builder ships into resources/.
//
// LICENSING — the other thing this script exists to protect:
//   ffmpeg is LGPL *by default*. It becomes GPL only when built with
//   --enable-gpl (which pulls x264/x265) or --enable-nonfree (fdk-aac), and it
//   is all-or-nothing: one GPL component relicenses the whole binary, which
//   would contaminate this MIT app. We take BtbN's *-lgpl assets AND verify what
//   we got before vendoring. Never swap in a "gpl" asset for the extra encoders:
//   there is nothing in them we need — the hardware encoders are all LGPL.
//
// WHAT ACTUALLY SHIPS: only the shared av*.dll set, which the compositor addon
// dlopens. electron-builder excludes the static ffmpeg.exe from the installer
// ("!win32-*/ffmpeg.exe") — it is a bench tool, and shipping a large binary no
// runtime code opens is cost with no benefit. It still lands in this directory
// because the licence check below reads it.
//
// NOTE: the plan this was vendored for is REFUTED. Feeding native ffmpeg from
// the renderer measured 2.1x SLOWER than the WebCodecs path it was to replace —
// the wall is the compositor, not the encoder. See
// technical-documentation/engineering/rendering-performance.md. The binary stays
// because a future native core would still need a licence-gated H.264 encoder;
// nothing here ships on the export path today.
//
// macOS: BtbN publishes no macOS target, so darwin is not handled here.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/**
 * Immutable dated tag. `latest` is an alias that moves — do not use it here.
 *
 * MUST be a **last-day-of-the-month** autobuild. Immutable is not the same as
 * permanent: BtbN keeps only ~15 days of daily autobuilds and prunes the rest,
 * retaining month-end builds long term. A daily tag therefore 404s about two
 * weeks after it is pinned, which breaks `npm run fetch:ffmpeg*` — and with it
 * `build:linux` and `build:win`, which `publish-release` both depend on. That
 * has already happened twice: `autobuild-2026-07-15-14-01` (fixed in 81e05972)
 * and `autobuild-2026-07-30-13-32`, a Thursday.
 *
 * Check before re-pinning: `gh api repos/BtbN/FFmpeg-Builds/releases -q
 * '.[].tag_name'` — anything older than ~15 days that is still listed is a
 * month-end build, and only those are safe.
 */
const RELEASE_TAG = "autobuild-2026-07-31-14-10";
const BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE_TAG}`;

/** Tag, asset and digest move together. Re-pin all three or none. */
const PINNED = {
	"win32-x64": {
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-8.1.zip",
		sha256: "089e4169e93b2b3f3acbfced3c0704d24276a225641bdda04d796d28b07a2a38",
		exe: "ffmpeg.exe",
	},
	"win32-arm64": {
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-winarm64-lgpl-8.1.zip",
		sha256: "5b55ac00360811ef08513c76240c93e52a369cd29040d21799e7758fc7e9eaea",
		exe: "ffmpeg.exe",
	},
	"linux-x64": {
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-lgpl-8.1.tar.xz",
		sha256: "8c8b2897f2a8093ae2d985f7f1867d218451d4c567c1b2437f86a7c73a950b9f",
		exe: "ffmpeg",
	},
	"linux-arm64": {
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-linuxarm64-lgpl-8.1.tar.xz",
		sha256: "0c8716a94ac1fe22eb56e7a0cedd0f00c1d8fae712ec19973d679a7a87916743",
		exe: "ffmpeg",
	},
};

/**
 * The "-shared" sibling of PINNED, from the *same* release tag and source
 * commit (n8.1.2-34-g9b6c8969e0) — same ffmpeg, just built with shared libraries
 * instead of static linking.
 *
 * Two consumers now: the Windows D3D11 compositor addon, and the Linux
 * pipewire-capture helper, whose build.rs links against
 * `crates/thirdparty/ffmpeg-linux64-lgpl-shared`. Nothing provisioned that tree,
 * so `npm run build:linux` failed in cargo with "vendored ffmpeg headers are
 * missing" — invisible for months because the Linux release job was disabled.
 * darwin has no entry because BtbN publishes no macOS build; that path compiles
 * ffmpeg from source (scripts/fetch-ffmpeg-macos.mjs).
 */
const SHARED_PINNED = {
	"linux-x64": {
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-lgpl-shared-8.1.tar.xz",
		sha256: "c882a80f06617149198a98a07a0880a7e881953ae9f9cb931f5be09a4f93caae",
	},
	"linux-arm64": {
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-linuxarm64-lgpl-shared-8.1.tar.xz",
		sha256: "eec386482ac6799bb547b5f507dedd19ef6354eee0ca4ddb04bdd053d03c3cfb",
	},
	"win32-x64": {
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-shared-8.1.zip",
		sha256: "c222a490dde4e7059f45495deef6bfb98dbcacc2b43df5b607546252037aa95c",
	},
	"win32-arm64": {
		asset: "ffmpeg-n8.1.2-34-g9b6c8969e0-winarm64-lgpl-shared-8.1.zip",
		sha256: "4abab52904037ecad91b54811d69005a0b2e1f591242fd1517d32b299246ece0",
	},
};

/** Enabling any of these makes the whole binary GPL. Source: ffmpeg.org/legal.html. */
const GPL_LIBS = [
	"libx264",
	"libx265",
	"libxvid",
	"libxavs",
	"libxavs2",
	"libdavs2",
	"libvidstab",
	"librubberband",
	"libcdio",
	"frei0r",
	"avisynth",
];
/** Worse than GPL: these make the binary unredistributable at all. */
const NONFREE_LIBS = ["libfdk-aac", "libfdk_aac"];

/** The encoders the export path actually selects, per platform. */
const WANTED_ENCODERS = {
	win32: ["h264_nvenc", "h264_qsv", "h264_amf"],
	linux: ["h264_nvenc", "h264_vaapi"],
};

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
	if (r.error) throw r.error;
	return r;
}

/**
 * Refuses to vendor anything that would relicense the app. This is now the only
 * licence gate — the runtime twin it used to mirror
 * (electron/media/ffmpegCapabilities.ts) went with the web export pipeline, and
 * nothing in the app spawns ffmpeg any more.
 */
function assertLgpl(exePath, extraEnv) {
	const problems = [];
	// A *shared* build's ffmpeg cannot resolve its own libav*.so without being told
	// where they are, and a binary that fails to start prints nothing — which this
	// function would read as "unrecognised licence" and refuse to vendor. The caller
	// passes LD_LIBRARY_PATH for those; static builds pass nothing.
	const opts = extraEnv ? { env: { ...process.env, ...extraEnv } } : {};

	// `ffmpeg -L` prints the licence TEXT. This is the authoritative statement:
	// an LGPL build says "GNU Lesser General Public License", a GPL one says
	// "GNU General Public License". Note there is NO "License:" line in
	// `-version` — only `configuration:`.
	const license = run(exePath, ["-hide_banner", "-L"], opts).stdout ?? "";
	if (!/Lesser General Public License/i.test(license)) {
		const what = /General Public License/i.test(license) ? "GPL" : "unrecognised licence";
		problems.push(`-L reports ${what}, not LGPL`);
	}

	// `-buildconf` lists the configure flags one per line; `-version` has them on
	// one `configuration:` line. Read both so a build that answers only one still
	// gets checked.
	const conf =
		(run(exePath, ["-hide_banner", "-buildconf"], opts).stdout ?? "") +
		(run(exePath, ["-hide_banner", "-version"], opts).stdout ?? "");
	for (const flag of ["--enable-gpl", "--enable-nonfree"]) {
		if (new RegExp(`(^|\\s)${flag}(\\s|$)`, "m").test(conf))
			problems.push(`configured with ${flag}`);
	}
	for (const lib of [...GPL_LIBS, ...NONFREE_LIBS]) {
		if (new RegExp(`(^|\\s)--enable-${lib}(\\s|$)`, "m").test(conf)) problems.push(`links ${lib}`);
	}

	// Belt and braces: whatever the flags claim, the binary must not actually
	// expose a GPL encoder.
	// `opts` here too: without it a SHARED build cannot resolve its own libav*.so,
	// prints nothing, and this check passes on an empty string — silently vouching
	// for exactly the binaries it exists to reject. Measured: 0 bytes without the
	// env, 229 encoders with it.
	const encoders = run(exePath, ["-hide_banner", "-encoders"], opts).stdout ?? "";
	for (const lib of ["libx264", "libx265"]) {
		if (new RegExp(`\\s${lib}\\s`).test(encoders)) problems.push(`exposes the ${lib} encoder`);
	}

	if (problems.length > 0) {
		throw new Error(
			"This ffmpeg is NOT an LGPL build and must not be shipped:\n" +
				`${problems.map((p) => `  - ${p}`).join("\n")}\n` +
				"Bundling it would relicense OpenScreen under the GPL.",
		);
	}
	const ver = run(exePath, ["-hide_banner", "-version"], opts).stdout ?? "";
	return ver.split("\n")[0]?.trim() ?? "";
}

function reportEncoders(exePath, platform) {
	const encoders = run(exePath, ["-hide_banner", "-encoders"]).stdout ?? "";
	const wanted = WANTED_ENCODERS[platform] ?? [];
	const found = wanted.filter((e) => new RegExp(`\\s${e}\\s`).test(encoders));
	const missing = wanted.filter((e) => !found.includes(e));
	console.log(`  hardware encoders: ${found.join(", ") || "(none)"}`);
	if (missing.length > 0) {
		// Not fatal: which encoders a build exposes is separate from which GPU the
		// machine has. selectVideoEncoder() probes at runtime regardless.
		console.log(`  not in this build: ${missing.join(", ")}`);
	}
}

/**
 * Windows 10+ ships bsdtar at System32\tar.exe, which reads zip. Resolve it
 * explicitly: a dev shell (Git Bash, MSYS) usually puts GNU tar first on PATH,
 * and GNU tar cannot read zip at all.
 */
function tarBin() {
	if (process.platform !== "win32") return "tar";
	const sys32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
	return fs.existsSync(sys32) ? sys32 : "tar";
}

function extract(archive, destDir) {
	fs.mkdirSync(destDir, { recursive: true });
	// Run from destDir with a bare filename: given an absolute Windows path, tar
	// reads "C:\..." as host:path and tries to resolve a host called C.
	const r = run(tarBin(), [archive.endsWith(".zip") ? "-xf" : "-xJf", path.basename(archive)], {
		cwd: destDir,
		stdio: "inherit",
	});
	if (r.status !== 0) throw new Error(`tar failed to extract ${path.basename(archive)}`);
}

/** BtbN archives nest everything under a versioned dir; find the exe wherever it landed. */
function findExe(dir, name) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const hit = findExe(p, name);
			if (hit) return hit;
		} else if (entry.name === name) {
			return p;
		}
	}
	return null;
}

/**
 * Where crates/.cargo/config.toml pins FFMPEG_DIR, resolved to an absolute path.
 *
 * Read rather than hardcoded: scripts/build-windows-compositor-addon.mjs refuses
 * to run cargo unless this exact directory exists, so the pin is the one source
 * of truth for both ends. Returns null when there is nothing to satisfy.
 */
function ffmpegSdkDest() {
	const cratesDir = path.join(ROOT, "crates");
	// Linux is not in crates/.cargo/config.toml: its consumer is
	// electron/native/pipewire-capture, whose build.rs defaults to this exact path
	// (and honours FFMPEG_DIR when set). Mirror that default rather than adding a
	// second place the two could disagree.
	if (process.platform === "linux") {
		return path.join(cratesDir, "thirdparty", "ffmpeg-linux64-lgpl-shared");
	}
	const configPath = path.join(cratesDir, ".cargo", "config.toml");
	if (!fs.existsSync(configPath)) return null;
	// FFMPEG_DIR is declared `relative = true`, i.e. relative to crates/.
	const pin = fs
		.readFileSync(configPath, "utf8")
		.match(/FFMPEG_DIR\s*=\s*\{\s*value\s*=\s*"([^"]+)"/);
	return pin ? path.join(cratesDir, pin[1]) : null;
}

/**
 * Vendors the headers and import libs the compositor addon links against at
 * BUILD time, out of the archive we already downloaded and verified.
 *
 * The runtime DLLs alone are not enough: cargo needs include/ and lib/ to link
 * compositor-view-napi. That tree only ever existed as a local junction on a dev
 * machine, so CI could never build the addon — which is why the Windows job
 * started failing the moment build:native:compositor joined build:win. Taking it
 * from the same SHA-256- and LGPL-verified archive avoids a second download and
 * keeps the linked ffmpeg identical to the DLLs we ship.
 */
function vendorFfmpegSdk(tmp, dest) {
	// BtbN nests bin/ include/ lib/ under one versioned dir; find it by its headers.
	const root = findDirContaining(tmp, "include");
	if (!root) {
		throw new Error(
			"No include/ directory inside the shared archive — cannot vendor the ffmpeg SDK.",
		);
	}
	// A dev machine has this as a junction; rm unlinks it rather than eating the
	// target, and we only get here on --force or when it is genuinely absent.
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	// `verbatimSymlinks` matters on Linux, where BtbN ships lib/libavcodec.so ->
	// libavcodec.so.62.28.102. WITHOUT it, cpSync RESOLVES each link and writes an
	// absolute one pointing back into the extraction temp dir — which this function's
	// caller deletes immediately after, leaving every dev symlink dangling. The
	// headers then satisfy build.rs's assert while `-lavcodec` fails at link time,
	// which is exactly how this presented. Windows has no symlinks here, so the flag
	// is a no-op there.
	fs.cpSync(root, dest, { recursive: true, verbatimSymlinks: true });
	console.log(`Vendored ffmpeg SDK (include/ + lib/) -> ${dest}`);
}

/** First directory at or under `dir` that has a child named `name`. */
function findDirContaining(dir, name) {
	if (fs.existsSync(path.join(dir, name))) return dir;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const hit = findDirContaining(path.join(dir, entry.name), name);
		if (hit) return hit;
	}
	return null;
}

/** What a shared ffmpeg library is called on this platform: `avcodec-62.dll` vs
 *  `libavcodec.so.62`. Both are what the app loads at runtime. */
function isSharedLib(name) {
	const n = name.toLowerCase();
	return process.platform === "win32" ? n.endsWith(".dll") : /\.so(\.\d+)*$/.test(n);
}

/** Every shared ffmpeg library anywhere under `dir` (BtbN nests a `bin/` — Windows —
 *  or a `lib/` — Linux — under one versioned dir). */
function findSharedLibs(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...findSharedLibs(p));
		} else if (isSharedLib(entry.name)) {
			out.push(p);
		}
	}
	return out;
}

/** Downloads `spec.asset`, verifies its pinned SHA-256, and extracts it into a fresh temp dir. */
async function downloadAndExtract(spec) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-ffmpeg-"));
	const url = `${BASE}/${spec.asset}`;
	console.log(`Downloading ${spec.asset}\n  from ${RELEASE_TAG}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	const bytes = Buffer.from(await res.arrayBuffer());

	// Before opening it: is this the exact artifact we pinned?
	const got = crypto.createHash("sha256").update(bytes).digest("hex");
	if (got !== spec.sha256) {
		throw new Error(
			`SHA-256 mismatch for ${spec.asset}\n  expected ${spec.sha256}\n  got      ${got}\n` +
				"Refusing to extract. Either the pin is stale or the artifact changed under it.",
		);
	}
	console.log(`  sha256 ok (${(bytes.length / 1048576).toFixed(0)} MB)`);

	const archive = path.join(tmp, spec.asset);
	fs.writeFileSync(archive, bytes);
	extract(archive, tmp);
	return tmp;
}

/**
 * Vendors the ffmpeg *shared* DLLs the native D3D11 compositor addon links
 * against, into the same `electron/native/bin/<tag>/` dir as the static exe
 * — so both ship as one `extraResources` unit and
 * `compositorViewService.ts`'s PATH-prepend finds them. Windows only.
 */
async function fetchSharedDlls(tag, binDir) {
	const spec = SHARED_PINNED[tag];
	if (!spec) {
		console.log(`\nNo shared-ffmpeg pin for ${tag} (compositor addon is Windows-only) — skipping.`);
		return;
	}

	// probe for any previously vendored DLL by name; re-download is driven by
	// --force same as the static exe, checked once we know what we'd extract.
	const alreadyVendored =
		process.platform === "win32" &&
		fs
			.readdirSync(binDir, { withFileTypes: true })
			.some((e) => e.isFile() && isSharedLib(e.name) && /^(lib)?av/i.test(e.name));
	// The build-time SDK comes out of this same archive, so a tree that has the
	// DLLs but not the SDK must still re-download — otherwise we skip here and
	// the compositor build fails afterwards on the missing FFMPEG_DIR.
	const sdkDest = ffmpegSdkDest();
	const sdkPresent = sdkDest == null || fs.existsSync(sdkDest);
	if (alreadyVendored && sdkPresent && !process.argv.includes("--force")) {
		console.log(
			`\nShared ffmpeg libraries already present in ${binDir}. Use --force to re-vendor.`,
		);
		return;
	}

	console.log(`\nFetching shared ffmpeg libraries (${tag})...`);
	const tmp = await downloadAndExtract(spec);
	try {
		const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
		const exe = findExe(tmp, exeName);
		if (!exe)
			throw new Error(`${exeName} not found inside ${spec.asset} (needed to verify licence)`);
		if (process.platform !== "win32") fs.chmodSync(exe, 0o755);

		// Same source commit as the static build, but configure flags are a
		// separate BtbN job — verify this artifact's licence independently
		// rather than assuming it matches.
		console.log("Verifying licence (shared build)...");
		// BtbN lays the tree out as <versioned>/bin/ffmpeg + <versioned>/lib/*.so.
		const sharedEnv =
			process.platform === "win32"
				? undefined
				: { LD_LIBRARY_PATH: path.join(path.dirname(exe), "..", "lib") };
		const banner = assertLgpl(exe, sharedEnv);
		console.log(banner);

		const libs = findSharedLibs(tmp);
		if (libs.length === 0) throw new Error(`No shared ffmpeg libraries found inside ${spec.asset}`);

		// Windows only. There, the loader finds a DLL next to the .exe, so the runtime
		// copies belong in binDir. On Linux that same directory is owned by the two
		// native build scripts: build-linux-compositor-addon.mjs puts SYMBOL-RENAMED
		// (osff_*) copies there so the addon cannot bind to Chromium's ffmpeg, and
		// build-linux-pipewire-helper.mjs stages unrenamed ones in
		// `binDir/helper-ffmpeg/` for the helper's `$ORIGIN/helper-ffmpeg` RUNPATH
		// (named to stay clear of `binDir/ffmpeg`, which is the static executable
		// this script vendors). Dropping a third, unrenamed set
		// in binDir would overwrite the renamed ones under identical filenames and
		// break the addon at load time. Linux takes the SDK below and nothing else.
		if (process.platform !== "win32") {
			console.log(`Skipping runtime copies into ${binDir} (owned by the native build scripts).`);
		} else {
			fs.mkdirSync(binDir, { recursive: true });
			for (const lib of libs) {
				// Linux ships symlink chains (libavcodec.so -> .so.62 -> .so.62.x). Follow
				// them: copyFileSync would dereference into three identical large files, and
				// a dangling link would break the loader outright.
				const dest = path.join(binDir, path.basename(lib));
				const st = fs.lstatSync(lib);
				if (st.isSymbolicLink()) {
					fs.rmSync(dest, { force: true });
					fs.symlinkSync(fs.readlinkSync(lib), dest);
				} else {
					fs.copyFileSync(lib, dest);
				}
			}
			// The shared CLI too, beside the DLLs it links against. 1 MB, against
			// the 109 MB of the static exe the installer excludes — and unlike that
			// one, this is spawned at runtime: electron/media/audioPeaks.ts decodes
			// waveform peaks with it, ~6x faster than either browser pipeline and
			// off the UI process. Named apart from `ffmpeg.exe` on purpose, so the
			// packager's `!win32-*/ffmpeg.exe` rule keeps dropping the static build
			// while this one ships under the plain `win32-*/*` include.
			fs.copyFileSync(exe, path.join(binDir, "ffmpeg-shared.exe"));
			console.log(`Vendored ${libs.length} shared librar(ies) + ffmpeg-shared.exe -> ${binDir}`);
		}
		if (sdkDest) vendorFfmpegSdk(tmp, sdkDest);
		console.log("LGPL verified: safe to ship with an MIT app.");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

async function main() {
	const tag = `${process.platform}-${process.arch}`;

	if (process.platform === "darwin") {
		console.error(
			"macOS is not provisioned by this script: BtbN publishes no macOS build.\n" +
				"It would have to be built and notarised separately. Note the native-encode plan\n" +
				"is refuted (technical-documentation/engineering/rendering-performance.md), so this is bench-only today.",
		);
		process.exit(1);
	}

	const spec = PINNED[tag];
	if (!spec) {
		console.error(`No pinned asset for ${tag}. Have: ${Object.keys(PINNED).join(", ")}`);
		process.exit(1);
	}

	const binDir = path.join(ROOT, "electron", "native", "bin", tag);
	const dest = path.join(binDir, spec.exe);

	// `--sdk-only` skips the standalone ffmpeg CLI and vendors just the build-time
	// SDK, which is what `build:linux` uses.
	//
	// It was introduced because the CLI landed at `<binDir>/ffmpeg` as a FILE while
	// build-linux-pipewire-helper.mjs wanted `<binDir>/ffmpeg/` as a DIRECTORY, and
	// one clobbered the other (`EEXIST: mkdir .../linux-x64/ffmpeg`). That conflict
	// is gone — the helper's libraries live in `helper-ffmpeg/` now — so this flag
	// no longer avoids a collision. What is left is a size argument: the static CLI
	// is ~110 MB, `linux.extraResources` has no exclusion for it (unlike Windows'
	// "!win32-*/ffmpeg.exe"), and Linux packages have shipped without it since
	// v1.7.0.
	//
	// One caveat if that is ever revisited: the app is NOT entirely done with the
	// CLI, contrary to assertLgpl's note below. electron/media/audioPeaks.ts spawns
	// it to decode waveform peaks ~6x faster than the renderer can, and falls back
	// to the browser pipelines when it is absent — so on Linux that fallback is
	// always the one taken. Degraded, cached after the first decode, not broken.
	if (process.argv.includes("--sdk-only")) {
		console.log(`Skipping the standalone ffmpeg CLI (--sdk-only).`);
		await fetchSharedDlls(tag, binDir);
		return;
	}

	if (fs.existsSync(dest) && !process.argv.includes("--force")) {
		console.log(`Already present: ${dest}`);
		console.log(assertLgpl(dest));
		reportEncoders(dest, process.platform);
		console.log("LGPL verified. Use --force to re-download.");
	} else {
		const tmp = await downloadAndExtract(spec);
		try {
			const found = findExe(tmp, spec.exe);
			if (!found) throw new Error(`${spec.exe} not found inside ${spec.asset}`);

			// Verify the licence BEFORE vendoring: a GPL binary must never reach
			// electron/native/bin, where the packager would happily ship it.
			console.log("Verifying licence...");
			const banner = assertLgpl(found);

			fs.mkdirSync(binDir, { recursive: true });
			fs.copyFileSync(found, dest);
			if (process.platform !== "win32") fs.chmodSync(dest, 0o755);

			console.log(`\n${banner}`);
			reportEncoders(dest, process.platform);
			console.log(`\nVendored -> ${dest}`);
			console.log("LGPL verified: safe to ship with an MIT app.");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}

	// No platform guard: `fetchSharedDlls` returns early when SHARED_PINNED has no
	// entry for this tag, so it self-gates. The guard that used to be here predated
	// the Linux pin and silently skipped the pipewire helper's build-time SDK.
	await fetchSharedDlls(tag, binDir);
}

main().catch((err) => {
	console.error(`\n${err.message}`);
	process.exit(1);
});
