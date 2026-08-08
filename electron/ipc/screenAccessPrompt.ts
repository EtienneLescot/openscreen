/**
 * How long after raising the native prompt to keep reporting "not-determined".
 *
 * Matches the renderer's retry budget in `openSourceSelectorFlow` (8 attempts,
 * 750ms apart), which is the window the user has to answer the prompt before
 * the Settings dialog takes over.
 */
export const SCREEN_PROMPT_GRACE_MS = 6_000;

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
 * click, and lets a later call report the real status so the Settings dialog
 * still reaches a user who said no.
 */
export function shouldPromptForScreenAccess(status: string, promptedAt: number | null): boolean {
	if (status === "granted") {
		return false;
	}

	return status === "not-determined" || promptedAt === null;
}

/**
 * Whether the native prompt raised at `promptedAt` may still be waiting for an
 * answer, and the real status should be withheld until it is.
 *
 * macOS gives us nothing to observe here. `desktopCapturer.getSources()` settles
 * in a few milliseconds whether or not the prompt is still on screen (measured
 * at 4ms on macOS 26.2), and the status stays "denied" for the whole time the
 * prompt is up — it only ever flips once the user accepts. So an in-flight flag
 * around that call covers nothing, and reporting "denied" straight away would
 * open System Settings over the prompt and abort the renderer's retry loop on
 * its first poll.
 *
 * Treating the grace window as "still asking" keeps the loop polling long enough
 * to notice an accept, and lets the Settings dialog through once it lapses.
 */
export function isAwaitingScreenPromptAnswer(promptedAt: number | null, now: number): boolean {
	return promptedAt !== null && now - promptedAt < SCREEN_PROMPT_GRACE_MS;
}
