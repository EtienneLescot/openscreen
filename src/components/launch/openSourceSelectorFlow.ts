export type ScreenAccessResult = {
	success: boolean;
	granted: boolean;
	/** What the OS actually said. Never bent to steer this loop. */
	status: string;
	/**
	 * macOS' own prompt was raised by this very call and may still be unanswered.
	 *
	 * This, and not `status`, is what arms the wait below. macOS reports the permission
	 * as absent for the whole time its prompt is on screen -- it only flips once the user
	 * accepts -- so a loop keyed on the status would abort on its first poll, every time.
	 */
	promptRaised?: boolean;
	/** Granted, but the main process cannot use it until the app is relaunched. */
	requiresRelaunch?: boolean;
	error?: string;
};

export type OpenSourceSelectorResult = {
	opened: boolean;
	reason?: string;
	access?: ScreenAccessResult;
};

export type OpenSourceSelectorOptions = {
	/** Tells the main process this loop has stopped waiting on macOS' prompt. */
	screenPromptWaitElapsed?: boolean;
};

type OpenSourceSelectorFlowOptions = {
	openSourceSelector: (options?: OpenSourceSelectorOptions) => Promise<OpenSourceSelectorResult>;
	requestScreenAccess: () => Promise<ScreenAccessResult>;
	wait?: (ms: number) => Promise<void>;
	retryDelayMs?: number;
	maxAttempts?: number;
};

const defaultWait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Whether macOS' Screen Recording prompt is up and worth waiting on.
 *
 * The main process holds its "permission is required" dialog back for exactly as long as
 * this is true, because opening System Settings over the native prompt is the bug the
 * whole path exists to fix. Which makes this loop the owner of that wait -- and the only
 * side that can say when it is over.
 */
function shouldWaitForPermissionPrompt(result: OpenSourceSelectorResult): boolean {
	return (
		result.opened === false &&
		result.reason === "screen-access-required" &&
		result.access?.promptRaised === true
	);
}

/**
 * True for a status no prompt can resolve -- policy-restricted by an MDM profile, or a
 * permission read that failed outright. Waiting those out costs the user the message that
 * explains the refusal and buys nothing: no answer is coming.
 */
function isUnanswerableStatus(status: string): boolean {
	return status !== "denied" && status !== "not-determined";
}

export async function openSourceSelectorWithPermissionRetry({
	openSourceSelector,
	requestScreenAccess,
	wait = defaultWait,
	retryDelayMs = 750,
	maxAttempts = 8,
}: OpenSourceSelectorFlowOptions): Promise<OpenSourceSelectorResult> {
	const initialResult = await openSourceSelector();
	if (!shouldWaitForPermissionPrompt(initialResult)) {
		return initialResult;
	}

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		await wait(retryDelayMs);
		const access = await requestScreenAccess();

		// Reachable now: the main process reads the permission from a fresh process, so a
		// grant made while the app is running is visible to it. Read through the app's own
		// cached status -- as this loop used to be -- this branch could never be taken.
		if (access.granted) {
			return openSourceSelector();
		}

		if (isUnanswerableStatus(access.status)) {
			return openSourceSelector({ screenPromptWaitElapsed: true });
		}
	}

	// The budget is spent, so the prompt has been answered, dismissed, or was never shown.
	// Going back through the main process -- rather than synthesizing a result here, which
	// LaunchWindow discards -- is what puts the "permission is required" dialog in front of
	// a user who refused. Without this, running the wait out ended in silence.
	return openSourceSelector({ screenPromptWaitElapsed: true });
}
