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
// (poc-d3d/compositor-view-napi) *dynamically links* against ffmpeg's shared
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
//
// LICENSING — the other thing this script exists to protect:
//   ffmpeg is LGPL *by default*. It becomes GPL only when built with
//   --enable-gpl (which pulls x264/x265) or --enable-nonfree (fdk-aac), and it
//   is all-or-nothing: one GPL component relicenses the whole binary, which
//   would contaminate this MIT app. We take BtbN's *-lgpl assets AND verify what
//   we got before vendoring. Never swap in a "gpl" asset for the extra encoders:
//   there is nothing in them we need — the hardware encoders are all LGPL.
//
// NOTE: the plan this was vendored for is REFUTED. Feeding native ffmpeg from
// the renderer measured 2.1x SLOWER than the WebCodecs path it was to replace —
// the wall is the compositor, not the encoder. See
// docs/architecture/export-pipeline.md §5. The binary stays because the bench's
// `native` arms use it, and because a future native core would still need a
// licence-gated H.264 encoder; nothing here ships on the export path today.
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

/** Immutable dated tag. `latest` is an alias that moves — do not use it here. */
const RELEASE_TAG = "autobuild-2026-07-15-14-01";
const BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE_TAG}`;

/** Tag, asset and digest move together. Re-pin all three or none. */
const PINNED = {
	"win32-x64": {
		asset: "ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-8.1.zip",
		sha256: "6bd644cb9476a72d905ba22c807eaef1c47a224c8f194c0771da9f3e9a765c35",
		exe: "ffmpeg.exe",
	},
	"win32-arm64": {
		asset: "ffmpeg-n8.1.2-22-g94138f6973-winarm64-lgpl-8.1.zip",
		sha256: "8f89ba5cca2c14ef8e181cdb1bd8403d7b7ee7586151027918a2ac8e42cf7c48",
		exe: "ffmpeg.exe",
	},
	"linux-x64": {
		asset: "ffmpeg-n8.1.2-22-g94138f6973-linux64-lgpl-8.1.tar.xz",
		sha256: "81c8a9fd1f4bb0a888e820d8ddc825cee5116da16efe93054c761ecbc4b54fc3",
		exe: "ffmpeg",
	},
	"linux-arm64": {
		asset: "ffmpeg-n8.1.2-22-g94138f6973-linuxarm64-lgpl-8.1.tar.xz",
		sha256: "0d4777bde13dcfb61de3541d129df8a37f0e24eb0afddb0bab698fa73ec0aed4",
		exe: "ffmpeg",
	},
};

/**
 * The "-shared" sibling of PINNED, from the *same* release tag and source
 * commit (n8.1.2-22-g94138f6973) — same ffmpeg, just built with DLLs instead
 * of static linking. Only the compositor addon needs this, and it's
 * Windows-only (D3D11), so there's no linux/darwin entry here.
 */
const SHARED_PINNED = {
	"win32-x64": {
		asset: "ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1.zip",
		sha256: "8bf72607f421282b64f02c6af8683c480e2d299c6b21349ab0f9b5e27c74e223",
	},
	"win32-arm64": {
		asset: "ffmpeg-n8.1.2-22-g94138f6973-winarm64-lgpl-shared-8.1.zip",
		sha256: "8ee2c32da356883297bac055ccf14e0b6eb1fbb2e5f92f24c569a171207da852",
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
 * Refuses to vendor anything that would relicense the app. Mirrors isLgplBuild()
 * in electron/media/ffmpegCapabilities.ts on purpose: that one guards at
 * runtime, this one at build time. If they ever disagree, one of them drifted.
 */
function assertLgpl(exePath) {
	const problems = [];

	// `ffmpeg -L` prints the licence TEXT. This is the authoritative statement:
	// an LGPL build says "GNU Lesser General Public License", a GPL one says
	// "GNU General Public License". Note there is NO "License:" line in
	// `-version` — only `configuration:`.
	const license = run(exePath, ["-hide_banner", "-L"]).stdout ?? "";
	if (!/Lesser General Public License/i.test(license)) {
		const what = /General Public License/i.test(license) ? "GPL" : "unrecognised licence";
		problems.push(`-L reports ${what}, not LGPL`);
	}

	// `-buildconf` lists the configure flags one per line; `-version` has them on
	// one `configuration:` line. Read both so a build that answers only one still
	// gets checked.
	const conf =
		(run(exePath, ["-hide_banner", "-buildconf"]).stdout ?? "") +
		(run(exePath, ["-hide_banner", "-version"]).stdout ?? "");
	for (const flag of ["--enable-gpl", "--enable-nonfree"]) {
		if (new RegExp(`(^|\\s)${flag}(\\s|$)`, "m").test(conf))
			problems.push(`configured with ${flag}`);
	}
	for (const lib of [...GPL_LIBS, ...NONFREE_LIBS]) {
		if (new RegExp(`(^|\\s)--enable-${lib}(\\s|$)`, "m").test(conf)) problems.push(`links ${lib}`);
	}

	// Belt and braces: whatever the flags claim, the binary must not actually
	// expose a GPL encoder.
	const encoders = run(exePath, ["-hide_banner", "-encoders"]).stdout ?? "";
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
	const ver = run(exePath, ["-hide_banner", "-version"]).stdout ?? "";
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

/** All `*.dll` files anywhere under `dir` (BtbN's shared builds nest a `bin/` under a versioned dir). */
function findDlls(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...findDlls(p));
		} else if (entry.name.toLowerCase().endsWith(".dll")) {
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
	const alreadyVendored = fs
		.readdirSync(binDir, { withFileTypes: true })
		.some((e) => e.isFile() && e.name.toLowerCase().endsWith(".dll") && e.name.toLowerCase().startsWith("av"));
	if (alreadyVendored && !process.argv.includes("--force")) {
		console.log(`\nShared ffmpeg DLLs already present in ${binDir}. Use --force to re-vendor.`);
		return;
	}

	console.log(`\nFetching shared ffmpeg DLLs for the compositor addon (${tag})...`);
	const tmp = await downloadAndExtract(spec);
	try {
		const exe = findExe(tmp, "ffmpeg.exe");
		if (!exe) throw new Error(`ffmpeg.exe not found inside ${spec.asset} (needed to verify licence)`);

		// Same source commit as the static build, but configure flags are a
		// separate BtbN job — verify this artifact's licence independently
		// rather than assuming it matches.
		console.log("Verifying licence (shared build)...");
		const banner = assertLgpl(exe);
		console.log(banner);

		const dlls = findDlls(tmp);
		if (dlls.length === 0) throw new Error(`No .dll files found inside ${spec.asset}`);

		fs.mkdirSync(binDir, { recursive: true });
		for (const dll of dlls) {
			fs.copyFileSync(dll, path.join(binDir, path.basename(dll)));
		}
		console.log(`Vendored ${dlls.length} DLL(s) -> ${binDir}`);
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
				"is refuted (docs/architecture/export-pipeline.md §5), so this is bench-only today.",
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

	if (process.platform === "win32") {
		await fetchSharedDlls(tag, binDir);
	}
}

main().catch((err) => {
	console.error(`\n${err.message}`);
	process.exit(1);
});
