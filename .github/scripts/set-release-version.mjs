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
// MAJOR.MINOR.PATCH with the optional prerelease suffix promote.yml and
// prerelease.yml actually produce ("1.9.0", "2.0.0-rc.3"). Deliberately not full
// semver: this is a gate on what may be written into a published manifest, and
// build metadata or a leading "v" would be a caller bug, not a version to honour.
const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function setReleaseVersion(version, dir) {
	if (!version) throw new Error("a version is required");
	// Truthiness alone let 123, "   " and "not-a-version" through into both
	// manifests. The callers compute this from a validated tag, so it is a
	// defence-in-depth check — but a script whose whole purpose is to stop bad
	// version metadata should not be the thing that writes it.
	if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
		throw new Error(
			`invalid version ${JSON.stringify(version)}; expected MAJOR.MINOR.PATCH with an optional prerelease suffix`,
		);
	}

	// Both manifests are read and validated before a single byte is written. The
	// obvious order — write package.json, then validate the lockfile — left
	// package.json bumped and the lockfile untouched whenever validation failed,
	// which is precisely the half-bump this script exists to end. Its own error
	// path must not reproduce the bug it fixes.
	const load = (name) => {
		const file = join(dir, name);
		return { file, json: JSON.parse(readFileSync(file, "utf8")) };
	};

	const pkg = load("package.json");
	const lock = load("package-lock.json");

	// lockfileVersion 3 repeats the root version inside packages[""]. Optional
	// chaining would quietly skip it if the shape ever changed — the same
	// silent half-bump this script exists to end — so demand it instead.
	if (!lock.json.packages?.[""]) {
		throw new Error(
			'package-lock.json has no packages[""] entry; the lockfile format changed and this script needs updating',
		);
	}

	pkg.json.version = version;
	lock.json.version = version;
	lock.json.packages[""].version = version;

	for (const { file, json } of [pkg, lock]) {
		writeFileSync(file, `${JSON.stringify(json, null, "\t")}\n`);
	}
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
