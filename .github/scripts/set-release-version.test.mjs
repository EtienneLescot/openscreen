import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setReleaseVersion } from "./set-release-version.mjs";

let dir;

// Tab-indented, like the real files, and shaped like lockfileVersion 3 — the
// point of most of these assertions is formatting, so the fixtures have to be
// byte-faithful rather than merely structurally right.
const pkg = [
	"{",
	'\t"name": "openscreen",',
	'\t"version": "1.8.0",',
	'\t"private": true',
	"}",
	"",
].join("\n");

const lock = [
	"{",
	'\t"name": "openscreen",',
	'\t"version": "1.8.0",',
	'\t"lockfileVersion": 3,',
	'\t"requires": true,',
	'\t"packages": {',
	'\t\t"": {',
	'\t\t\t"name": "openscreen",',
	'\t\t\t"version": "1.8.0",',
	'\t\t\t"dependencies": {',
	'\t\t\t\t"zod": "^4.0.0"',
	"\t\t\t}",
	"\t\t},",
	'\t\t"node_modules/zod": {',
	'\t\t\t"version": "4.0.0"',
	"\t\t}",
	"\t}",
	"}",
	"",
].join("\n");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "set-release-version-"));
	writeFileSync(join(dir, "package.json"), pkg);
	writeFileSync(join(dir, "package-lock.json"), lock);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const read = (name) => readFileSync(join(dir, name), "utf8");

describe("setReleaseVersion", () => {
	it("sets the version in package.json and both lockfile roots", () => {
		setReleaseVersion("1.9.0", dir);

		expect(JSON.parse(read("package.json")).version).toBe("1.9.0");
		const written = JSON.parse(read("package-lock.json"));
		expect(written.version).toBe("1.9.0");
		expect(written.packages[""].version).toBe("1.9.0");
	});

	it("accepts a prerelease version", () => {
		setReleaseVersion("2.0.0-rc.3", dir);

		expect(JSON.parse(read("package.json")).version).toBe("2.0.0-rc.3");
		expect(JSON.parse(read("package-lock.json")).packages[""].version).toBe("2.0.0-rc.3");
	});

	// The reason the script may rewrite these files wholesale: anything else in
	// them must come back out byte for byte. If npm changes its lockfile
	// formatting, this fails here rather than turning a release commit into a
	// 40k-line reformat nobody reviews.
	it("changes only the version lines, leaving formatting untouched", () => {
		setReleaseVersion("1.9.0", dir);

		const diff = (before, after) => {
			const a = before.split("\n");
			const b = after.split("\n");
			expect(b.length).toBe(a.length);
			return a.map((line, i) => [line, b[i]]).filter(([x, y]) => x !== y);
		};

		expect(diff(pkg, read("package.json"))).toEqual([
			['\t"version": "1.8.0",', '\t"version": "1.9.0",'],
		]);
		expect(diff(lock, read("package-lock.json"))).toEqual([
			['\t"version": "1.8.0",', '\t"version": "1.9.0",'],
			['\t\t\t"version": "1.8.0",', '\t\t\t"version": "1.9.0",'],
		]);
	});

	it("leaves dependency versions alone", () => {
		setReleaseVersion("1.9.0", dir);

		const written = JSON.parse(read("package-lock.json"));
		expect(written.packages["node_modules/zod"].version).toBe("4.0.0");
	});

	// A lockfile format change must stop the release, not half-bump it.
	it("throws rather than half-bumping when the lockfile shape is unknown", () => {
		writeFileSync(
			join(dir, "package-lock.json"),
			`${JSON.stringify({ name: "openscreen", version: "1.8.0" }, null, "\t")}\n`,
		);

		expect(() => setReleaseVersion("1.9.0", dir)).toThrow(/packages/);

		// The throw alone was never the property this test claims. package.json
		// used to be written before the lockfile was validated, so this case left
		// exactly the half-bump the name promises it prevents.
		expect(JSON.parse(read("package.json")).version).toBe("1.8.0");
		expect(read("package-lock.json")).not.toContain("1.9.0");
	});

	it("requires a version", () => {
		expect(() => setReleaseVersion("", dir)).toThrow(/version is required/);
	});

	// Truthiness alone let all of these reach both manifests. A number in
	// particular writes `"version": 123`, which is not even a legal package.json.
	it.each([
		[123, "a number"],
		["   ", "whitespace"],
		["not-a-version", "a malformed version"],
		["v1.9.0", "a leading v"],
	])("rejects %o (%s)", (bad) => {
		expect(() => setReleaseVersion(bad, dir)).toThrow(/invalid version/);
		expect(JSON.parse(read("package.json")).version).toBe("1.8.0");
		expect(read("package-lock.json")).not.toContain("1.9.0");
	});

	// The workflows invoke this with a repository-relative path, and the
	// direct-invocation guard compares against `import.meta.filename`, which is
	// absolute. Node resolves argv[1] before exposing it, so the two match — but
	// nothing pinned that, and the whole script is dead code if it ever stops
	// being true. Invoked here the way promote.yml and prerelease.yml do.
	it("runs when invoked directly through a relative path", () => {
		const scripts = join(dir, "scripts");
		mkdirSync(scripts);
		copyFileSync(
			join(import.meta.dirname, "set-release-version.mjs"),
			join(scripts, "set-release-version.mjs"),
		);

		execFileSync("node", ["scripts/set-release-version.mjs", "1.9.0"], { cwd: dir });

		expect(JSON.parse(read("package.json")).version).toBe("1.9.0");
		expect(JSON.parse(read("package-lock.json")).packages[""].version).toBe("1.9.0");
	});
});
