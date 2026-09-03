// Stages the Visual C++ runtime DLLs that the prebuilt payload imports, beside it.
//
// Two independent binaries need this, for the same reason and with the same fix.
//
// ggml-base.dll and ggml-cpu.dll are compiled with OpenMP, so they import
// vcomp140.dll — Microsoft's OpenMP runtime, which ships with the Visual C++
// Redistributable and is NOT part of Windows. Every machine that can build this
// repo has it in System32, so the dependency is invisible here and in CI, and on
// a clean machine whisper-stt-server dies in the loader before main(): captions
// and transcription fail with the unactionable timeout described in
// scripts/before-pack.cjs.
//
// onnxruntime.dll — vendored by scripts/fetch-onnxruntime.mjs for the camera
// background segmentation — imports the CRT proper: msvcp140, msvcp140_1,
// vcruntime140, vcruntime140_1. It arrives as an upstream release binary, so
// `-C target-feature=+crt-static` is not available the way it is for our own Rust
// addon; the only remedy left is the one before-pack names, which is this file.
// Without it `checkWinNoRedistDependency` refuses to pack at all, and the Windows
// installer cannot be built — while `WIN_REQUIRED` in the same hook refuses to pack
// *without* onnxruntime.dll, so dropping it is not an escape either.
//
// This is the same class of failure that Store certification rejected 1.9.1 for,
// and it survived that fix because the guard only looked for msvcp/vcruntime/concrt
// prefixes — `vcomp` matches none of them. The guard now covers the whole family
// and, more usefully, only objects when the DLL is not shipped alongside.
//
// Shipping the DLLs rather than rebuilding without them is deliberate. For whisper
// it leaves the computation byte-for-byte identical, where -DGGML_OPENMP=OFF would
// swap OpenMP's scheduler for ggml's own and change transcription throughput by an
// amount nobody has measured. For ONNX Runtime there is nothing to rebuild. ~1 MB
// against that is a cheap trade. If the dependency ever becomes inconvenient,
// measure first, then switch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findVcVarsAll } from "./msvcEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEST_DIR = path.join(ROOT, "electron", "native", "bin", "win32-x64");
// Lower-case, because that is how they are compared against `readdirSync` names.
// vcomp140 lives in Microsoft.VC<nnn>.OpenMP, the other four in Microsoft.VC<nnn>.CRT —
// sibling directories under the same Redist tree, so one walk finds them all.
const DLLS = [
	"vcomp140.dll",
	"msvcp140.dll",
	"msvcp140_1.dll",
	"vcruntime140.dll",
	"vcruntime140_1.dll",
];

if (process.platform !== "win32") {
	console.log("Skipping Visual C++ runtime staging: Windows-only.");
	process.exit(0);
}

/**
 * Every vcomp140.dll under a Visual Studio redistributable directory.
 *
 * The toolset tag moves with the compiler — Microsoft.VC143.OpenMP on the 2022
 * runners, Microsoft.VC145.OpenMP on a 2026 install — so this globs rather than
 * hard-coding it, and takes the newest it finds. The redistributable copy is used
 * in preference to the one in System32 because that is the copy Microsoft licenses
 * for redistribution with an application.
 *
 * Discovery reuses `findVcVarsAll`, the same lookup the two native build scripts
 * already run, so a Visual Studio installed anywhere is found here as well: it
 * consults VCVARSALL, then vswhere, then VSINSTALLDIR, then sweeps for the
 * pre-release channels vswhere does not enumerate. vcvarsall.bat sits at
 * `<root>\VC\Auxiliary\Build\`, hence the three levels up.
 *
 * That root is searched alone when it yields anything, which both prefers the
 * toolchain that actually compiled the helpers and avoids re-walking the same
 * subtree — the installation usually lives under the fixed paths below, and those
 * trees are large enough that scanning one twice is worth avoiding.
 */
function searchRoots() {
	const vcvarsall = findVcVarsAll();
	if (vcvarsall) {
		return [path.resolve(path.dirname(vcvarsall), "..", "..", "..")];
	}
	return [
		"C:\\Program Files\\Microsoft Visual Studio",
		"C:\\Program Files (x86)\\Microsoft Visual Studio",
	];
}

/** Candidate paths per DLL name, from ONE walk — the trees are large enough that
 *  walking them once per name would be the slowest part of the build. */
function findRedistCopies() {
	const wanted = new Set(DLLS);
	const found = new Map(DLLS.map((name) => [name, []]));
	const walk = (dir, depth) => {
		if (depth > 8) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory, not a reason to fail the build
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			const lower = entry.name.toLowerCase();
			if (entry.isDirectory()) {
				walk(full, depth + 1);
			} else if (wanted.has(lower) && /\\Redist\\/i.test(full) && /\\x64\\/i.test(full)) {
				// `onecore\x64` is a trimmed variant for Windows Core headless SKUs; the
				// desktop app wants the ordinary one.
				if (!/\\onecore\\/i.test(full)) found.get(lower).push(full);
			}
		}
	};
	for (const root of searchRoots()) walk(root, 0);
	return found;
}

// Newest by file version, so a machine carrying several toolsets stages the latest.
const versionOf = (file) => {
	const match = file.match(/MSVC\\(\d+(?:\.\d+)*)\\/i);
	return match ? match[1].split(".").map(Number) : [0];
};
const newestFirst = (a, b) => {
	const [x, y] = [versionOf(a), versionOf(b)];
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
	}
	return 0;
};

const copies = findRedistCopies();

// Report every missing name at once. Staging four of five and failing on the fifth
// would send someone back through the same install-and-retry loop per DLL.
const missing = DLLS.filter((name) => copies.get(name).length === 0);
if (missing.length > 0) {
	throw new Error(
		`Could not find a redistributable ${missing.join(", ")} under any Visual Studio installation.\n\n` +
			"They live in VC\\Redist\\MSVC\\<version>\\x64\\ — vcomp140.dll under\n" +
			"Microsoft.VC<nnn>.OpenMP, the rest under Microsoft.VC<nnn>.CRT.\n" +
			"Install the Visual Studio C++ workload, which is required to build the native\n" +
			"helpers anyway. Without these files the shipped whisper/ggml libraries and the\n" +
			"ONNX Runtime cannot load on a machine that has no Visual C++ Redistributable:\n" +
			"transcription fails there with no usable error, and the camera background is\n" +
			"silently inert. before-pack refuses to package either way.",
	);
}

fs.mkdirSync(DEST_DIR, { recursive: true });
for (const name of DLLS) {
	const source = copies.get(name).sort(newestFirst)[0];
	const dest = path.join(DEST_DIR, name);
	fs.copyFileSync(source, dest);
	console.log(`Staged ${name} from ${source}`);
	console.log(`  -> ${path.relative(ROOT, dest)}`);
}
