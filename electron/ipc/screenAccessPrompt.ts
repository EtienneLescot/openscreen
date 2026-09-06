import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Deciding when to raise macOS' own Screen Recording prompt, and when to stop.
 *
 * Two macOS facts drive everything here, and both are the opposite of what the old
 * code assumed:
 *
 * 1. `getMediaAccessStatus("screen")` cannot report "not-determined". Chromium resolves
 *    it through `CGPreflightScreenCaptureAccess()`, a bool, so a machine that has never
 *    been asked is reported exactly like an explicit refusal. Gating the prompt on
 *    "not-determined" therefore never fired, and a fresh install fell straight through
 *    to the "open System Settings" dialog with macOS never given the chance to ask.
 *
 * 2. That same preflight caches its answer for the life of the calling process. The app
 *    is long-lived, so once it has read false it reads false until relaunch, whatever the
 *    user does in System Settings. This is why polling the app's own status after raising
 *    the prompt can never observe a grant -- no delay tunes into correctness -- and why
 *    the real answer is read from a fresh child process instead
 *    (`native-bridge/screen/macScreenAccess.ts`).
 *
 * What is left is one thing macOS genuinely will not tell us: whether a TCC decision
 * already exists. "Never asked" and "refused" are the same bool. So the app records for
 * itself whether it has ever raised the prompt on this machine, which is the only honest
 * way to tell a first run from a user who said no -- and it is what keeps a refusing user
 * on the immediate, actionable Settings dialog instead of a wait for a prompt that macOS
 * will never show them again.
 */

/** Statuses the fresh-process probe can report; mirrors MacScreenAccessStatus. */
export type ScreenAccessProbeStatus =
	| "granted"
	| "denied"
	| "missing-helper"
	| "error"
	| "exited"
	| "timeout";

export interface ScreenAccessProbe {
	granted: boolean;
	status: ScreenAccessProbeStatus;
}

/** True when the probe never got far enough to answer the permission question. */
function probeAnswered(status: ScreenAccessProbeStatus) {
	return status === "granted" || status === "denied";
}

/**
 * The status to report, preferring the uncached probe over the app's own stale read.
 *
 * Falls back to whatever `getMediaAccessStatus` said when the probe could not answer --
 * no helper in the build, a loader failure, a crash, a hang. That fallback is the old
 * behaviour exactly, so a build without the helper is no worse off than before, and a
 * broken helper never becomes a permission refusal in the user's face.
 */
export function resolveScreenAccessStatus(
	probe: ScreenAccessProbe,
	fallbackStatus: string,
): string {
	return probeAnswered(probe.status) ? probe.status : fallbackStatus;
}

export interface ScreenPromptDecisionInput {
	/** The resolved permission status, preferring the fresh probe over the app's own read. */
	status: string;
	/** Whether this launch has already raised the prompt. */
	raisedThisLaunch: boolean;
	/** Whether this app has ever raised the prompt on this machine. */
	raisedBefore: boolean;
}

/**
 * Whether to raise macOS' prompt now.
 *
 * Only on the first ask ever, and only where a grant is actually reachable. macOS shows
 * the prompt once per TCC decision and silently ignores every later request, so asking
 * again buys nothing -- while the window-focus steal that goes with it, and the wait for
 * an answer that cannot come, cost a user who has already refused the one message they
 * can act on.
 */
export function shouldRaiseScreenPrompt({
	status,
	raisedThisLaunch,
	raisedBefore,
}: ScreenPromptDecisionInput): boolean {
	if (status === "granted") {
		return false;
	}

	// An allowlist, not "anything that is not granted". `restricted` means policy
	// forbids the grant -- an MDM-managed Mac -- so no prompt can appear and the user
	// cannot act on one. Sending those machines down the prompt path would swap their
	// only actionable message for a wait on an answer that is never coming.
	if (status !== "denied" && status !== "not-determined") {
		return false;
	}

	return !raisedThisLaunch && !raisedBefore;
}

const MARKER_FILE = "screen-access.json";

interface ScreenPromptMarkerFile {
	/** ISO timestamp of the first time this app raised the macOS prompt here. */
	promptRaisedAt?: string;
}

/**
 * Remembers, across launches, that the macOS prompt has been raised on this machine.
 *
 * Deliberately a plain file rather than anything derived from TCC: the TCC database is
 * unreadable without disabling SIP, and its "is there a decision" bit is exactly what
 * the OS refuses to expose. This is the app's own note to itself, and it is only ever
 * used to choose between "raise the prompt" and "show the dialog" -- never as an answer
 * to whether the permission is held, which always comes from a live read.
 *
 * A stale marker (the user reset TCC with `tccutil`) costs the prompt on the next run and
 * leaves the Settings dialog, which still works. A missing one costs a duplicate prompt
 * that macOS discards. Both fail towards a message the user can act on.
 */
export class ScreenPromptMarker {
	private readonly markerPath: string;
	private raised: boolean;

	constructor(userDataPath: string) {
		this.markerPath = path.join(userDataPath, MARKER_FILE);
		this.raised = this.loadSync();
	}

	private loadSync(): boolean {
		try {
			const parsed = JSON.parse(readFileSync(this.markerPath, "utf8")) as ScreenPromptMarkerFile;
			return typeof parsed.promptRaisedAt === "string";
		} catch {
			return false;
		}
	}

	hasRaisedBefore(): boolean {
		return this.raised;
	}

	/**
	 * Records that the prompt has been raised. Best-effort on disk: an unwritable
	 * userData directory must not stop the prompt the user is waiting on, and the
	 * in-memory flag still gets the rest of this launch right.
	 */
	recordRaised(nowIso: string): void {
		this.raised = true;
		try {
			const payload: ScreenPromptMarkerFile = { promptRaisedAt: nowIso };
			writeFileSync(this.markerPath, JSON.stringify(payload), "utf8");
		} catch (error) {
			console.warn("Failed to persist the screen prompt marker:", error);
		}
	}
}
