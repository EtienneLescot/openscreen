import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import type {
	CompositorParamValue,
	CompositorViewAddon,
	CompositorViewRect,
	ExportStats,
} from "../../native/compositor-view/addon";

/**
 * ESM-safe `require` for loading the native addon
 * (`compositor_view.node`). The electron main bundle is ESM at the source
 * level; `require()` isn't available at the top level. `createRequire` keeps
 * the addon require dynamic so vite/rollup never tries to bundle the native
 * binary.
 */
const localRequire: NodeRequire = createRequire(import.meta.url) as unknown as NodeRequire;

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
		} catch {
			// try the next candidate — a single broken build
			// shouldn't kill the addon entirely.
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

	createView(
		parentHandle: Buffer,
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
		const id = addon.createView(
			parentHandle,
			rect,
			paths?.screenPath,
			paths?.webcamPath,
			paths?.cursorPath,
		);
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

	destroyView(id: number): void {
		const addon = this.ensureAddon();
		this.rects.delete(id);
		if (!addon) {
			return;
		}
		addon.destroyView(id);
	}

	/** Native export (fixture -> MP4, C8). Auto-pauses live previews to free the GPU.
	 *  Returns null when the addon is absent. */
	async export(outPath?: string): Promise<ExportStats | null> {
		const addon = this.ensureAddon();
		if (!addon) {
			return null;
		}
		const target = outPath ?? path.join(app.getPath("temp"), "openscreen-native-export.mp4");
		return addon.export(target);
	}
}
