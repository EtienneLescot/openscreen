// Vendors an LGPL, shared ffmpeg for macOS into crates/thirdparty/, the tree
// crates/compositor/build.rs probes.
//
// The macOS counterpart of scripts/fetch-ffmpeg.mjs, and it BUILDS rather than downloads
// — not by preference. BtbN, whose pinned "-lgpl-shared" archives that script fetches for
// Windows, publishes no macOS target. The macOS binaries that do circulate (evermeet,
// osxexperts, Homebrew) are all GPL: they ship x264/x265, which `--enable-gpl` pulls in.
// Linking any of them would relicense this MIT app under the GPL, so none of them is a
// candidate however convenient.
//
// The build is therefore from source, from the pinned release tarball, checksummed, with
// neither --enable-gpl nor --enable-nonfree — and the result is verified by asking the
// binary itself (`ffmpeg -L`) rather than by trusting the configure line. That last step
// is the one that matters: it is the same check fetch-ffmpeg.mjs performs on Windows, and
// it is what catches a tree that was replaced by hand with a GPL one.
//
// Roughly five minutes on an M-series. Idempotent: an existing tree that passes the
// licence check is left alone.

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CRATES_DIR = path.join(ROOT, "crates");

/** Pinned release. The directory name is what build.rs looks for. */
const VERSION = "8.1.2";
const TARBALL_SHA256 = "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c";
const DEST = path.join(CRATES_DIR, "thirdparty", `ffmpeg-n${VERSION}-macos64-lgpl-shared`);

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
	if (r.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
	}
}

/** The binary's own licence banner — the only claim worth trusting. */
function isLgpl(dir) {
	const bin = path.join(dir, "bin", "ffmpeg");
	if (!fs.existsSync(bin)) return false;
	const banner = execFileSync(bin, ["-hide_banner", "-L"], { encoding: "utf8" });
	return /Lesser General Public/i.test(banner) && !/GNU General Public License/i.test(banner);
}

if (process.platform !== "darwin") {
	console.log("Skipping macOS ffmpeg vendoring: macOS-only (Windows uses fetch:ffmpeg).");
	process.exit(0);
}

if (fs.existsSync(path.join(DEST, "include")) && isLgpl(DEST)) {
	console.log(`ffmpeg already vendored at ${DEST} and its -L banner says LGPL. Nothing to do.`);
	process.exit(0);
}
if (fs.existsSync(path.join(DEST, "include"))) {
	throw new Error(
		`${DEST} exists but is not an LGPL build (checked with \`ffmpeg -L\`).\n` +
			"Refusing to reuse it — linking a GPL ffmpeg would relicense OpenScreen.\n" +
			"Delete the directory and re-run to rebuild it from source.",
	);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-ffmpeg-"));
const tarball = path.join(work, `ffmpeg-${VERSION}.tar.xz`);

console.log(`Downloading ffmpeg ${VERSION}…`);
run("curl", ["-sSL", "-o", tarball, `https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz`]);

const actual = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
if (actual !== TARBALL_SHA256) {
	throw new Error(
		`Checksum mismatch for the ffmpeg tarball.\n  expected ${TARBALL_SHA256}\n  got      ${actual}`,
	);
}
console.log("Checksum OK.");

run("tar", ["-xJf", tarball, "-C", work]);
const src = path.join(work, `ffmpeg-${VERSION}`);

// No --enable-gpl, no --enable-nonfree. ffmpeg is LGPL by default and stops being so the
// moment either appears; everything else here is about size and the macOS hardware paths.
console.log("Configuring (LGPL, shared)…");
run(
	"./configure",
	[
		`--prefix=${DEST}`,
		"--enable-shared",
		"--disable-static",
		"--disable-doc",
		"--disable-debug",
		"--enable-videotoolbox",
		"--enable-audiotoolbox",
		"--disable-x86asm",
		`--arch=${process.arch === "arm64" ? "arm64" : "x86_64"}`,
		"--cc=clang",
	],
	{ cwd: src },
);

console.log("Building…");
const jobs = execFileSync("sysctl", ["-n", "hw.ncpu"], { encoding: "utf8" }).trim();
run("make", ["-j", jobs], { cwd: src });
run("make", ["install"], { cwd: src });

if (!isLgpl(DEST)) {
	fs.rmSync(DEST, { recursive: true, force: true });
	throw new Error(
		"The freshly built ffmpeg does not report an LGPL licence. The tree has been removed " +
			"rather than left where build.rs would link it.",
	);
}

fs.rmSync(work, { recursive: true, force: true });
console.log(`\nVendored LGPL ffmpeg ${VERSION} at ${DEST}`);
console.log("Verified with `ffmpeg -L`. `npm run build:native:compositor:mac` can now link it.");
