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
// The macOS floor the app ships against — keep in step with `mac.minimumSystemVersion`
// in electron-builder.json5, which is what the .app tells LaunchServices.
//
// Without it, clang defaults the deployment target
// to the BUILD MACHINE's SDK, so the vendored dylibs inherit whatever macOS built them —
// measured 26.0 on a local build and ~15.x from CI's `macos-latest`, a floor that moves on
// its own every time GitHub rolls that image. That is the same class of leak the configure
// comment below guards against for Homebrew packages, and it is the one it missed.
//
// Note this is NOT a loader version gate: dyld does not refuse a dylib whose minos exceeds
// the running OS (verified). Setting it is what makes the LINKER enforce macOS 12 symbol
// availability, which is the thing that actually breaks at load time. See issue #515.
const MACOS_DEPLOYMENT_TARGET = "13.0";

const VERSION = "8.1.2";
const TARBALL_SHA256 = "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c";
const DEST = path.join(CRATES_DIR, "thirdparty", `ffmpeg-n${VERSION}-macos64-lgpl-shared`);

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
	if (r.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
	}
}

/**
 * Where the pinned tarball can be fetched, in order of preference.
 *
 * ffmpeg.org is canonical and stays first, but it cannot be the only one:
 * GitHub's `macos-15-intel` runner pool cannot reach it. On the v1.8.0-rc.6
 * build the x64 leg died twice, twenty minutes apart, on
 * `curl: (35) Recv failure: Connection reset by peer` about a second after
 * starting — while the arm64 leg on `macos-latest` fetched the same tarball
 * from the same host in the same runs and succeeded both times. An immediate
 * reset that reproduces on one runner pool and never on the other is an
 * egress-level block, not congestion, so retrying alone does not clear it.
 *
 * Debian's `.orig.tar.xz` is the upstream tarball unmodified — verified
 * byte-identical to TARBALL_SHA256 below — and deb.debian.org is CDN-backed.
 * It is a fallback, not a replacement: the checksum is what makes trusting a
 * second origin safe, and it gates every source equally.
 *
 * When the pin moves, a mirror may not carry the new version yet. That is not
 * a failure mode to design around — the list is tried in order and a source
 * that 404s falls through to the next, with every attempt reported if none
 * works. (`--retry-all-errors` does not except a 404, so a missing mirror costs
 * its retries — a few seconds, once per pin bump. Narrowing that would mean
 * giving up the retry on connection resets, which is the whole point.)
 */
const TARBALL_URLS = [
	`https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz`,
	`https://deb.debian.org/debian/pool/main/f/ffmpeg/ffmpeg_${VERSION}.orig.tar.xz`,
];

/**
 * Fetches the pinned tarball to `dest`, trying each source until one both
 * downloads and matches the checksum.
 *
 * `--retry-all-errors` rather than a plain `--retry`: curl only auto-retries
 * what it classes as transient (timeouts, 429, 5xx), which does not include a
 * connection reset or a TLS handshake failure — precisely the errors seen here.
 * `-f` keeps an HTTP error page from being written to the tarball and
 * resurfacing as a checksum mismatch, which reads like a moved pin.
 */
function downloadTarball(dest) {
	const failures = [];
	for (const url of TARBALL_URLS) {
		console.log(`Downloading ffmpeg ${VERSION} from ${new URL(url).host}…`);
		// Two ceilings, because a stuck download stalls in two different ways.
		// --connect-timeout covers the handshake: a throttled origin does not
		// refuse, it hangs — measured against ffmpeg.org after a few rapid
		// fetches, a single connect sat for 75s before failing, and times four
		// attempts that is five minutes of a build spent before the second source
		// is even tried. 20s is far above any healthy handshake.
		// --speed-limit/--speed-time covers everything AFTER the handshake, which
		// --connect-timeout does not reach at all: an origin that accepts the
		// connection and then trickles (or simply stops sending) never errors, so
		// nothing here would retry or fall through — the job would sit until the
		// runner's own six-hour limit. Aborting below 1 KiB/s sustained for 30s
		// cannot fire on a link that is merely slow: the tarball is ~10 MB.
		const r = spawnSync(
			"curl",
			[
				"-fsSL",
				"--connect-timeout",
				"20",
				"--speed-limit",
				"1024",
				"--speed-time",
				"30",
				"--retry",
				"3",
				"--retry-delay",
				"2",
				"--retry-all-errors",
				"-o",
				dest,
				url,
			],
			{ stdio: "inherit" },
		);
		if (r.status !== 0) {
			// `r.error` is the case `status` cannot express: no curl on PATH gives
			// `{ status: null, error: ENOENT }`, and reporting only "exited with
			// null" twice sends the reader hunting a network problem.
			failures.push(`  ${url}\n    ${r.error ? r.error.message : `curl exited with ${r.status}`}`);
			continue;
		}
		const actual = crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
		if (actual !== TARBALL_SHA256) {
			// Not fatal on its own — a mirror may carry a repacked tarball. It is
			// reported in full, so a genuinely moved pin is still legible as
			// "every source disagreed the same way" rather than "network down".
			failures.push(`  ${url}\n    checksum ${actual}`);
			continue;
		}
		console.log("Checksum OK.");
		return;
	}
	throw new Error(
		`Could not obtain ffmpeg ${VERSION} from any source.\n` +
			`Expected sha256 ${TARBALL_SHA256}\n${failures.join("\n")}`,
	);
}

/** The binary's own licence banner — the only claim worth trusting. */
function isLgpl(dir) {
	const bin = path.join(dir, "bin", "ffmpeg");
	if (!fs.existsSync(bin)) return false;
	const banner = execFileSync(bin, ["-hide_banner", "-L"], { encoding: "utf8" });
	return /Lesser General Public/i.test(banner) && !/GNU General Public License/i.test(banner);
}

/**
 * Whether the vendored tree was built for the pinned deployment target. Part of the
 * reuse decision alongside the licence: a tree that predates the pin (or was built by
 * hand without it) is LGPL and would otherwise be reused forever, only for
 * before-pack's floor guard to refuse it at packaging time — a five-minute rebuild
 * deferred to the worst possible moment. The binary, not the dylibs, because it is one
 * vtool call and the whole tree shares a configure.
 */
function isAtDeploymentTarget(dir) {
	const bin = path.join(dir, "bin", "ffmpeg");
	if (!fs.existsSync(bin)) return false;
	const build = execFileSync("vtool", ["-show-build", bin], { encoding: "utf8" });
	const minos = /minos (\d+(?:\.\d+)+)/.exec(build)?.[1];
	if (minos === undefined) return false;
	const compareVersions = (a, b) => {
		const left = a.split(".").map(Number);
		const right = b.split(".").map(Number);
		for (let i = 0; i < Math.max(left.length, right.length); i++) {
			if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
		}
		return 0;
	};
	return compareVersions(minos, MACOS_DEPLOYMENT_TARGET) <= 0;
}

if (process.platform !== "darwin") {
	console.log("Skipping macOS ffmpeg vendoring: macOS-only (Windows uses fetch:ffmpeg).");
	process.exit(0);
}

if (fs.existsSync(path.join(DEST, "include")) && isLgpl(DEST) && isAtDeploymentTarget(DEST)) {
	console.log(
		`ffmpeg already vendored at ${DEST}: LGPL, built for macOS ${MACOS_DEPLOYMENT_TARGET}. Nothing to do.`,
	);
	process.exit(0);
}
if (fs.existsSync(path.join(DEST, "include")) && !isLgpl(DEST)) {
	throw new Error(
		`${DEST} exists but is not an LGPL build (checked with \`ffmpeg -L\`).\n` +
			"Refusing to reuse it — linking a GPL ffmpeg would relicense OpenScreen.\n" +
			"Delete the directory and re-run to rebuild it from source.",
	);
}
if (fs.existsSync(path.join(DEST, "include"))) {
	console.warn(
		`${DEST} was not built for the ${MACOS_DEPLOYMENT_TARGET} deployment target ` +
			"(check: vtool -show-build). Rebuilding — a stale floor here only fails at packaging,\n" +
			"in before-pack's macOS version guard.",
	);
	fs.rmSync(DEST, { recursive: true, force: true });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-ffmpeg-"));
const tarball = path.join(work, `ffmpeg-${VERSION}.tar.xz`);

downloadTarball(tarball);

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
		// ffmpeg's configure AUTO-DETECTS these from whatever the build machine happens
		// to have installed, and a GitHub macOS runner has a large Homebrew prefix. That
		// is how libavformat came to link /opt/homebrew/opt/libx11/lib/libX11.6.dylib and
		// trip build-macos-compositor-addon.mjs's "no absolute build-machine paths" check,
		// which is the check doing its job: such a dylib is unresolvable on a user's Mac.
		// Disabled explicitly rather than left to chance, so the vendored tree depends on
		// the source tarball and the SDK, never on the runner's incidental packages.
		// None is used here: xlib/libxcb are X11 capture, sdl2 is only ffplay, and lzma
		// only reaches decoders we do not ship (we decode mp4/webm).
		"--disable-xlib",
		"--disable-libxcb",
		"--disable-sdl2",
		"--disable-lzma",
		"--enable-videotoolbox",
		"--enable-audiotoolbox",
		"--disable-x86asm",
		`--arch=${process.arch === "arm64" ? "arm64" : "x86_64"}`,
		"--cc=clang",
		// Both, not just cflags: the deployment target has to reach the link step too, or
		// the dylibs are stamped with the build machine's floor however they were compiled.
		`--extra-cflags=-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`,
		`--extra-ldflags=-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`,
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
