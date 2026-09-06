import { describe, expect, it, vi } from "vitest";
import { openSourceSelectorWithPermissionRetry } from "./openSourceSelectorFlow";

/** What the main process returns when it has just raised macOS' prompt. */
const promptRaised = {
	opened: false,
	reason: "screen-access-required",
	access: { success: true, granted: false, status: "denied", promptRaised: true },
} as const;

describe("openSourceSelectorWithPermissionRetry", () => {
	it("returns immediately when the source selector opens on the first attempt", async () => {
		const openSourceSelector = vi.fn().mockResolvedValue({ opened: true });
		const requestScreenAccess = vi.fn();

		const result = await openSourceSelectorWithPermissionRetry({
			openSourceSelector,
			requestScreenAccess,
			wait: vi.fn(),
		});

		expect(result).toEqual({ opened: true });
		expect(openSourceSelector).toHaveBeenCalledTimes(1);
		expect(requestScreenAccess).not.toHaveBeenCalled();
	});

	it("does not wait when no prompt was raised, so the dialog is not delayed", async () => {
		// A user who refused on an earlier launch: macOS will not show them the prompt
		// again, so there is nothing to wait for and the Settings dialog has already been
		// shown by the main process.
		const openSourceSelector = vi.fn().mockResolvedValue({
			opened: false,
			reason: "screen-access-required",
			access: { success: true, granted: false, status: "denied", promptRaised: false },
		});
		const requestScreenAccess = vi.fn();

		const result = await openSourceSelectorWithPermissionRetry({
			openSourceSelector,
			requestScreenAccess,
			wait: vi.fn(),
		});

		expect(result.opened).toBe(false);
		expect(requestScreenAccess).not.toHaveBeenCalled();
		expect(openSourceSelector).toHaveBeenCalledTimes(1);
	});

	it("reopens the selector once the permission is granted while waiting", async () => {
		// Reachable only because the main process reads the permission from a fresh
		// process. Through its own cached status it could never observe the grant.
		const openSourceSelector = vi
			.fn()
			.mockResolvedValueOnce(promptRaised)
			.mockResolvedValueOnce({ opened: true });
		const requestScreenAccess = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				granted: false,
				status: "denied",
				promptRaised: true,
			})
			.mockResolvedValueOnce({
				success: true,
				granted: true,
				status: "granted",
				promptRaised: true,
			});
		const wait = vi.fn().mockResolvedValue(undefined);

		const result = await openSourceSelectorWithPermissionRetry({
			openSourceSelector,
			requestScreenAccess,
			wait,
			maxAttempts: 4,
		});

		expect(result).toEqual({ opened: true });
		expect(wait).toHaveBeenCalledTimes(2);
		expect(openSourceSelector).toHaveBeenLastCalledWith();
	});

	it("asks the main process for its dialog once the wait is spent", async () => {
		// The regression this guards: running the budget out used to return a synthesized
		// result that LaunchWindow discards, so a user who refused got six seconds of
		// nothing followed by nothing at all.
		const denied = { success: true, granted: false, status: "denied", promptRaised: true };
		const openSourceSelector = vi.fn().mockResolvedValue(promptRaised);
		const requestScreenAccess = vi.fn().mockResolvedValue(denied);

		await openSourceSelectorWithPermissionRetry({
			openSourceSelector,
			requestScreenAccess,
			wait: vi.fn().mockResolvedValue(undefined),
			maxAttempts: 3,
		});

		expect(requestScreenAccess).toHaveBeenCalledTimes(3);
		expect(openSourceSelector).toHaveBeenCalledTimes(2);
		expect(openSourceSelector).toHaveBeenLastCalledWith({ screenPromptWaitElapsed: true });
	});

	it("stops waiting immediately on a status no prompt can resolve", async () => {
		// An MDM-managed Mac cannot grant the permission at all. Waiting it out would cost
		// the user the one message that explains why.
		const openSourceSelector = vi.fn().mockResolvedValue(promptRaised);
		const requestScreenAccess = vi.fn().mockResolvedValue({
			success: true,
			granted: false,
			status: "restricted",
			promptRaised: true,
		});

		await openSourceSelectorWithPermissionRetry({
			openSourceSelector,
			requestScreenAccess,
			wait: vi.fn().mockResolvedValue(undefined),
			maxAttempts: 8,
		});

		expect(requestScreenAccess).toHaveBeenCalledTimes(1);
		expect(openSourceSelector).toHaveBeenLastCalledWith({ screenPromptWaitElapsed: true });
	});
});
