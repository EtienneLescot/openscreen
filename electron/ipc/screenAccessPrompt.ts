/**
 * Decides whether to raise macOS' own Screen Recording prompt.
 *
 * `systemPreferences.getMediaAccessStatus("screen")` cannot answer
 * "not-determined" on macOS. Chromium resolves that permission through
 * `CGPreflightScreenCaptureAccess()`, a bool, so a machine that has never been
 * asked is reported exactly like an explicit refusal — both arrive as "denied".
 * Gating the prompt on `status === "not-determined"` therefore never fires: a
 * fresh install falls straight through to the "open System Settings" dialog and
 * macOS is never given the chance to ask, so the only way to grant is a manual
 * toggle. The renderer's permission-retry loop arms on the same status and is
 * dead for the same reason.
 *
 * Drive the first prompt off whether this launch has already asked instead.
 * Asking once per launch keeps a genuine refusal from re-prompting on every
 * click, and lets the next call report the real status so the Settings dialog
 * still reaches a user who said no.
 */
export function shouldPromptForScreenAccess(
	status: string,
	hasPromptedThisLaunch: boolean,
): boolean {
	if (status === "granted") {
		return false;
	}

	return status === "not-determined" || !hasPromptedThisLaunch;
}
