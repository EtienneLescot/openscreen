import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { CURSOR_THEMES, DEFAULT_CURSOR_THEME_ID } from "../../../src/lib/cursor/cursorThemes";
import type {
	ClipInput,
	CompositorParamValue,
	CompositorViewAddon,
	CompositorViewRect,
	ExportParamsInput,
	ExportStats,
	NativeFramePacket,
} from "../../native/compositor-view/addon";

/**
 * ESM-safe `require` for loading the native addon
 * (`compositor_view.node`). The electron main bundle is ESM at the source
 * level; `require()` isn't available at the top level. `createRequire` keeps
 * the addon require dynamic so vite/rollup never tries to bundle the native
 * binary.
 */
const localRequire: NodeRequire = createRequire(import.meta.url) as unknown as NodeRequire;

/**
 * The native compositor is a separate process and can only read absolute
 * filesystem paths — it can't resolve renderer-relative asset URLs like
 * `/wallpapers/wallpaper1.jpg` or fetch `http(s)://`/`data:` URLs. Bundled
 * wallpapers live under `process.env.VITE_PUBLIC` (dev: `<root>/public`,
 * packaged: the renderer dist), so rewrite an image background's root-relative
 * path to that absolute location before handing the scene to the addon. Other
 * schemes (data:, http:) are left as-is; the native side falls back to a flat
 * colour when it can't load them. Malformed JSON passes through untouched.
 */
/** Absolute path of a theme's "arrow" sprite under `publicDir`, or null (unknown theme /
 *  default / theme ships no arrow override — same fallback the web renderer applies). */
function resolveCursorThemeArrowPath(themeId: string, publicDir: string): string | null {
	if (!themeId || themeId === DEFAULT_CURSOR_THEME_ID) {
		return null;
	}
	const theme = CURSOR_THEMES.find((t) => t.id === themeId);
	const arrow = theme?.assets.arrow;
	if (!arrow) {
		return null;
	}
	return path.join(publicDir, arrow.assetPath);
}

function resolveSceneAssetPaths(sceneJson: string): string {
	const publicDir = process.env.VITE_PUBLIC;
	if (!publicDir) {
		return sceneJson;
	}
	try {
		const scene = JSON.parse(sceneJson) as {
			background?: { kind?: string; path?: string };
			cursor?: { theme?: string; cursorSpritePath?: string | null };
		};
		let changed = false;
		const bg = scene.background;
		if (bg?.kind === "image" && typeof bg.path === "string" && bg.path.startsWith("/")) {
			// strip the leading slash so path.join keeps it under publicDir
			bg.path = path.join(publicDir, bg.path.replace(/^\/+/, ""));
			changed = true;
		}
		if (scene.cursor && typeof scene.cursor.theme === "string") {
			scene.cursor.cursorSpritePath = resolveCursorThemeArrowPath(scene.cursor.theme, publicDir);
			changed = true;
		}
		return changed ? JSON.stringify(scene) : sceneJson;
	} catch {
		return sceneJson;
	}
}

export interface CompositorViewServiceOptions {
	/**
	 * Optional explicit override for the addon path. Has precedence over the
	 * `OPENSCREEN_COMPOSITOR_VIEW_NODE` env var and the candidate path list.
	 * Useful for poking at a locally-built `.node` without copying it into
	 * the standard search root.
	 */
	envOverride?: string | null;
	/**
	 * Directory to resolve candidate paths relative to. Defaults to
	 * `app.getAppPath()` so dev (unpackaged) and packaged setups resolve the
	 * same relative path. Tests can inject a temp directory here.
	 */
	appRoot?: string;
	isPackaged?: boolean;
}

function defaultAppRoot(): string {
	try {
		return app.getAppPath();
	} catch {
		// bare-node test environment — fall back to the source tree root
		// via this file's location (service lives at
		// electron/native-bridge/services/, project root is four levels up).
		const here = path.dirname(fileURLToPath(import.meta.url));
		return path.resolve(here, "..", "..", "..", "..");
	}
}

function defaultIsPackaged(): boolean {
	try {
		return app.isPackaged;
	} catch {
		return false;
	}
}

function platformArchTag(): string {
	const platformPrefix =
		process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
	return process.arch === "arm64" ? `${platformPrefix}-arm64` : `${platformPrefix}-x64`;
}

function buildCandidatePaths(
	appRoot: string,
	isPackaged: boolean,
	envOverride: string | null | undefined,
): string[] {
	const builtPath = path.join(
		appRoot,
		"electron",
		"native",
		"compositor-view",
		"build",
		"compositor_view.node",
	);
	const archBinPath = path.join(
		appRoot,
		"electron",
		"native",
		"bin",
		platformArchTag(),
		"compositor_view.node",
	);
	const ordered = [envOverride, archBinPath, builtPath].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (!isPackaged) {
		return ordered;
	}
	// in packaged builds, references inside `app.asar/...` must be
	// rewritten to `.asar.unpacked/...` so dynamic `require()` can load the
	// native binary (matches the capture-helper resolution policy).
	return ordered.map((candidate) => candidate.replace(/\.asar([/\\])/, ".asar.unpacked$1"));
}

/**
 * The dev-vendored ffmpeg tree, read from the pin that already exists rather
 * than named a second time here: `poc-d3d/.cargo/config.toml`'s `FFMPEG_DIR`.
 *
 * That pin is the one thing the addon is actually built against (see the
 * config's own comment), so the DLL basenames it imports — `avcodec-62.dll` and
 * friends — only match the tree it points at. Restating the folder name in this
 * file is precisely how the previous entry rotted: the pin moved off a floating
 * `master-latest` snapshot onto the fixed `n8.1.2` release and this list went on
 * probing a directory that no longer existed. Nothing broke, because the search
 * silently fell through to the vendored `electron/native/bin/<tag>` — which is
 * what makes the rot worth removing rather than tolerating.
 *
 * Returns null when there is no config to read: packaged builds ship no
 * `poc-d3d/` at all, and the candidate list simply starts one entry later.
 */
function pinnedFfmpegDir(appRoot: string): string | null {
	const crateDir = path.join(appRoot, "poc-d3d");
	let toml: string;
	try {
		toml = fs.readFileSync(path.join(crateDir, ".cargo", "config.toml"), "utf8");
	} catch {
		return null;
	}
	// Both spellings cargo accepts carry the path as the first quoted string on
	// the line: `FFMPEG_DIR = "…"` and `FFMPEG_DIR = { value = "…", relative = true }`.
	const value = /^\s*FFMPEG_DIR\s*=.*?"([^"]+)"/m.exec(toml)?.[1];
	if (!value) {
		return null;
	}
	// `relative = true` resolves against the directory the config governs (the
	// crate root), which is also what the pin's own comment documents.
	return path.isAbsolute(value) ? value : path.join(crateDir, value);
}

/**
 * Directories that may hold the ffmpeg shared DLLs (avcodec/avformat/avutil/…)
 * the addon dynamically links against. Node's `require()` of a native addon
 * does a Win32 `LoadLibrary` under the hood, which resolves dependent DLLs via
 * the standard search order — including `PATH` — so whichever of these exists
 * gets prepended to `process.env.PATH` before the `require()` in
 * `tryLoadAddon`.
 *
 * Order: the dev-only vendored location first (absent outside a source
 * checkout — see `pinnedFfmpegDir`), then the arch-tagged bin dir under
 * `appRoot` (dev / `electron-builder --dir` unpacked staging), then the *same*
 * dir under `process.resourcesPath` — required for real packaged installers,
 * since `electron/native/bin/**` ships exclusively via `extraResources` (see
 * `electron-builder.json5`'s `files` list, which only packs
 * `dist`/`dist-electron`) and is never inside `app.getAppPath()` there.
 * Mirrors the appPath/resourcePath pattern `stt/gpuDetector.ts` already uses
 * for the other native binaries in this same directory.
 */
export function ffmpegSharedBinCandidates(appRoot: string): string[] {
	const tag = platformArchTag();
	const resourcesPath =
		typeof process.resourcesPath === "string" && process.resourcesPath.length > 0
			? process.resourcesPath
			: null;
	const devDir = pinnedFfmpegDir(appRoot);
	return [
		...(devDir ? [path.join(devDir, "bin")] : []),
		path.join(appRoot, "electron", "native", "bin", tag),
		...(resourcesPath ? [path.join(resourcesPath, "electron", "native", "bin", tag)] : []),
	];
}

/** Prepends the first existing ffmpeg shared-DLL dir to `PATH` (no-op if already present or none found). */
function ensureFfmpegSharedDllsOnPath(appRoot: string): void {
	if (process.platform !== "win32") {
		return;
	}
	const dir = ffmpegSharedBinCandidates(appRoot).find((candidate) => fs.existsSync(candidate));
	if (!dir) {
		return;
	}
	const current = process.env.PATH ?? "";
	if (current.split(path.delimiter).includes(dir)) {
		return;
	}
	process.env.PATH = `${dir}${path.delimiter}${current}`;
}

function tryLoadAddon(candidates: string[]): CompositorViewAddon | null {
	for (const candidate of candidates) {
		try {
			// only attempt the require when the file actually exists
			// — `require()` of a missing native module throws a noisy
			// MODULE_NOT_FOUND that pollutes the renderer console.
			if (!fs.existsSync(candidate)) {
				continue;
			}
			const loaded = localRequire(candidate) as unknown;
			if (loaded && typeof loaded === "object") {
				return loaded as CompositorViewAddon;
			}
		} catch (err) {
			// log and try the next candidate — a single broken build
			// shouldn't kill the addon entirely, but silently swallowing this
			// is exactly what made a missing-ffmpeg-DLL failure look like a
			// generic "addon not present" no-op.
			console.warn(`[compositor-view] failed to load addon candidate ${candidate}:`, err);
		}
	}
	return null;
}

export class CompositorViewService {
	private readonly options: CompositorViewServiceOptions;
	private readonly rects = new Map<number, CompositorViewRect>();
	private addon: CompositorViewAddon | null = null;
	private loadAttempted = false;
	private syntheticIdCounter = 0;

	constructor(options: CompositorViewServiceOptions = {}) {
		this.options = options;
	}

	private ensureAddon(): CompositorViewAddon | null {
		if (this.loadAttempted) {
			return this.addon;
		}
		this.loadAttempted = true;

		const envOverride =
			this.options.envOverride ?? process.env.OPENSCREEN_COMPOSITOR_VIEW_NODE ?? null;
		const appRoot = this.options.appRoot ?? defaultAppRoot();
		const isPackaged = this.options.isPackaged ?? defaultIsPackaged();

		ensureFfmpegSharedDllsOnPath(appRoot);
		const candidates = buildCandidatePaths(appRoot, isPackaged, envOverride);
		const loaded = tryLoadAddon(candidates);
		if (!loaded) {
			// single log line, exactly as specified — repeated
			// ensureAddon calls just return null without spamming the console.
			console.log("[compositor-view] native addon not present; running as no-op");
			return null;
		}
		this.addon = loaded;
		return this.addon;
	}

	/** True when the native `.node` addon was successfully loaded. */
	hasAddon(): boolean {
		return this.ensureAddon() !== null;
	}

	/** Allocates an offscreen compositor view sized to `rect.width`x`rect.height`.
	 *  `rect.x` / `rect.y` are vestigial (ignored native-side) — the renderer
	 *  keeps them on the wire so the existing `CompositorViewRect` shape stays
	 *  source-compatible. No HWND/native-window-handle is passed: there's no
	 *  OS window to parent to. */
	createView(
		rect: CompositorViewRect,
		paths?: { screenPath?: string; webcamPath?: string; cursorPath?: string },
	): number {
		const addon = this.ensureAddon();
		if (!addon) {
			// synthetic negative ids let callers do bookkeeping
			// (cleanup in destroyView) without crashing when no native view
			// exists. Each call gets a fresh id so multiple no-op views
			// stay independent.
			this.syntheticIdCounter -= 1;
			const id = this.syntheticIdCounter;
			this.rects.set(id, rect);
			return id;
		}
		const id = addon.createView(rect, paths?.screenPath, paths?.webcamPath, paths?.cursorPath);
		this.rects.set(id, rect);
		return id;
	}

	setRect(id: number, rect: CompositorViewRect): void {
		const addon = this.ensureAddon();
		this.rects.set(id, rect);
		if (!addon) {
			return;
		}
		addon.setRect(id, rect);
	}

	/** Reads the most recently rendered frame for `id` as a self-describing packet
	 *  (`{ gen, width, height, data }`), but only if its generation is newer than
	 *  `sinceGen`. Returns `null` when the addon is absent, no frame is ready yet,
	 *  OR the caller already holds the current generation — the idle path, where
	 *  `null` comes back without any buffer copy. Byte order is RGBA. */
	readFrame(id: number, sinceGen: number): NativeFramePacket | null {
		const addon = this.ensureAddon();
		if (!addon) {
			return null;
		}
		return addon.readFrame(id, sinceGen);
	}

	setParam(id: number, key: string, value: CompositorParamValue): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.setParam(id, key, value);
	}

	setPlaying(id: number, playing: boolean): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.setPlaying(id, playing);
	}

	presentTime(id: number, seconds: number): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.presentTime(id, seconds);
	}

	setScene(id: number, sceneJson: string): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.setScene(id, resolveSceneAssetPaths(sceneJson));
	}

	setActiveClip(
		id: number,
		screenPath: string,
		webcamPath: string,
		webcamOffsetSec: number,
		clipIndex: number,
		sourceTimeSec: number,
	): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.setActiveClip(id, screenPath, webcamPath, webcamOffsetSec, clipIndex, sourceTimeSec);
	}

	destroyView(id: number): void {
		const addon = this.ensureAddon();
		this.rects.delete(id);
		if (!addon) {
			return;
		}
		addon.destroyView(id);
	}

	/** Native export (fixture -> MP4, C8). Auto-pauses live previews to free the GPU.
	 *  `onProgress` (frames encoded so far) is optional, forwarded straight from the addon's
	 *  own throttled (~10/s) callback — cheap, the encode loop already ticks this per frame.
	 *  Returns null when the addon is absent. */
	async export(
		outPath?: string,
		onProgress?: (frames: number) => void,
	): Promise<ExportStats | null> {
		const addon = this.ensureAddon();
		if (!addon) {
			return null;
		}
		const target = outPath ?? path.join(app.getPath("temp"), "openscreen-native-export.mp4");
		return addon.export(target, onProgress);
	}

	/** Native multiclip export (real timeline -> MP4). Auto-pauses previews via the addon.
	 *  `sceneJson` — same scene as the live preview (background/layout/webcam/cursor/effects);
	 *  goes through the same asset-path resolution as `setScene` (wallpaper image, cursor theme
	 *  sprite) since the native process can't resolve renderer-relative URLs either.
	 *  `onProgress` — see `export()` above.
	 *  Returns null when the addon is absent. */
	async exportMulti(
		clips: ClipInput[],
		outPath?: string,
		sceneJson?: string,
		params?: ExportParamsInput,
		onProgress?: (frames: number) => void,
	): Promise<ExportStats | null> {
		const addon = this.ensureAddon();
		if (!addon) {
			return null;
		}
		const target = outPath ?? path.join(app.getPath("temp"), "openscreen-native-export.mp4");
		return addon.exportMulti(
			clips,
			target,
			sceneJson ? resolveSceneAssetPaths(sceneJson) : undefined,
			params,
			onProgress,
		);
	}
}
