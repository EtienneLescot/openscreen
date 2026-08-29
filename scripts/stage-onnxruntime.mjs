// Stages the ONNX Runtime shared library beside the compositor addon that loads it.
//
// `crates/compositor` links `ort` with `load-dynamic`: nothing is needed to BUILD, and the
// library is resolved at runtime by `ensureOnnxRuntimeOnPath` (compositorViewService.ts), which
// looks for it in `electron/native/bin/<os>-<arch>/` — the same arch-tagged directory the addon
// and the whisper payload already ship from, and which electron-builder packs via extraResources.
//
// Without it the webcam background effect stays off: `Segmenter::load` refuses before touching
// ort, because ort PANICS on a missing library rather than returning an error.
//
// Why the full release archive and not `onnxruntime-node`: that npm package is 296 MB unpacked
// because it carries every platform and every execution provider. We use one provider (CPU) on
// one platform per build, and the shared library alone is ~15 MB. Tripling the installer for
// providers nothing loads is not a trade worth making.
//
// Pinned by tag AND sha256, the same discipline `fetch-ffmpeg.mjs` applies to its own vendored
// binaries: a tag alone can be moved, and this file ends up inside every installer we ship.
// `--pin` regenerates the table from the release metadata after a version bump.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/** Upstream release. Bumping this means re-pinning every checksum below — run with `--pin`. */
const VERSION = "1.29.0";
const BASE = `https://github.com/microsoft/onnxruntime/releases/download/v${VERSION}`;
const API = "https://api.github.com/repos/microsoft/onnxruntime/releases";

/**
 * One entry per platform we ship.
 *
 * `lib` is the file we actually want out of the archive; the rest of the release is headers and
 * static libs we have no use for. `sha256` is of the ARCHIVE, so the check happens before
 * anything is unpacked.
 *
 * There is no `osx-x64` asset in the 1.29.0 release, so Intel Macs get no library and the effect
 * stays off there — the same position `darwin-x64` is already in for ggml's Metal backend. That
 * is a gap to name, not a bug to hide: `supportsWebcamSegmentation` should learn about it if
 * Intel Macs matter.
 */
const TARGETS = {
	"win32-x64": {
		asset: `onnxruntime-win-x64-${VERSION}.zip`,
		lib: "onnxruntime.dll",
		sha256: "c9b4b7086b529ad814f428c1bad028e20a25d7dc0699836775faace4ab5b78b2",
	},
	"darwin-arm64": {
		asset: `onnxruntime-osx-arm64-${VERSION}.tgz`,
		lib: "libonnxruntime.dylib",
		sha256: "d0706fc34f315d8c88639d0a8c81f2e09e815f282cabed3493c06a054352cf92",
	},
	"linux-x64": {
		asset: `onnxruntime-linux-x64-${VERSION}.tgz`,
		lib: "libonnxruntime.so",
		sha256: "c3fddc4f139a045b0c4902c57410f0694f1c2fdf9b6939fbe38b1aeae7cd14ba",
	},
};

function tag() {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `${process.platform}-${arch}`;
}

async function download(url) {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) {
		throw new Error(`${url} → HTTP ${res.status}`);
	}
	return Buffer.from(await res.arrayBuffer());
}

function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Windows 10+ ships bsdtar at System32\tar.exe, which reads zip. Resolve it explicitly: a dev
 * shell (Git Bash, MSYS) usually puts GNU tar first on PATH, and GNU tar cannot read zip at all.
 * Same resolution `fetch-ffmpeg.mjs` performs, and for the same archive format.
 */
function tarBin() {
	if (process.platform !== "win32") return "tar";
	const sys32 = path.join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe");
	return fs.existsSync(sys32) ? sys32 : "tar";
}

/**
 * Pulls `spec.lib` out of the archive and drops it in `destDir`.
 *
 * The release carries headers and static libs we have no use for, so this unpacks to a temp
 * directory and copies out the one file. On Linux and macOS `spec.lib` is a symlink to the
 * versioned real library; `copyFileSync` follows it, which is what we want — the staged file has
 * to stand alone inside the installer.
 */
function extractLib(bytes, spec, destDir) {
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-ort-"));
	try {
		fs.writeFileSync(path.join(workDir, spec.asset), bytes);
		// Run from workDir with a bare filename: given an absolute Windows path, tar reads
		// "C:\..." as host:path and tries to resolve a host called C.
		execFileSync(tarBin(), ["-xf", spec.asset], { cwd: workDir, stdio: "inherit" });
		const found = findFile(workDir, spec.lib);
		if (!found) {
			throw new Error(`${spec.lib} not found inside ${spec.asset}`);
		}
		fs.mkdirSync(destDir, { recursive: true });
		const dest = path.join(destDir, spec.lib);
		fs.copyFileSync(found, dest);
		return dest;
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}

function findFile(dir, name) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const hit = findFile(full, name);
			if (hit) return hit;
		} else if (entry.name === name) {
			return full;
		}
	}
	return null;
}

async function main() {
	const pinMode = process.argv.includes("--pin");

	if (pinMode) {
		// Prints the table to paste back into TARGETS after a version bump.
		//
		// Reads the digests GitHub itself recorded when each asset was uploaded, rather than
		// pulling 124 MB of archives to hash locally. Same value either way, and the swap this
		// pin defends against is a *later* one: freezing what the publisher uploaded at pin
		// time is exactly what makes a substituted asset fail the check in main() below.
		const res = await fetch(`${API}/tags/v${VERSION}`, {
			headers: { accept: "application/vnd.github+json" },
		});
		if (!res.ok) {
			throw new Error(`release v${VERSION} → HTTP ${res.status}`);
		}
		const { assets } = await res.json();
		console.log(`Pinning ONNX Runtime v${VERSION}
`);
		for (const [name, spec] of Object.entries(TARGETS)) {
			const asset = assets.find((a) => a.name === spec.asset);
			if (!asset) {
				throw new Error(`no asset named ${spec.asset} in release v${VERSION}`);
			}
			if (!asset.digest?.startsWith("sha256:")) {
				throw new Error(`${spec.asset} has no sha256 digest; hash it by hand`);
			}
			const mb = (asset.size / 1048576).toFixed(0);
			console.log(`  ${name}: sha256: "${asset.digest.slice(7)}",   // ${spec.asset}, ${mb} MB`);
		}
		return;
	}

	const target = tag();
	const spec = TARGETS[target];
	if (!spec) {
		console.log(`No ONNX Runtime asset for ${target}; the webcam background effect stays off.`);
		return;
	}
	if (!spec.sha256) {
		throw new Error(
			`No checksum pinned for ${target}. Run \`node scripts/stage-onnxruntime.mjs --pin\` and ` +
				`paste the values into TARGETS. Refusing to stage an unverified binary that ships ` +
				`inside the installer.`,
		);
	}

	const destDir = path.join(ROOT, "electron", "native", "bin", target);
	const dest = path.join(destDir, spec.lib);
	if (fs.existsSync(dest)) {
		console.log(`ONNX Runtime already staged: ${path.relative(ROOT, dest)}`);
		return;
	}

	console.log(`Fetching ${spec.asset}…`);
	const bytes = await download(`${BASE}/${spec.asset}`);
	const got = sha256(bytes);
	if (got !== spec.sha256) {
		throw new Error(
			`SHA-256 mismatch for ${spec.asset}\n  expected ${spec.sha256}\n  got      ${got}`,
		);
	}
	console.log(`  sha256 ok (${(bytes.length / 1048576).toFixed(0)} MB)`);

	const staged = extractLib(bytes, spec, destDir);
	const size = (fs.statSync(staged).size / 1048576).toFixed(1);
	console.log(`Staged ${path.relative(ROOT, staged)} (${size} MB)`);
}

main().catch((err) => {
	console.error(`stage-onnxruntime: ${err.message}`);
	process.exit(1);
});
