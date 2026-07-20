import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompositorViewService, ffmpegSharedBinCandidates } from "./compositorViewService";

describe("ffmpegSharedBinCandidates", () => {
	it("lists the dev-vendored shared-ffmpeg dir before the arch-tagged native bin dir", () => {
		const appRoot = "C:/fake/repo";
		const candidates = ffmpegSharedBinCandidates(appRoot).map((p) => p.replace(/\\/g, "/"));
		expect(candidates[0]).toBe(
			`${appRoot}/poc-d3d/thirdparty/ffmpeg-master-latest-win64-lgpl-shared/bin`,
		);
		expect(candidates[1]).toMatch(/electron\/native\/bin\/(win32|darwin|linux)-(x64|arm64)$/);
	});

	it("also probes process.resourcesPath, since electron/native/bin ships only via extraResources in packaged builds", () => {
		const original = process.resourcesPath;
		Object.defineProperty(process, "resourcesPath", {
			value: "C:/fake/resources",
			configurable: true,
		});
		try {
			const candidates = ffmpegSharedBinCandidates("C:/fake/repo").map((p) =>
				p.replace(/\\/g, "/"),
			);
			expect(candidates).toContain(
				`C:/fake/resources/electron/native/bin/${candidates[1]!.split("/").at(-1)}`,
			);
		} finally {
			Object.defineProperty(process, "resourcesPath", { value: original, configurable: true });
		}
	});
});

describe("CompositorViewService ffmpeg PATH prepend", () => {
	let tmpRoot: string;
	let originalPath: string | undefined;
	let originalPlatform: PropertyDescriptor | undefined;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-compositor-test-"));
		originalPath = process.env.PATH;
		originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
		process.env.PATH = originalPath;
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	it("prepends the ffmpeg shared-DLL dir to PATH when it exists, even though the addon itself is absent", () => {
		const ffmpegDir = path.join(
			tmpRoot,
			"poc-d3d",
			"thirdparty",
			"ffmpeg-master-latest-win64-lgpl-shared",
			"bin",
		);
		fs.mkdirSync(ffmpegDir, { recursive: true });
		process.env.PATH = "C:\\Windows\\System32";

		const service = new CompositorViewService({ appRoot: tmpRoot, isPackaged: false });
		expect(service.hasAddon()).toBe(false); // no compositor_view.node under tmpRoot
		expect(process.env.PATH?.split(path.delimiter)).toContain(ffmpegDir);
	});

	it("leaves PATH untouched when no ffmpeg shared-DLL dir exists", () => {
		process.env.PATH = "C:\\Windows\\System32";
		const before = process.env.PATH;

		const service = new CompositorViewService({ appRoot: tmpRoot, isPackaged: false });
		service.hasAddon();

		expect(process.env.PATH).toBe(before);
	});

	it("does not duplicate the entry when PATH already contains it", () => {
		const ffmpegDir = path.join(
			tmpRoot,
			"poc-d3d",
			"thirdparty",
			"ffmpeg-master-latest-win64-lgpl-shared",
			"bin",
		);
		fs.mkdirSync(ffmpegDir, { recursive: true });
		process.env.PATH = "C:\\Windows\\System32";

		// simulates a second view/service instance loading after PATH was
		// already primed by the first — same appRoot, fresh instance.
		new CompositorViewService({ appRoot: tmpRoot, isPackaged: false }).hasAddon();
		new CompositorViewService({ appRoot: tmpRoot, isPackaged: false }).hasAddon();

		const occurrences = process.env.PATH?.split(path.delimiter).filter((p) => p === ffmpegDir);
		expect(occurrences?.length).toBe(1);
	});
});
