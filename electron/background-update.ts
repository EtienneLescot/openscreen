import type { UpdateOutcome } from "./auto-updater";

/** How far a background-discovered update may go on its own. No mode ever
 *  flips `autoInstallOnAppQuit`: install is always an explicit
 *  `quitAndInstall` behind a restart prompt, because `window-all-closed`
 *  quits this app and the HUD is a window — install-on-quit would fire a
 *  ~243 MB installer when the user merely closed the HUD. */
export type UpdateMode = "notify" | "download" | "download-and-install";

export const DEFAULT_UPDATE_MODE: UpdateMode = "notify";
export const BACKGROUND_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function parseUpdateMode(raw: unknown): UpdateMode {
	if (raw === "notify" || raw === "download" || raw === "download-and-install") return raw;
	return DEFAULT_UPDATE_MODE;
}

export function shouldStartBackgroundUpdateTimer(input: {
	isPackaged: boolean;
	ownsItsUpdates: boolean;
}): boolean {
	return input.isPackaged && input.ownsItsUpdates;
}

export type BackgroundUpdatePlan =
	| { action: "none" }
	| { action: "notify-available"; version: string }
	| { action: "download"; version: string }
	| { action: "download-and-install"; version: string };

/** Background path: never plan a "you are current" dialog. */
export function planBackgroundUpdate(input: {
	outcome: UpdateOutcome;
	mode: UpdateMode;
}): BackgroundUpdatePlan {
	if (input.outcome.kind !== "downloaded") return { action: "none" };
	switch (input.mode) {
		case "notify":
			return { action: "notify-available", version: input.outcome.version };
		case "download":
			return { action: "download", version: input.outcome.version };
		case "download-and-install":
			return { action: "download-and-install", version: input.outcome.version };
	}
}

export function shouldQuitAndInstallAfterRestartPrompt(response: number): boolean {
	return response === 0;
}

/** The failure carries the download error: the dialog that reports it shows
 *  `error.message` as detail, and collapsing the outcome to a bare string
 *  here is exactly how that detail once got lost between the helper and the
 *  caller. */
export type DownloadAndInstallResult =
	| { status: "failed"; error: Error }
	| { status: "unavailable" }
	| { status: "blocked" }
	| { status: "cancelled" }
	| { status: "installed" };

export async function runUnblockedDownloadAndInstall(deps: {
	download: () => Promise<UpdateOutcome>;
	blocked: () => string | null;
	confirmRestart: () => Promise<number>;
	install: () => Promise<void>;
}): Promise<DownloadAndInstallResult> {
	const downloaded = await deps.download();
	if (downloaded.kind === "failed") return { status: "failed", error: downloaded.error };
	// `downloadSelfUpdate` only ever reports downloaded|failed today, but the
	// UpdateOutcome type admits current|unsupported — neither of which may
	// reach the restart prompt, let alone quitAndInstall.
	if (downloaded.kind !== "downloaded") return { status: "unavailable" };
	if (deps.blocked()) return { status: "blocked" };
	const choice = await deps.confirmRestart();
	if (!shouldQuitAndInstallAfterRestartPrompt(choice)) return { status: "cancelled" };
	await deps.install();
	return { status: "installed" };
}
