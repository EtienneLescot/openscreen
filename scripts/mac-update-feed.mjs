#!/usr/bin/env node
// Builds `latest-mac.yml`, the feed Squirrel.Mac reads through electron-updater.
//
// Two subcommands because the two arches are built on DIFFERENT runners (macos-15-intel and
// macos-latest — see the matrix in build.yml, which pins them on purpose so ffmpeg's configure,
// cargo and the Swift helper all key off the host arch). electron-builder would write a
// `latest-mac.yml` per job and the second upload would overwrite the first, leaving one
// architecture served the wrong build — electron-builder#5592, closed as not-planned. So each
// job emits a JSON sidecar and `merge` folds both into ONE feed with two `files:` entries.
//
//   describe <zip> <version> <out.json>     — per-arch, on the macOS runner
//   merge <a.json> <b.json> <out.yml>       — once, on the publish runner
//
// JSON in between rather than parsing YAML back: nothing here needs a YAML parser, and the
// repo has no dependency that provides one outside electron-builder's own tree.

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** electron-updater compares this against the digest it computes after downloading. It is
 *  base64, NOT hex — a hex digest parses fine and then fails every update with a checksum
 *  mismatch, which is exactly the kind of silent breakage this file exists to avoid. */
export function sha512Base64(file) {
	return createHash("sha512").update(readFileSync(file)).digest("base64");
}

/** `filterFilesForArch` in MacUpdater.ts selects by the literal substring "arm64" in the file
 *  name. Our DMGs are deliberately named `Apple-Silicon`/`Intel` because that is what About
 *  This Mac shows the user — but naming the ZIP that way would make every Apple Silicon client
 *  silently take the Intel build and run it under Rosetta, with no error anywhere. */
export function archOf(url) {
	if (/apple-silicon|intel/i.test(url)) {
		throw new Error(
			`update ZIP "${url}" must identify its architecture as "arm64"/"x64", not a marketing ` +
				'name: electron-updater matches the literal substring "arm64" and would serve an ' +
				"Apple-Silicon-named build to Intel clients",
		);
	}
	return /arm64/.test(url) ? "arm64" : "x64";
}

/** Pure: entries in, YAML out. The ordering and fallback rules live here so they are testable
 *  without a macOS runner — nothing else in this repo can exercise them. */
export function buildFeedYml(entries, now = new Date()) {
	if (entries.length !== 2) {
		throw new Error(`expected exactly 2 architecture sidecars, got ${entries.length}`);
	}
	const versions = new Set(entries.map((entry) => entry.version));
	if (versions.size !== 1) {
		throw new Error(`architecture sidecars disagree on version: ${[...versions].join(", ")}`);
	}
	const arm64 = entries.filter((entry) => archOf(entry.url) === "arm64");
	if (arm64.length !== 1) {
		throw new Error(`expected exactly one arm64 and one x64 sidecar, got ${arm64.length} arm64`);
	}

	// `path`/`sha512` at the top level are what pre-arch-aware clients read. Point them at the
	// x64 entry: an Apple Silicon Mac runs an Intel build under Rosetta, whereas an Intel Mac
	// handed an arm64 build cannot run it at all. Degrade to slow, never to broken.
	const fallback = entries.find((entry) => archOf(entry.url) === "x64");
	// Sorted so the feed is byte-identical whichever arch job finishes first. electron-updater
	// selects by filtering, never by position, so this costs nothing and makes the published
	// artifact diffable between releases.
	const ordered = [...entries].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
	return `${[
		`version: ${entries[0].version}`,
		"files:",
		...ordered.flatMap((entry) => [
			`  - url: ${entry.url}`,
			`    sha512: ${entry.sha512}`,
			`    size: ${entry.size}`,
		]),
		`path: ${fallback.url}`,
		`sha512: ${fallback.sha512}`,
		`releaseDate: '${now.toISOString()}'`,
	].join("\n")}\n`;
}

function describe(zipPath, version, outPath) {
	const url = path.basename(zipPath);
	const info = { version, url, sha512: sha512Base64(zipPath), size: statSync(zipPath).size };
	archOf(url); // throws on a marketing-named ZIP before it can reach a release
	writeFileSync(outPath, `${JSON.stringify(info, null, 2)}\n`);
	console.log(`${outPath}: ${url} (${info.size} bytes, ${archOf(url)})`);
}

function merge(inputs, outPath) {
	const yml = buildFeedYml(inputs.map((file) => JSON.parse(readFileSync(file, "utf8"))));
	writeFileSync(outPath, yml);
	console.log(yml);
}

// Only when run as a CLI — importing this from a test must not dispatch.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, ...args] = process.argv.slice(2);
	if (command === "describe") describe(args[0], args[1], args[2]);
	else if (command === "merge") merge(args.slice(0, -1), args.at(-1));
	else {
		console.error("usage: mac-update-feed.mjs describe <zip> <version> <out.json>");
		console.error("       mac-update-feed.mjs merge <a.json> <b.json> <out.yml>");
		process.exit(2);
	}
}
