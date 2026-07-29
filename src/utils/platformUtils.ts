/**
 * Gets the current platform.
 *
 * The renderer runs with `contextIsolation: true` / `nodeIntegration: false`,
 * so the Node `process` global does not exist here — it lives only in the
 * preload's isolated world. `electron/preload.ts` snapshots `process.platform`
 * once and exposes it as a plain string, which is what we read.
 *
 * Browser mode (`src/native/browserShim.ts`, `?browser`) has no `electronAPI`,
 * so fall back to sniffing `navigator` rather than throwing.
 */
export function getPlatform(): NodeJS.Platform {
	const fromPreload = window.electronAPI?.getPlatform?.();
	if (fromPreload) return fromPreload as NodeJS.Platform;

	if (typeof navigator !== "undefined") {
		const ua = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
		if (/Mac|iPhone|iPad|iPod/.test(ua)) return "darwin";
		if (/Linux|Android/.test(ua)) return "linux";
	}
	return "win32";
}

/**
 * Detects if the current platform is macOS.
 */
export const isMac = (): boolean => getPlatform() === "darwin";
