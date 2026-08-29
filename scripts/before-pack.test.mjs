// OPENSCREEN_SYMBOL_FLOOR=host relaxes the one guard that keeps a Linux package
// startable on the distros the README claims. That is the right trade for a developer
// building for their own machine and a shipping bug anywhere else, so the two refusals
// that keep it local — an unknown value, and CI — are tested rather than trusted.
//
// Neither needs a payload to scan: resolveSymbolCeiling() decides from the environment
// alone, which is why it is the seam this file pokes at. The comparison it feeds is
// exercised for real by every `npm run build:linux`.
//
// The mode is read once at module load, so each case re-requires before-pack.cjs with a
// different environment instead of mutating state on an already-loaded copy.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const BEFORE_PACK = path.join(path.dirname(fileURLToPath(import.meta.url)), "before-pack.cjs");

/**
 * Run `body` against a fresh copy of before-pack.cjs loaded under `env`.
 *
 * The environment has to stay set for the call and not just the require: the mode is
 * captured at module load, but the CI check reads process.env when it runs, and a
 * helper that restored before handing back made that refusal look absent.
 */
function withEnv(env, body) {
	const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		delete require.cache[require.resolve(BEFORE_PACK)];
		return body(require(BEFORE_PACK).__testing);
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("symbol-version ceiling", () => {
	it("uses the pinned floor when OPENSCREEN_SYMBOL_FLOOR is unset", () => {
		withEnv({ OPENSCREEN_SYMBOL_FLOOR: undefined, CI: undefined }, (t) => {
			const { ceiling, pinned } = t.resolveSymbolCeiling();

			expect(pinned).toBe(true);
			expect(ceiling).toBe(t.MAX_SYMBOL_VERSION);
		});
	});

	it("refuses an unknown value rather than guessing enforce or waive", () => {
		withEnv({ OPENSCREEN_SYMBOL_FLOOR: "yes-please", CI: undefined }, (t) => {
			expect(() => t.resolveSymbolCeiling()).toThrow(/not a value this guard knows/);
		});
	});

	it("refuses host mode under CI, so it cannot reach a published artifact", () => {
		withEnv({ OPENSCREEN_SYMBOL_FLOOR: "host", CI: "true" }, (t) => {
			expect(() => t.resolveSymbolCeiling()).toThrow(/refused under CI/);
		});
	});

	// Reads this machine's own libc/libstdc++, so it asserts shape rather than values:
	// every prefix the pinned floor names came back, and each one is a version this run
	// actually parsed out of an ELF.
	//
	// Deliberately NOT asserted: that the host ceiling is at least the pinned one. Host
	// mode substitutes, it does not raise — on a distro OLDER than the floor the ceiling
	// legitimately comes back lower, which makes the check stricter rather than weaker.
	// Requiring otherwise would fail this test on a correct machine.
	it.runIf(process.platform === "linux")("takes the ceiling from this machine in host mode", () => {
		withEnv({ OPENSCREEN_SYMBOL_FLOOR: "host", CI: undefined }, (t) => {
			const { ceiling, pinned } = t.resolveSymbolCeiling();

			expect(pinned).toBe(false);
			expect(ceiling).not.toBe(t.MAX_SYMBOL_VERSION);
			expect(Object.keys(ceiling).sort()).toEqual(Object.keys(t.MAX_SYMBOL_VERSION).sort());
			for (const [prefix, version] of Object.entries(ceiling)) {
				expect(version, `${prefix} came back as ${JSON.stringify(version)}`).toMatch(
					/^\d+(\.\d+)*$/,
				);
			}
		});
	});
});

// ---------------------------------------------------------------------------
// macOS deployment floor (issue #515)
// ---------------------------------------------------------------------------
//
// Mach-O headers are synthesised here rather than compiled with clang, so this runs on
// the Linux and Windows CI legs too. That is the same reason the guard parses the file
// itself instead of shelling out to `vtool`: the check has to be present everywhere the
// hook is, not conditionally absent on the hosts where nobody would notice.
//
// The parser is separately cross-checked against the real thing — on a machine with a
// staged macOS payload, every Mach-O in it agreed with `vtool -show-build` (44/44).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/** Packs X.Y.Z the way LC_BUILD_VERSION does: one byte per component, X in the top half. */
function packVersion(text) {
	const [x = 0, y = 0, z = 0] = text.split(".").map(Number);
	return ((x & 0xffff) << 16) | ((y & 0xff) << 8) | (z & 0xff);
}

/** A 64-bit Mach-O carrying exactly one load command: LC_BUILD_VERSION for macOS. */
function thinMachO(minOs) {
	const header = Buffer.alloc(32);
	header.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
	header.writeUInt32LE(1, 16); // ncmds
	const lc = Buffer.alloc(24);
	lc.writeUInt32LE(0x32, 0); // LC_BUILD_VERSION
	lc.writeUInt32LE(24, 4); // cmdsize
	lc.writeUInt32LE(1, 8); // PLATFORM_MACOS
	lc.writeUInt32LE(packVersion(minOs), 12);
	return Buffer.concat([header, lc]);
}

/** The older spelling, which anything built against an older SDK carries instead. */
function thinMachOVersionMin(minOs) {
	const header = Buffer.alloc(32);
	header.writeUInt32LE(0xfeedfacf, 0);
	header.writeUInt32LE(1, 16);
	const lc = Buffer.alloc(16);
	lc.writeUInt32LE(0x24, 0); // LC_VERSION_MIN_MACOSX
	lc.writeUInt32LE(16, 4);
	lc.writeUInt32LE(packVersion(minOs), 8);
	return Buffer.concat([header, lc]);
}

/** A universal binary whose slices disagree — the highest floor is the one that counts. */
function fatMachO(minOsPerSlice) {
	const headerSize = 8 + minOsPerSlice.length * 20;
	const head = Buffer.alloc(headerSize);
	head.writeUInt32BE(0xcafebabe, 0);
	head.writeUInt32BE(minOsPerSlice.length, 4);
	const slices = minOsPerSlice.map(thinMachO);
	let offset = headerSize;
	slices.forEach((slice, i) => {
		const entry = 8 + i * 20;
		head.writeUInt32BE(offset, entry + 8); // offset
		head.writeUInt32BE(slice.length, entry + 12); // size
		offset += slice.length;
	});
	return Buffer.concat([head, ...slices]);
}

function withPayload(files, body) {
	const dir = mkdtempSync(path.join(tmpdir(), "openscreen-minos-"));
	try {
		for (const [name, bytes] of Object.entries(files)) {
			writeFileSync(path.join(dir, name), bytes);
		}
		return body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const testing = () => require(BEFORE_PACK).__testing;

describe("machoMinOs", () => {
	it("reads LC_BUILD_VERSION", () => {
		withPayload({ helper: thinMachO("12.0") }, (dir) => {
			expect(testing().machoMinOs(path.join(dir, "helper"))).toBe("12.0.0");
		});
	});

	it("reads the older LC_VERSION_MIN_MACOSX spelling", () => {
		withPayload({ helper: thinMachOVersionMin("11.3") }, (dir) => {
			expect(testing().machoMinOs(path.join(dir, "helper"))).toBe("11.3.0");
		});
	});

	it("takes the HIGHEST floor across a universal binary's slices", () => {
		// An arm64 half built correctly does not rescue an x86_64 half that was not:
		// Intel users are stranded just as thoroughly.
		withPayload({ fat: fatMachO(["12.0", "26.0"]) }, (dir) => {
			expect(testing().machoMinOs(path.join(dir, "fat"))).toBe("26.0.0");
		});
	});

	it("returns null for a Mach-O that declares no deployment target", () => {
		const header = Buffer.alloc(32);
		header.writeUInt32LE(0xfeedfacf, 0);
		withPayload({ bare: header }, (dir) => {
			expect(testing().machoMinOs(path.join(dir, "bare"))).toBeNull();
		});
	});
});

describe("checkMacOsVersionFloor", () => {
	/**
	 * Fixtures are derived from the floor rather than written as literals. An earlier
	 * revision hardcoded the then-current floor as "the offending version", and raising
	 * the floor silently turned the offender into a compliant binary — the guard's own
	 * tests stopped testing it. The exact versions were never the point; being on the
	 * wrong side of the floor is.
	 */
	const floorMajor = Number(testing().MAC_MIN_OS_FLOOR.split(".")[0]);
	const above = (bump = 1) => `${floorMajor + bump}.0`;
	const below = () => `${floorMajor - 1}.0`;

	it("passes a payload built at or below the floor", () => {
		withPayload({ a: thinMachO(testing().MAC_MIN_OS_FLOOR), b: thinMachO(below()) }, (dir) => {
			expect(() => testing().checkMacOsVersionFloor(dir)).not.toThrow();
		});
	});

	/**
	 * The regression test for #515: the helper that stranded Monterey was built for 13,
	 * and nothing in the pipeline looked. The message has to carry enough for whoever
	 * hits it to understand the consequence rather than just raise the constant.
	 */
	it("refuses a binary built above the floor, and says which and why", () => {
		withPayload({ "openscreen-macos-cursor-helper": thinMachO(above()) }, (dir) => {
			let message = "";
			try {
				testing().checkMacOsVersionFloor(dir);
			} catch (err) {
				message = err.message;
			}
			expect(message).toContain("openscreen-macos-cursor-helper");
			expect(message).toContain(`macOS ${above()}.0`);
			expect(message).toContain(testing().MAC_MIN_OS_FLOOR);
			expect(message).toContain("#515");
			// The mechanism, so nobody "fixes" it by assuming dyld gates on the number.
			expect(message).toContain("Symbol not found");
		});
	});

	it("reports every offender, not just the first", () => {
		withPayload(
			{
				ok: thinMachO(testing().MAC_MIN_OS_FLOOR),
				bad1: thinMachO(above(1)),
				bad2: thinMachO(above(2)),
			},
			(dir) => {
				expect(() => testing().checkMacOsVersionFloor(dir)).toThrow(/bad1[\s\S]*bad2/);
			},
		);
	});

	it("shouts if it parsed nothing, rather than reporting a clean payload", () => {
		const header = Buffer.alloc(32);
		header.writeUInt32LE(0xfeedfacf, 0);
		withPayload({ bare: header }, (dir) => {
			expect(() => testing().checkMacOsVersionFloor(dir)).toThrow(/bug in machoMinOs/);
		});
	});

	it("says nothing about a directory with no Mach-O in it", () => {
		// Non-macOS packs reach this only if the tree exists; an empty one is not an error
		// here — checkNativePayload already owns "the payload is incomplete".
		withPayload({ "notes.txt": Buffer.from("hello") }, (dir) => {
			expect(() => testing().checkMacOsVersionFloor(dir)).not.toThrow();
		});
	});
});

describe("MAC_MIN_OS_FLOOR", () => {
	it("matches the floor the .app declares to LaunchServices", () => {
		const config = readFileSync(
			path.join(path.dirname(BEFORE_PACK), "..", "electron-builder.json5"),
			"utf8",
		);
		const declared = config.match(/"minimumSystemVersion"\s*:\s*"([\d.]+)"/);
		expect(
			declared,
			'no "minimumSystemVersion" in electron-builder.json5 — without it the .app ' +
				"inherits Electron's own floor, which is what let #515 ship",
		).not.toBeNull();

		const { MAC_MIN_OS_FLOOR } = testing();
		const norm = (v) => v.split(".").concat(["0", "0"]).slice(0, 2).join(".");
		// Equal, not merely <=: a pack-time guard looser than the app's own declaration
		// would wave through exactly the binaries LaunchServices then refuses to run.
		expect(norm(MAC_MIN_OS_FLOOR)).toBe(norm(declared[1]));
	});
});
