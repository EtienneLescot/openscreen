/**
 * Gets the current platform from Electron. `process.platform` is a synchronous
 * Node global available in both the main and renderer processes, so we read it
 * directly here instead of bouncing through an IPC round-trip.
 */
export function getPlatform(): NodeJS.Platform {
	return process.platform;
}

/**
 * Detects if the current platform is macOS.
 */
export const isMac = (): boolean => getPlatform() === "darwin";

/**
 * Gets the modifier key symbol based on the platform.
 */
export const getModifierKey = (): "⌘" | "Ctrl" => (isMac() ? "⌘" : "Ctrl");

/**
 * Gets the shift key symbol based on the platform.
 */
export const getShiftKey = (): "⇧" | "Shift" => (isMac() ? "⇧" : "Shift");

/**
 * Formats a keyboard shortcut for display based on the platform.
 * @param keys Array of key combinations (e.g., ['mod', 'D'] or ['shift', 'mod', 'Scroll'])
 */
export function formatShortcut(keys: string[]): string {
	const isMacPlatform = isMac();
	return keys
		.map((key) => {
			if (key.toLowerCase() === "mod") return isMacPlatform ? "⌘" : "Ctrl";
			if (key.toLowerCase() === "shift") return isMacPlatform ? "⇧" : "Shift";
			return key;
		})
		.join(" + ");
}
