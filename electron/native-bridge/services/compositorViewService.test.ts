import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURSOR_THEMES } from "../../../src/lib/cursor/cursorThemes";
import {
	CompositorViewService,
	ffmpegSharedBinCandidates,
	resolveSceneAssetPaths,
} from "./compositorViewService";

/** A source checkout's `poc-d3d/.cargo/config.toml`, with `FFMPEG_DIR` written as `body`. */
function writeCargoConfig(root: string, body: string): void {
	const cargoDir = path.join(root, "poc-d3d", ".cargo");
	fs.mkdirSync(cargoDir, { recursive: true });
	fs.writeFileSync(
		path.join(cargoDir, "config.toml"),
		`# pin comment\n[env]\n${body}\nLIBCLANG_PATH = "C:\\\\Program Files\\\\LLVM\\\\bin"\n`,
		"utf8",
	);
}

describe("ffmpegSharedBinCandidates", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-ffmpeg-pin-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("reads the dev-vendored dir off the cargo pin instead of a second hardcoded copy of the name", () => {
		// The pin has moved before (floating `master-latest` → fixed `n8.1.2`) and
		// left this list probing a directory that no longer existed. Deriving it
		// means the next repin cannot rot the loader.
		writeCargoConfig(
			tmpRoot,
			`FFMPEG_DIR = { value = "thirdparty/ffmpeg-n9.9.9-win64-lgpl-shared", relative = true }`,
		);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toBe(
			`${tmpRoot.replace(/\\/g, "/")}/poc-d3d/thirdparty/ffmpeg-n9.9.9-win64-lgpl-shared/bin`,
		);
		expect(candidates[1]).toMatch(/electron\/native\/bin\/(win32|darwin|linux)-(x64|arm64)$/);
	});

	it("accepts the plain-string spelling of the pin as well as the table one", () => {
		writeCargoConfig(tmpRoot, `FFMPEG_DIR = "thirdparty/ffmpeg-plain"`);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toBe(
			`${tmpRoot.replace(/\\/g, "/")}/poc-d3d/thirdparty/ffmpeg-plain/bin`,
		);
	});

	it("keeps an absolute pin absolute rather than nesting it under the crate dir", () => {
		// `path.isAbsolute` is platform-dependent — "C:/vendor" is absolute on
		// Windows and relative on POSIX — so spell the pin through path.resolve
		// and assert the behaviour rather than one platform's drive letter.
		const absolutePin = path.resolve("/vendor/ffmpeg").replace(/\\/g, "/");
		writeCargoConfig(tmpRoot, `FFMPEG_DIR = "${absolutePin}"`);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toBe(`${absolutePin}/bin`);
		expect(candidates[0]).not.toContain("poc-d3d");
	});

	it("starts at the arch-tagged native bin dir when there is no cargo pin to read", () => {
		// Packaged builds ship no `poc-d3d/` at all — the dev candidate must drop
		// out silently rather than contribute a path that can never exist.
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toMatch(/electron\/native\/bin\/(win32|darwin|linux)-(x64|arm64)$/);
		expect(candidates.some((c) => c.includes("poc-d3d"))).toBe(false);
	});

	it("ignores a cargo config that pins no FFMPEG_DIR", () => {
		writeCargoConfig(tmpRoot, `SOME_OTHER_VAR = "thirdparty/nope"`);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates.some((c) => c.includes("poc-d3d"))).toBe(false);
	});

	it("also probes process.resourcesPath, since electron/native/bin ships only via extraResources in packaged builds", () => {
		writeCargoConfig(tmpRoot, `FFMPEG_DIR = { value = "thirdparty/ffmpeg-x", relative = true }`);
		const original = process.resourcesPath;
		Object.defineProperty(process, "resourcesPath", {
			value: "C:/fake/resources",
			configurable: true,
		});
		try {
			const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));
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

	/** Lay down a source checkout: the cargo pin plus the tree it points at. */
	function vendorPinnedFfmpeg(root: string): string {
		writeCargoConfig(
			root,
			`FFMPEG_DIR = { value = "thirdparty/ffmpeg-n8.1.2-win64-lgpl-shared", relative = true }`,
		);
		const dir = path.join(root, "poc-d3d", "thirdparty", "ffmpeg-n8.1.2-win64-lgpl-shared", "bin");
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	it("prepends the ffmpeg shared-DLL dir to PATH when it exists, even though the addon itself is absent", () => {
		const ffmpegDir = vendorPinnedFfmpeg(tmpRoot);
		process.env.PATH = "C:\\Windows\\System32";

		const service = new CompositorViewService({ appRoot: tmpRoot, isPackaged: false });
		expect(service.hasAddon()).toBe(false); // no compositor_view.node under tmpRoot
		expect(process.env.PATH?.split(path.delimiter)).toContain(ffmpegDir);
	});

	it("skips a pinned dir the checkout never vendored, instead of putting a dead path on PATH", () => {
		// The exact rot this derivation removes: a pin naming a tree that isn't
		// on disk must contribute nothing, not a candidate that can never resolve.
		writeCargoConfig(tmpRoot, `FFMPEG_DIR = "thirdparty/ffmpeg-not-vendored"`);
		process.env.PATH = "C:\\Windows\\System32";
		const before = process.env.PATH;

		new CompositorViewService({ appRoot: tmpRoot, isPackaged: false }).hasAddon();

		expect(process.env.PATH).toBe(before);
	});

	it("leaves PATH untouched when no ffmpeg shared-DLL dir exists", () => {
		process.env.PATH = "C:\\Windows\\System32";
		const before = process.env.PATH;

		const service = new CompositorViewService({ appRoot: tmpRoot, isPackaged: false });
		service.hasAddon();

		expect(process.env.PATH).toBe(before);
	});

	it("does not duplicate the entry when PATH already contains it", () => {
		const ffmpegDir = vendorPinnedFfmpeg(tmpRoot);
		process.env.PATH = "C:\\Windows\\System32";

		// simulates a second view/service instance loading after PATH was
		// already primed by the first — same appRoot, fresh instance.
		new CompositorViewService({ appRoot: tmpRoot, isPackaged: false }).hasAddon();
		new CompositorViewService({ appRoot: tmpRoot, isPackaged: false }).hasAddon();

		const occurrences = process.env.PATH?.split(path.delimiter).filter((p) => p === ffmpegDir);
		expect(occurrences?.length).toBe(1);
	});
});

describe("resolveSceneAssetPaths", () => {
	// A packaged install: `wallpapers/` and `cursors/` exist as real files under
	// resourcesPath (extraResources), while VITE_PUBLIC points into the asar, where
	// nothing is readable by the Rust addon — the exact layout that broke both features.
	let resources: string;
	let originalResourcesPath: PropertyDescriptor | undefined;
	let originalVitePublic: string | undefined;
	const themed = CURSOR_THEMES.find((t) => t.assets.arrow);

	beforeEach(() => {
		resources = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-scene-assets-"));
		fs.mkdirSync(path.join(resources, "wallpapers"), { recursive: true });
		fs.writeFileSync(path.join(resources, "wallpapers", "wallpaper1.jpg"), "jpg");
		if (themed?.assets.arrow) {
			const arrow = path.join(resources, themed.assets.arrow.assetPath);
			fs.mkdirSync(path.dirname(arrow), { recursive: true });
			fs.writeFileSync(arrow, "png");
		}
		originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
		Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
		originalVitePublic = process.env.VITE_PUBLIC;
		// vite copies public/ into dist, so the names exist inside the archive — but the
		// archive is a file, so no candidate under it can ever pass an existence check.
		process.env.VITE_PUBLIC = path.join(resources, "app.asar", "dist");
	});

	afterEach(() => {
		if (originalResourcesPath) {
			Object.defineProperty(process, "resourcesPath", originalResourcesPath);
		}
		if (originalVitePublic === undefined) {
			delete process.env.VITE_PUBLIC;
		} else {
			process.env.VITE_PUBLIC = originalVitePublic;
		}
		fs.rmSync(resources, { recursive: true, force: true });
	});

	function resolved(scene: Record<string, unknown>) {
		return JSON.parse(resolveSceneAssetPaths(JSON.stringify(scene)));
	}

	it("resolves a bundled wallpaper to the extraResources copy, not the unreadable asar path", () => {
		const out = resolved({ background: { kind: "image", path: "/wallpapers/wallpaper1.jpg" } });

		expect(out.background.path).toBe(path.join(resources, "wallpapers", "wallpaper1.jpg"));
		expect(out.background.path).not.toContain("app.asar");
		expect(fs.existsSync(out.background.path)).toBe(true);
	});

	it("resolves a cursor theme's arrow sprite to a path that exists on disk", () => {
		if (!themed) return; // no bundled theme ships an arrow override
		const out = resolved({ cursor: { theme: themed.id } });

		expect(out.cursor.cursorSpritePath).toBe(path.join(resources, themed.assets.arrow!.assetPath));
		expect(fs.existsSync(out.cursor.cursorSpritePath)).toBe(true);
	});

	it("leaves a custom upload's data: URL untouched — the addon decodes it in memory", () => {
		const dataUrl = "data:image/png;base64,SGkh";
		const out = resolved({ background: { kind: "image", path: dataUrl } });

		expect(out.background.path).toBe(dataUrl);
	});

	it("nulls the sprite for the default theme so the built-in art is used", () => {
		expect(resolved({ cursor: { theme: "default" } }).cursor.cursorSpritePath).toBeNull();
	});

	it("leaves the scene alone when no base dir holds the asset", () => {
		const out = resolved({ background: { kind: "image", path: "/wallpapers/absent.jpg" } });

		expect(out.background.path).toBe("/wallpapers/absent.jpg");
	});
});
