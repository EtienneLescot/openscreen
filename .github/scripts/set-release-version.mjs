#!/usr/bin/env node
// Sets the release version in package.json AND package-lock.json.
//
// prerelease.yml and promote.yml used to `sed` package.json alone, so every
// release shipped a lockfile whose root version disagreed with the package it
// locks:
//
//   v1.7.0  package.json=1.7.0  lock=1.6.0
//   v1.8.0  package.json=1.8.0  lock=1.8.0-rc.4
//   v1.9.0  package.json=1.9.0  lock=1.8.0
//
// Nothing caught it for three releases because `npm ci` only fails on
// dependency drift, never on this field — the mismatch is inert until someone
// reads the diff, which is how it was eventually noticed.
//
// Both files are tab-indented JSON that JSON.stringify round-trips byte for
// byte, so rewriting them whole still produces a one-line-per-file diff. The
// test pins that: if npm ever changes how it formats a lockfile, a release
// commit would otherwise silently become a 40k-line reformat.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv } from "node:process";

/**
 * @param {string} version Version to write, e.g. "1.9.0" or "1.9.0-rc.2".
 * @param {string} dir Directory holding package.json and package-lock.json.
 */
export function setReleaseVersion(version, dir) {
	if (!version) throw new Error("a version is required");

	const edit = (name, mutate) => {
		const file = join(dir, name);
		const json = JSON.parse(readFileSync(file, "utf8"));
		mutate(json);
		writeFileSync(file, `${JSON.stringify(json, null, "\t")}\n`);
	};

	edit("package.json", (pkg) => {
		pkg.version = version;
	});

	edit("package-lock.json", (lock) => {
		lock.version = version;
		// lockfileVersion 3 repeats the root version inside packages[""]. Optional
		// chaining would quietly skip it if the shape ever changed — the same
		// silent half-bump this script exists to end — so demand it instead.
		if (!lock.packages?.[""]) {
			throw new Error(
				'package-lock.json has no packages[""] entry; the lockfile format changed and this script needs updating',
			);
		}
		lock.packages[""].version = version;
	});
}

// Only run when invoked directly, so the test can import the function.
if (import.meta.filename === argv[1]) {
	const version = argv[2];
	if (!version) {
		console.error("usage: node .github/scripts/set-release-version.mjs <version>");
		process.exit(1);
	}
	setReleaseVersion(version, process.cwd());
	console.log(`version ${version} set in package.json and package-lock.json`);
}
