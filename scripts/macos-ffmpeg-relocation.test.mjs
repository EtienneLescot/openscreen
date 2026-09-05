import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	makeDylibSymlinksRelative,
	parseOtoolReferences,
	relocatePathPrefix,
} from "./macos-ffmpeg-relocation.mjs";

describe("macOS ffmpeg relocation", () => {
	it("moves the prefix and its descendants into a path containing spaces", () => {
		const staged = "/private/tmp/openscreen-ffmpeg/install";
		const destination = "/Users/test/Vibe coding/openscreen/crates/thirdparty/ffmpeg";

		expect(relocatePathPrefix(staged, staged, destination)).toBe(destination);
		expect(
			relocatePathPrefix(path.join(staged, "lib/libavutil.60.dylib"), staged, destination),
		).toBe(path.join(destination, "lib/libavutil.60.dylib"));
	});

	it("does not rewrite sibling paths with a matching string prefix", () => {
		const staged = "/private/tmp/openscreen-ffmpeg/install";
		const destination = "/Users/test/Vibe coding/openscreen/ffmpeg";
		const sibling = "/private/tmp/openscreen-ffmpeg/install-old/libavutil.dylib";

		expect(relocatePathPrefix(sibling, staged, destination)).toBe(sibling);
		expect(relocatePathPrefix("/usr/lib/libSystem.B.dylib", staged, destination)).toBe(
			"/usr/lib/libSystem.B.dylib",
		);
	});

	it("repairs absolute dylib symlinks after copying the staged SDK", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-relocation-test-"));
		const libDir = path.join(root, "lib");
		fs.mkdirSync(libDir);
		fs.writeFileSync(path.join(libDir, "libavutil.60.1.dylib"), "fixture");
		fs.symlinkSync(
			"/private/tmp/staged/lib/libavutil.60.1.dylib",
			path.join(libDir, "libavutil.dylib"),
		);

		try {
			makeDylibSymlinksRelative(root);
			expect(fs.readlinkSync(path.join(libDir, "libavutil.dylib"))).toBe("libavutil.60.1.dylib");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves spaces while parsing otool dependency output", () => {
		const output = [
			"/tmp/compositor_view.node:",
			"\t/Users/test/Vibe coding/ffmpeg/lib/libavformat.62.dylib (compatibility version 62.0.0, current version 62.12.102)",
			"\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)",
			"",
		].join("\n");

		expect(parseOtoolReferences(output)).toEqual([
			"/Users/test/Vibe coding/ffmpeg/lib/libavformat.62.dylib",
			"/usr/lib/libSystem.B.dylib",
		]);
	});
});
