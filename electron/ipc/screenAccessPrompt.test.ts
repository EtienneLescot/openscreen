import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resolveScreenAccessStatus,
	ScreenPromptMarker,
	shouldRaiseScreenPrompt,
} from "./screenAccessPrompt";

describe("resolveScreenAccessStatus", () => {
	it("reports what the fresh probe read, not the app's cached status", () => {
		// The regression this guards: the app's own read is frozen at whatever it saw
		// first, so a grant made while the app is running is invisible to it.
		expect(resolveScreenAccessStatus({ granted: true, status: "granted" }, "denied")).toBe(
			"granted",
		);
		expect(resolveScreenAccessStatus({ granted: false, status: "denied" }, "granted")).toBe(
			"denied",
		);
	});

	it("falls back to the app's status when the probe could not answer", () => {
		// A build without the helper, or a helper that crashed, must land on the old
		// behaviour rather than accusing the user of refusing the permission.
		for (const status of ["missing-helper", "error", "exited", "timeout"] as const) {
			expect(resolveScreenAccessStatus({ granted: false, status }, "restricted")).toBe(
				"restricted",
			);
		}
	});
});

describe("shouldRaiseScreenPrompt", () => {
	it("raises the prompt on the first ask, even though macOS reports denied", () => {
		// The bug: macOS collapses "never asked" into "denied", so a first run skipped
		// the prompt entirely and offered only a manual toggle in System Settings.
		expect(
			shouldRaiseScreenPrompt({ status: "denied", raisedThisLaunch: false, raisedBefore: false }),
		).toBe(true);
	});

	it("never prompts once the permission is held", () => {
		expect(
			shouldRaiseScreenPrompt({ status: "granted", raisedThisLaunch: false, raisedBefore: false }),
		).toBe(false);
	});

	it("does not re-prompt within a launch", () => {
		expect(
			shouldRaiseScreenPrompt({ status: "denied", raisedThisLaunch: true, raisedBefore: false }),
		).toBe(false);
	});

	it("does not prompt a user who has already been asked on this machine", () => {
		// macOS shows the prompt once per TCC decision and ignores every later request.
		// Asking again would cost a refusing user the Settings dialog -- the one message
		// they can act on -- in exchange for a prompt that never appears.
		expect(
			shouldRaiseScreenPrompt({ status: "denied", raisedThisLaunch: false, raisedBefore: true }),
		).toBe(false);
	});

	it("leaves a policy-restricted Mac on its actionable message", () => {
		// The cell that a status-blind "anything but granted" rule gets wrong: an MDM
		// machine can never grant the permission, so a prompt cannot appear and the wait
		// for one costs the user the only message that explains the refusal.
		expect(
			shouldRaiseScreenPrompt({
				status: "restricted",
				raisedThisLaunch: false,
				raisedBefore: false,
			}),
		).toBe(false);
		expect(
			shouldRaiseScreenPrompt({ status: "unknown", raisedThisLaunch: false, raisedBefore: false }),
		).toBe(false);
	});

	it("still prompts on not-determined, for a platform that can report it", () => {
		expect(
			shouldRaiseScreenPrompt({
				status: "not-determined",
				raisedThisLaunch: false,
				raisedBefore: false,
			}),
		).toBe(true);
	});
});

describe("ScreenPromptMarker", () => {
	let userData: string;

	beforeEach(() => {
		userData = mkdtempSync(path.join(tmpdir(), "openscreen-screen-access-"));
	});

	afterEach(() => {
		rmSync(userData, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("starts unmarked on a machine that has never been asked", () => {
		expect(new ScreenPromptMarker(userData).hasRaisedBefore()).toBe(false);
	});

	it("remembers across launches that the prompt was raised", () => {
		new ScreenPromptMarker(userData).recordRaised("2026-08-31T00:00:00.000Z");

		expect(new ScreenPromptMarker(userData).hasRaisedBefore()).toBe(true);
	});

	it("treats an unreadable or malformed marker as never asked", () => {
		writeFileSync(path.join(userData, "screen-access.json"), "{ not json", "utf8");

		expect(new ScreenPromptMarker(userData).hasRaisedBefore()).toBe(false);
	});

	it("still gets the rest of the launch right when the marker cannot be written", () => {
		// An unwritable userData directory must not stop the prompt the user is waiting on.
		const marker = new ScreenPromptMarker(path.join(userData, "does", "not", "exist"));
		vi.spyOn(console, "warn").mockImplementation(() => {
			// The failed write logs; keep the test output readable.
		});

		expect(() => marker.recordRaised("2026-08-31T00:00:00.000Z")).not.toThrow();
		expect(marker.hasRaisedBefore()).toBe(true);
	});
});
