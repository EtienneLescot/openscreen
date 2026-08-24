import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Replaces only an exact path prefix or one of its descendants. */
export function relocatePathPrefix(value, from, to) {
	const relative = path.relative(from, value);
	if (relative === "") return to;
	if (relative.startsWith("..") || path.isAbsolute(relative)) return value;
	return path.join(to, relative);
}

/** Parses `otool -L`/`-D` without treating spaces inside a path as separators. */
export function parseOtoolReferences(output) {
	return output
		.split("\n")
		.slice(1)
		.map((line) => line.trim().replace(/\s+\(compatibility version .*$/, ""))
		.filter(Boolean);
}

function otoolLines(flag, file) {
	return parseOtoolReferences(execFileSync("otool", [flag, file], { encoding: "utf8" }));
}

function rewriteMachO(file, stagedPrefix, destinationPrefix, isLibrary) {
	let changed = false;

	if (isLibrary) {
		const oldId = otoolLines("-D", file)[0];
		const newId = oldId ? relocatePathPrefix(oldId, stagedPrefix, destinationPrefix) : oldId;
		if (oldId && newId !== oldId) {
			execFileSync("install_name_tool", ["-id", newId, file]);
			changed = true;
		}
	}

	for (const dependency of otoolLines("-L", file)) {
		const relocated = relocatePathPrefix(dependency, stagedPrefix, destinationPrefix);
		if (relocated !== dependency) {
			execFileSync("install_name_tool", ["-change", dependency, relocated, file]);
			changed = true;
		}
	}

	if (changed) execFileSync("codesign", ["--force", "--sign", "-", file]);
}

export function makeDylibSymlinksRelative(destinationPrefix) {
	const libDir = path.join(destinationPrefix, "lib");
	for (const name of fs.readdirSync(libDir)) {
		const file = path.join(libDir, name);
		if (!fs.lstatSync(file).isSymbolicLink()) continue;
		const target = fs.readlinkSync(file);
		if (!path.isAbsolute(target)) continue;

		const localTarget = path.basename(target);
		if (!fs.existsSync(path.join(libDir, localTarget))) {
			throw new Error(`${file} points outside the relocated SDK: ${target}`);
		}
		fs.unlinkSync(file);
		fs.symlinkSync(localTarget, file);
	}
}

/**
 * FFmpeg's generated make fragments do not quote an install prefix containing
 * spaces. Build into a temporary no-space prefix, copy the completed SDK to its
 * real repository destination, then retarget its Mach-O IDs and dependencies.
 */
export function relocateMacFfmpegInstall(stagedPrefix, destinationPrefix) {
	fs.mkdirSync(path.dirname(destinationPrefix), { recursive: true });
	fs.cpSync(stagedPrefix, destinationPrefix, { recursive: true, errorOnExist: true });
	makeDylibSymlinksRelative(destinationPrefix);

	const libDir = path.join(destinationPrefix, "lib");
	for (const name of fs.readdirSync(libDir)) {
		const file = path.join(libDir, name);
		if (!name.endsWith(".dylib") || !fs.lstatSync(file).isFile()) continue;
		rewriteMachO(file, stagedPrefix, destinationPrefix, true);
	}

	for (const name of ["ffmpeg", "ffprobe"]) {
		const file = path.join(destinationPrefix, "bin", name);
		if (fs.existsSync(file)) rewriteMachO(file, stagedPrefix, destinationPrefix, false);
	}

	for (const dir of [path.join(destinationPrefix, "lib", "pkgconfig")]) {
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir)) {
			if (!name.endsWith(".pc")) continue;
			const file = path.join(dir, name);
			const source = fs.readFileSync(file, "utf8");
			fs.writeFileSync(file, source.replaceAll(stagedPrefix, destinationPrefix));
		}
	}
}
