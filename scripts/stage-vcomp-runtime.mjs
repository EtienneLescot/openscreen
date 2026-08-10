// Stages vcomp140.dll beside the whisper/ggml payload it is loaded by.
//
// ggml-base.dll and ggml-cpu.dll are compiled with OpenMP, so they import
// vcomp140.dll — Microsoft's OpenMP runtime, which ships with the Visual C++
// Redistributable and is NOT part of Windows. Every machine that can build this
// repo has it in System32, so the dependency is invisible here and in CI, and on
// a clean machine whisper-stt-server dies in the loader before main(): captions
// and transcription fail with the unactionable timeout described in
// scripts/before-pack.cjs.
//
// This is the same class of failure that Store certification rejected 1.9.1 for,
// and it survived that fix because the guard only looked for msvcp/vcruntime/concrt
// prefixes — `vcomp` matches none of them. The guard now covers the whole family
// and, more usefully, only objects when the DLL is not shipped alongside.
//
// Shipping the DLL rather than rebuilding whisper without OpenMP is deliberate:
// it leaves the computation byte-for-byte identical, where -DGGML_OPENMP=OFF would
// swap OpenMP's scheduler for ggml's own and change transcription throughput by an
// amount nobody has measured. 200 KB against that unknown is a cheap trade. If the
// dependency ever becomes inconvenient, measure first, then switch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findVcVarsAll } from "./msvcEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEST_DIR = path.join(ROOT, "electron", "native", "bin", "win32-x64");
const DLL = "vcomp140.dll";

if (process.platform !== "win32") {
	console.log("Skipping OpenMP runtime staging: Windows-only.");
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

function findRedistCopies() {
	const found = [];
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
			if (entry.isDirectory()) {
				walk(full, depth + 1);
			} else if (
				entry.name.toLowerCase() === DLL &&
				/\\Redist\\/i.test(full) &&
				/\\x64\\/i.test(full)
			) {
				// `onecore\x64` is a trimmed variant for Windows Core headless SKUs; the
				// desktop app wants the ordinary one.
				if (!/\\onecore\\/i.test(full)) found.push(full);
			}
		}
	};
	for (const root of searchRoots()) walk(root, 0);
	return found;
}

const candidates = findRedistCopies();
if (candidates.length === 0) {
	throw new Error(
		`Could not find a redistributable ${DLL} under any Visual Studio installation.\n\n` +
			"It lives in VC\\Redist\\MSVC\\<version>\\x64\\Microsoft.VC<nnn>.OpenMP\\.\n" +
			"Install the Visual Studio C++ workload, which is required to build the native\n" +
			"helpers anyway. Without this file the shipped whisper/ggml libraries cannot load\n" +
			"on a machine that has no Visual C++ Redistributable, and transcription fails there\n" +
			"with no usable error.",
	);
}

// Newest by file version, so a machine carrying several toolsets stages the latest.
const versionOf = (file) => {
	const match = file.match(/MSVC\\(\d+(?:\.\d+)*)\\/i);
	return match ? match[1].split(".").map(Number) : [0];
};
candidates.sort((a, b) => {
	const [x, y] = [versionOf(a), versionOf(b)];
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
	}
	return 0;
});

const source = candidates[0];
fs.mkdirSync(DEST_DIR, { recursive: true });
const dest = path.join(DEST_DIR, DLL);
fs.copyFileSync(source, dest);

console.log(`Staged ${DLL} from ${source}`);
console.log(`  -> ${path.relative(ROOT, dest)}`);
