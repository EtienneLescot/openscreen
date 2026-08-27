import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_UPDATE_MODE, parseUpdateMode, type UpdateMode } from "./background-update";

export function updateSettingsPath(userData: string): string {
	return path.join(userData, "update-settings.json");
}

export function loadUpdateMode(userData: string): UpdateMode {
	const file = updateSettingsPath(userData);
	if (!existsSync(file)) return DEFAULT_UPDATE_MODE;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown };
		return parseUpdateMode(raw.mode);
	} catch {
		return DEFAULT_UPDATE_MODE;
	}
}

export function saveUpdateMode(userData: string, mode: UpdateMode): void {
	try {
		writeFileSync(updateSettingsPath(userData), `${JSON.stringify({ mode })}\n`, "utf8");
	} catch {
		// Best-effort; a failed write must not block the tray click.
	}
}
