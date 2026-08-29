// Provisions the ONNX Runtime shared library into
// electron/native/bin/<platform>-<arch>/, next to the compositor addon and the
// ffmpeg libraries. That directory is gitignored and shipped by electron-builder's
// extraResources, so this runs at build time rather than committing a 15-38 MB binary.
//
// WHY IT SHIPS: the native compositor segments the webcam subject on the CPU
// execution provider (crates/compositor/src/segmentation.rs), and `ort` is linked
// with `load-dynamic` — nothing is needed to BUILD, but at runtime
// `ensureOnnxRuntimeOnPath` (electron/native-bridge/services/compositorViewService.ts)
// walks this exact directory looking for the library and sets ORT_DYLIB_PATH to it.
// Without it `Segmenter::load` fails, the compositor logs one line and draws the
// webcam unsegmented — so the AI background cutout/blur/custom modes are simply off.
// Everything degrades; nothing breaks. That is why this script never fails a build.
//
// VERSION IS NOT FREE TO MOVE. crates/Cargo.toml pins `ort` with feature `api-NN`,
// which is the MINIMUM ONNX Runtime minor version the crate will accept — a lower
// one makes `GetApi` return null and `ort` panics rather than erroring. The pin here
// must satisfy that, and scripts/fetch-onnxruntime.test.mjs cross-checks the two so
// a bump on either side cannot land alone.
//
// SUPPLY CHAIN. This binary is signed and shipped to every user, so nothing floats:
//   - Pinned to an immutable release tag, never `latest`.
//   - SHA-256 verified before the archive is opened. The digests below are the ones
//     GitHub publishes per asset (`digest` in the releases API), independently
//     re-verified by downloading and hashing.
//   - Only the plain CPU assets. The `gpu_cuda*` variants are 200-320 MB and pull
//     NVIDIA runtime dependencies we neither need nor may redistribute; the measured
//     decision to use the CPU EP is in
//     technical-documentation/engineering/webcam-segmentation.md.
//
// LICENSING: ONNX Runtime is MIT, which is compatible with this MIT app — but the
// archive is checked rather than trusted, the same way fetch-ffmpeg.mjs verifies
// ffmpeg's LGPL-ness instead of believing the asset name. Attribution ships in
// THIRD-PARTY-NOTICES.md.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/**
 * The pinned release. Asset names are DERIVED from it rather than written out per
 * entry, which is deliberate: fetch-ffmpeg.mjs keeps full asset strings and grew a
 * test because a re-pin moved some and not others. Templating removes that failure
 * mode by construction. The digests still have to move by hand — but a stale one
 * fails loudly on the SHA-256 check before anything is extracted, which is the safe
 * direction to fail in.
 */
const VERSION = "1.27.1";
const BASE = `https://github.com/microsoft/onnxruntime/releases/download/v${VERSION}`;

/**
 * Per-target: the upstream artifact slug, its digest, and the library to lift out.
 *
 * `out` is not cosmetic — it is the exact name `ortLibName()` looks for in
 * compositorViewService.ts. `member` is the file inside the archive, which on macOS
 * and Linux is the VERSIONED real file rather than the unversioned symlink beside
 * it: tar restores that symlink as a symlink, and a dangling one in the packaged app
 * would resolve to nothing.
 *
 * darwin-x64 is absent and cannot be added: Microsoft publishes no `osx-x86_64`
 * (or universal) asset for any release from 1.27 on — arm64 is the only macOS
 * target. Building it from source is the only way to change that, and it is not
 * worth an ffmpeg-macos-sized build script for a shrinking platform when the
 * fallback is "the effect is off". See the darwin-x64 branch in main().
 */
const PINNED = {
	"win32-x64": {
		slug: "win-x64",
		ext: "zip",
		sha256: "2e00414a63fdef0914cd5a5ede6c707844878e0c08e1b6693842f0451b2df2a1",
		member: "onnxruntime.dll",
		out: "onnxruntime.dll",
	},
	"win32-arm64": {
		slug: "win-arm64",
		ext: "zip",
		sha256: "6e22c2061ba6400b42a59663d700c8694e4e8fe654cf452c4700c24237407ae1",
		member: "onnxruntime.dll",
		out: "onnxruntime.dll",
	},
	"darwin-arm64": {
		slug: "osx-arm64",
		ext: "tgz",
		sha256: "e42b77a7281cc6e55141bf44fcfbac2c782b823a491bbb6ac33c781dd991f8a6",
		member: `libonnxruntime.${VERSION}.dylib`,
		out: "libonnxruntime.dylib",
	},
	// Linux is pinned but not yet wired into `build:linux`: the Linux compositor
	// back-end carries the segmentation SHADER only — nothing captures the webcam
	// frame or uploads a mask there, so `fx.z` never leaves 0 and the library would
	// be 23 MB of installer for a code path that cannot run. The entry is here so
	// that landing the Linux capture half is a one-line change to package.json.
	// See technical-documentation/engineering/webcam-segmentation-backend-port.md.
	"linux-x64": {
		slug: "linux-x64",
		ext: "tgz",
		sha256: "25b1ef1fea1acd210d63f8f24dc870ad6e077795ce1f54876252c6d3803c15af",
		member: `libonnxruntime.so.${VERSION}`,
		out: "libonnxruntime.so",
	},
	"linux-arm64": {
		slug: "linux-aarch64",
		ext: "tgz",
		sha256: "33c67e33d1e25b816878366ea276589a024f71f000e7ff955c4b33224d639edd",
		member: `libonnxruntime.so.${VERSION}`,
		out: "libonnxruntime.so",
	},
};

const assetName = (spec) => `onnxruntime-${spec.slug}-${VERSION}.${spec.ext}`;

/** Magic bytes the vendored library must start with, per target platform. */
const MAGIC = {
	win32: { bytes: [0x4d, 0x5a], name: "PE (MZ)" }, //             .dll
	darwin: { bytes: [0xcf, 0xfa, 0xed, 0xfe], name: "Mach-O 64" }, // .dylib
	linux: { bytes: [0x7f, 0x45, 0x4c, 0x46], name: "ELF" }, //        .so
};

function run(cmd, args, opts = {}) {
	return spawnSync(cmd, args, { stdio: "inherit", ...opts });
}

function tarBin() {
	if (process.platform !== "win32") return "tar";
	const sys32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
	return fs.existsSync(sys32) ? sys32 : "tar";
}

function extract(archive, destDir) {
	fs.mkdirSync(destDir, { recursive: true });
	// Run from destDir with a bare filename: given an absolute Windows path, tar
	// reads "C:\..." as host:path and tries to resolve a host called C.
	const r = run(tarBin(), [archive.endsWith(".zip") ? "-xf" : "-xzf", path.basename(archive)], {
		cwd: destDir,
	});
	if (r.status !== 0) throw new Error(`tar failed to extract ${path.basename(archive)}`);
}

/** Depth-first search for a file by exact basename. */
function find(dir, name) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const hit = find(p, name);
			if (hit) return hit;
		} else if (entry.name === name) {
			return p;
		}
	}
	return null;
}

/**
 * Refuses anything that is not the MIT ONNX Runtime we pinned.
 *
 * Three independent checks, because the digest alone only proves we got the archive
 * we asked for — it says nothing about having lifted the RIGHT FILE out of it, which
 * is where a re-pin actually goes wrong (a renamed member silently vendors a 20 KB
 * provider stub, and the failure surfaces as "the effect does nothing" months later).
 *
 *   1. the archive's LICENSE really is MIT — asset names are not evidence;
 *   2. the library is a binary of the expected format for the target platform;
 *   3. it carries the pinned version string, which is what `GetVersionString()`
 *      returns and what `ort` compares against its `api-NN` floor.
 */
function verify(libPath, licensePath, targetPlatform) {
	const license = fs.readFileSync(licensePath, "utf8");
	if (!/^MIT License/m.test(license)) {
		throw new Error(
			`${path.basename(licensePath)} does not begin with "MIT License".\n` +
				"Refusing to vendor: ONNX Runtime is MIT and this app is MIT — a relicensed\n" +
				"upstream is a decision for a human, not a build script.",
		);
	}

	const buf = fs.readFileSync(libPath);
	const magic = MAGIC[targetPlatform];
	if (!magic.bytes.every((b, i) => buf[i] === b)) {
		const got = [...buf.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
		throw new Error(
			`${path.basename(libPath)} is not a ${magic.name} binary (starts with ${got}).\n` +
				"The archive layout probably changed under the pin — check `member`.",
		);
	}

	// The version lives in the binary as a plain NUL-terminated string.
	if (!buf.includes(Buffer.from(`\0${VERSION}\0`, "latin1"))) {
		throw new Error(
			`${path.basename(libPath)} does not carry the version string ${VERSION}.\n` +
				"Either the pin and the digest disagree, or the wrong member was extracted.",
		);
	}

	return `MIT ONNX Runtime ${VERSION}, ${magic.name}, ${(buf.length / 1048576).toFixed(1)} MB`;
}

async function download(spec) {
	const asset = assetName(spec);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-ort-"));
	console.log(`Downloading ${asset}\n  from v${VERSION}`);
	const res = await fetch(`${BASE}/${asset}`);
	if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	const bytes = Buffer.from(await res.arrayBuffer());

	// Before opening it: is this the exact artifact we pinned?
	const got = crypto.createHash("sha256").update(bytes).digest("hex");
	if (got !== spec.sha256) {
		fs.rmSync(tmp, { recursive: true, force: true });
		throw new Error(
			`SHA-256 mismatch for ${asset}\n  expected ${spec.sha256}\n  got      ${got}\n` +
				"Refusing to extract. Either the pin is stale or the artifact changed under it.",
		);
	}
	console.log(`  sha256 ok (${(bytes.length / 1048576).toFixed(0)} MB)`);

	const archive = path.join(tmp, asset);
	fs.writeFileSync(archive, bytes);
	extract(archive, tmp);
	return tmp;
}

async function main() {
	// `--target` exists for CI, which provisions for the runner it is on; without it
	// the host is the target, which is what every local build wants.
	const targetArg = process.argv.find((a) => a.startsWith("--target="));
	const tag = targetArg
		? targetArg.slice("--target=".length)
		: `${process.platform}-${process.arch}`;
	const [targetPlatform] = tag.split("-");

	// Not an error, and deliberately exit 0: `build:mac` runs on an Intel runner for
	// the x64 DMG, and there is no upstream library to give it. Failing here would
	// break a release build over a feature that is designed to be absent gracefully.
	if (tag === "darwin-x64") {
		console.log(
			"ONNX Runtime is not provisioned for darwin-x64: Microsoft publishes no\n" +
				"osx-x86_64 (or universal) asset for 1.27 or later — arm64 is the only macOS\n" +
				"target. The webcam background effects are therefore OFF on Intel Macs; the\n" +
				"compositor logs one line and draws the camera unsegmented. Nothing else changes.",
		);
		return;
	}

	const spec = PINNED[tag];
	if (!spec) {
		console.log(
			`No pinned ONNX Runtime for ${tag} — skipping. Have: ${Object.keys(PINNED).join(", ")}`,
		);
		return;
	}
	if (!MAGIC[targetPlatform]) {
		throw new Error(`Unknown target platform in --target=${tag}`);
	}

	const binDir = path.join(ROOT, "electron", "native", "bin", tag);
	const dest = path.join(binDir, spec.out);

	if (fs.existsSync(dest) && !process.argv.includes("--force")) {
		// Re-verify rather than trusting the filename: this directory is gitignored
		// scratch space that a half-finished run or a hand copy can leave anything in.
		const buf = fs.readFileSync(dest);
		const magic = MAGIC[targetPlatform];
		const looksRight =
			magic.bytes.every((b, i) => buf[i] === b) &&
			buf.includes(Buffer.from(`\0${VERSION}\0`, "latin1"));
		if (looksRight) {
			console.log(`Already present: ${dest}`);
			console.log(`  ONNX Runtime ${VERSION}, ${(buf.length / 1048576).toFixed(1)} MB`);
			console.log("Use --force to re-download.");
			return;
		}
		console.log(`Present but not ONNX Runtime ${VERSION} — re-fetching: ${dest}`);
	}

	const tmp = await download(spec);
	try {
		const lib = find(tmp, spec.member);
		if (!lib) throw new Error(`${spec.member} not found inside ${assetName(spec)}`);
		const license = find(tmp, "LICENSE");
		if (!license) throw new Error(`LICENSE not found inside ${assetName(spec)}`);

		// Verify BEFORE vendoring: nothing unchecked reaches electron/native/bin,
		// where the packager would happily ship it.
		console.log("Verifying...");
		const banner = verify(lib, license, targetPlatform);

		fs.mkdirSync(binDir, { recursive: true });
		fs.copyFileSync(lib, dest);
		if (targetPlatform !== "win32") fs.chmodSync(dest, 0o755);

		console.log(`  ${banner}`);
		console.log(`\nVendored -> ${dest}`);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(`\n${err.message}`);
	process.exit(1);
});
