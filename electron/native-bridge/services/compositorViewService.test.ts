import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURSOR_THEMES, DEFAULT_CURSOR_SPRITES } from "../../../src/lib/cursor/cursorThemes";
import {
	buildCandidatePaths,
	CompositorViewService,
	ffmpegSharedBinCandidates,
	resolveSceneAssetPaths,
} from "./compositorViewService";

/** A source checkout's `crates/.cargo/config.toml`, with `FFMPEG_DIR` written as `body`. */
function writeCargoConfig(root: string, body: string): void {
	const cargoDir = path.join(root, "crates", ".cargo");
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
			`${tmpRoot.replace(/\\/g, "/")}/crates/thirdparty/ffmpeg-n9.9.9-win64-lgpl-shared/bin`,
		);
		expect(candidates[1]).toMatch(/electron\/native\/bin\/(win32|darwin|linux)-(x64|arm64)$/);
	});

	it("accepts the plain-string spelling of the pin as well as the table one", () => {
		writeCargoConfig(tmpRoot, `FFMPEG_DIR = "thirdparty/ffmpeg-plain"`);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toBe(`${tmpRoot.replace(/\\/g, "/")}/crates/thirdparty/ffmpeg-plain/bin`);
	});

	it("keeps an absolute pin absolute rather than nesting it under the crate dir", () => {
		// `path.isAbsolute` is platform-dependent — "C:/vendor" is absolute on
		// Windows and relative on POSIX — so spell the pin through path.resolve
		// and assert the behaviour rather than one platform's drive letter.
		const absolutePin = path.resolve("/vendor/ffmpeg").replace(/\\/g, "/");
		writeCargoConfig(tmpRoot, `FFMPEG_DIR = "${absolutePin}"`);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toBe(`${absolutePin}/bin`);
		expect(candidates[0]).not.toContain("crates");
	});

	it("starts at the arch-tagged native bin dir when there is no cargo pin to read", () => {
		// Packaged builds ship no `crates/` at all — the dev candidate must drop
		// out silently rather than contribute a path that can never exist.
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates[0]).toMatch(/electron\/native\/bin\/(win32|darwin|linux)-(x64|arm64)$/);
		expect(candidates.some((c) => c.includes("crates"))).toBe(false);
	});

	it("ignores a cargo config that pins no FFMPEG_DIR", () => {
		writeCargoConfig(tmpRoot, `SOME_OTHER_VAR = "thirdparty/nope"`);
		const candidates = ffmpegSharedBinCandidates(tmpRoot).map((p) => p.replace(/\\/g, "/"));

		expect(candidates.some((c) => c.includes("crates"))).toBe(false);
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

describe("buildCandidatePaths", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-addon-path-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	const norm = (p: string) => p.replace(/\\/g, "/");

	it("finds the addon from dist-electron, which is what app.getAppPath() returns unpackaged", () => {
		// The regression this exists for: `electron dist-electron/main.js` — the entry
		// `npm run dev` uses — makes app.getAppPath() the dist-electron DIRECTORY, not
		// the checkout root. Every candidate was built by joining "electron/native/..."
		// onto it, so none of them existed and the editor ran with a no-op compositor
		// on a machine that had a perfectly good addon one level up.
		fs.mkdirSync(path.join(tmpRoot, "electron", "native", "bin"), { recursive: true });
		const appRoot = path.join(tmpRoot, "dist-electron");
		fs.mkdirSync(appRoot, { recursive: true });

		const candidates = buildCandidatePaths(appRoot, false, null).map(norm);

		expect(
			candidates.some((c) => c.startsWith(norm(tmpRoot)) && !c.includes("dist-electron")),
		).toBe(true);
	});

	it("stops walking up when no ancestor holds electron/native", () => {
		const appRoot = path.join(tmpRoot, "nothing", "here");
		fs.mkdirSync(appRoot, { recursive: true });

		const candidates = buildCandidatePaths(appRoot, false, null).map(norm);

		expect(candidates.every((c) => c.startsWith(norm(appRoot)) || c.includes("resources"))).toBe(
			true,
		);
	});

	it("also probes process.resourcesPath, where extraResources actually puts the addon", () => {
		// electron-builder ships electron/native/bin/<tag>/** through extraResources,
		// so in a packaged build the addon is at <resources>/electron/native/bin/<tag>
		// and NEVER inside app.asar — the .asar → .asar.unpacked rewrite cannot reach a
		// file that was never in the archive.
		const original = process.resourcesPath;
		Object.defineProperty(process, "resourcesPath", {
			value: "/fake/resources",
			configurable: true,
		});
		try {
			const candidates = buildCandidatePaths("/fake/resources/app.asar", true, null).map(norm);
			expect(
				candidates.some(
					(c) => c.startsWith("/fake/resources/electron/native/bin/") && c.endsWith(".node"),
				),
			).toBe(true);
		} finally {
			Object.defineProperty(process, "resourcesPath", { value: original, configurable: true });
		}
	});

	it("keeps the env override first", () => {
		const candidates = buildCandidatePaths(tmpRoot, false, "/explicit/compositor_view.node");
		expect(norm(candidates[0]!)).toBe("/explicit/compositor_view.node");
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
		const dir = path.join(root, "crates", "thirdparty", "ffmpeg-n8.1.2-win64-lgpl-shared", "bin");
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
		const assetPaths = [
			...Object.values(themed?.assets ?? {}).map((a) => a.assetPath),
			...Object.values(DEFAULT_CURSOR_SPRITES).map((s) => s.assetPath),
		];
		for (const assetPath of assetPaths) {
			const file = path.join(resources, assetPath);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "png");
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
			// `NodeJS.ProcessEnv.VITE_PUBLIC` is declared non-optional (electron-env.d.ts),
			// so `delete` is rejected outright even though main.ts only assigns it at
			// startup and it really is absent under vitest. Reflect deletes the same key.
			Reflect.deleteProperty(process.env, "VITE_PUBLIC");
		} else {
			process.env.VITE_PUBLIC = originalVitePublic;
		}
		fs.rmSync(resources, { recursive: true, force: true });
	});

	function resolved(scene: Record<string, unknown>) {
		return JSON.parse(resolveSceneAssetPaths(JSON.stringify(scene)));
	}

	/** What `resolveSceneAssetPaths` writes into `cursor.cursorSprites` — same shape the
	 *  service declares for the sprite map it builds. */
	type ResolvedSprite = { path: string; hotspotX: number; hotspotY: number };

	it("resolves a bundled wallpaper to the extraResources copy, not the unreadable asar path", () => {
		const out = resolved({ background: { kind: "image", path: "/wallpapers/wallpaper1.jpg" } });

		expect(out.background.path).toBe(path.join(resources, "wallpapers", "wallpaper1.jpg"));
		expect(out.background.path).not.toContain("app.asar");
		expect(fs.existsSync(out.background.path)).toBe(true);
	});

	it("resolves a cursor theme's arrow sprite to a path that exists on disk", () => {
		if (!themed) return; // no bundled theme ships an arrow override
		const arrow = resolved({ cursor: { theme: themed.id } }).cursor.cursorSprites.arrow;

		expect(arrow.path).toBe(path.join(resources, themed.assets.arrow!.assetPath));
		expect(fs.existsSync(arrow.path)).toBe(true);
	});

	it("fills the states a theme doesn't ship with the built-in art", () => {
		if (!themed) return;
		const sprites = resolved({ cursor: { theme: themed.id } }).cursor.cursorSprites;

		// The sweezy packs only carry an arrow and a pointer, but a recording walks through
		// far more states than that — each one still has to get its own sprite.
		expect(sprites.text.path).toBe(path.join(resources, "cursors", "default", "text.png"));
		expect(sprites["resize-ew"].path).toContain(path.join("cursors", "default"));
		expect(Object.keys(sprites).sort()).toEqual(Object.keys(DEFAULT_CURSOR_SPRITES).sort());
	});

	it("carries each sprite's hotspot as a fraction of its own image", () => {
		const sprites = resolved({ cursor: { theme: "default" } }).cursor.cursorSprites;

		// The whole point of the fraction: it survives the size slider. A hotspot in source
		// pixels would have to be rescaled at draw time, and drifted when it wasn't.
		for (const [type, sprite] of Object.entries<ResolvedSprite>(sprites)) {
			expect(sprite.hotspotX, type).toBeGreaterThanOrEqual(0);
			expect(sprite.hotspotX, type).toBeLessThanOrEqual(1);
			expect(sprite.hotspotY, type).toBeGreaterThanOrEqual(0);
			expect(sprite.hotspotY, type).toBeLessThanOrEqual(1);
		}
		// The arrow's tip is near its top-left corner, nowhere near the centre it used to
		// be drawn from.
		expect(sprites.arrow.hotspotX).toBeLessThan(0.25);
		expect(sprites.arrow.hotspotY).toBeLessThan(0.25);
	});

	it("leaves a custom upload's data: URL untouched — the addon decodes it in memory", () => {
		const dataUrl = "data:image/png;base64,SGkh";
		const out = resolved({ background: { kind: "image", path: dataUrl } });

		expect(out.background.path).toBe(dataUrl);
	});

	it("gives the default theme the built-in arrow, not a placeholder", () => {
		// Regression: "default" used to resolve to no sprite at all, and the compositor drew
		// its dot-and-ring fallback — a dot in a circle where the standard arrow belongs.
		const sprites = resolved({ cursor: { theme: "default" } }).cursor.cursorSprites;

		expect(sprites.arrow.path).toBe(path.join(resources, "cursors", "default", "arrow.png"));
		expect(fs.existsSync(sprites.arrow.path)).toBe(true);
	});

	it("leaves the scene alone when no base dir holds the asset", () => {
		const out = resolved({ background: { kind: "image", path: "/wallpapers/absent.jpg" } });

		expect(out.background.path).toBe("/wallpapers/absent.jpg");
	});
});
