import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cast on `actual` is written out in the factory rather than shared in a
 * helper: `vi.mock` calls are HOISTED above every top-level statement, so a
 * module-scope helper is still in its temporal dead zone when the factory runs.
 */
type WithDefault = { default?: Record<string, unknown> };

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = vi.fn();
	return { ...actual, spawn, default: { ...((actual as WithDefault).default ?? {}), spawn } };
});

const mocks = vi.hoisted(() => ({
	isTrustedAccessibilityClient: vi.fn(() => true),
	// Shared rather than two separate vi.fn()s so a test can make every candidate path
	// unreadable and reach the missing-helper branch.
	accessSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	// No helper binary exists in a test checkout; by default pretend the first candidate
	// path is executable so path resolution is not what is under test.
	return {
		...actual,
		accessSync: mocks.accessSync,
		default: { ...((actual as WithDefault).default ?? {}), accessSync: mocks.accessSync },
	};
});

vi.mock("electron", () => ({
	systemPreferences: { isTrustedAccessibilityClient: mocks.isTrustedAccessibilityClient },
	screen: {
		getCursorScreenPoint: () => ({ x: 0, y: 0 }),
		getDisplayNearestPoint: () => ({ scaleFactor: 2 }),
	},
}));

import { spawn } from "node:child_process";
import {
	isMacCursorHelperUnavailable,
	requestMacCursorAccessibilityAccess,
} from "./macNativeCursorRecordingSession";

/** Minimal stand-in for the cursor helper: stdio pipes plus kill bookkeeping. */
class FakeHelper extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	killed = false;

	kill() {
		this.killed = true;
		return true;
	}

	/** Feeds one NDJSON line, the way the real helper emits them. */
	emitEvent(event: Record<string, unknown>) {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}
}

const spawnMock = vi.mocked(spawn);
let helper: FakeHelper;
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
	originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	helper = new FakeHelper();
	spawnMock.mockReset();
	spawnMock.mockReturnValue(helper as unknown as ReturnType<typeof spawn>);
	mocks.isTrustedAccessibilityClient.mockReset();
	mocks.isTrustedAccessibilityClient.mockReturnValue(true);
	mocks.accessSync.mockReset();
	const silence = () => {
		// The access probe logs every helper diagnostic; keep the test output readable.
	};
	vi.spyOn(console, "warn").mockImplementation(silence);
	vi.spyOn(console, "error").mockImplementation(silence);
});

afterEach(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
	vi.restoreAllMocks();
});

/** Lets the spawn listeners attach before the fake helper speaks. */
async function settle<T>(pending: Promise<T>, act: () => void): Promise<T> {
	await Promise.resolve();
	act();
	return pending;
}

describe("requestMacCursorAccessibilityAccess", () => {
	it("grants when the helper reports Accessibility trust", async () => {
		const access = await settle(requestMacCursorAccessibilityAccess(), () =>
			helper.emitEvent({ type: "ready", timestampMs: 1, accessibilityTrusted: true }),
		);

		expect(access).toMatchObject({ success: true, granted: true, status: "granted" });
	});

	it("reports a genuine denial when the helper ran and was told no", async () => {
		const access = await settle(requestMacCursorAccessibilityAccess(), () =>
			helper.emitEvent({ type: "ready", timestampMs: 1, accessibilityTrusted: false }),
		);

		expect(access).toMatchObject({ granted: false, status: "not-determined" });
		// The ONLY status that should ever raise the "grant Accessibility" dialog.
		expect(isMacCursorHelperUnavailable(access.status)).toBe(false);
	});

	/**
	 * The regression test for #515. On macOS 12 the helper was stamped with a macOS 13
	 * deployment target, so it died in the loader before printing its `ready` line — and
	 * the app answered by telling the user to grant a permission they already held.
	 * A helper that never got to ask must never be reported as a denial.
	 */
	it("does not call a helper that died before ready a denied permission", async () => {
		const access = await settle(requestMacCursorAccessibilityAccess(), () =>
			helper.emit("exit", null, "SIGABRT"),
		);

		expect(access.granted).toBe(false);
		expect(access.status).toBe("exited");
		// The app itself IS trusted — proof this is a broken build, not a missing grant.
		expect(access.accessibilityTrusted).toBe(true);
		expect(isMacCursorHelperUnavailable(access.status)).toBe(true);
	});

	it("distinguishes a helper that could not be spawned at all", async () => {
		const access = await settle(requestMacCursorAccessibilityAccess(), () =>
			helper.emit("error", new Error("spawn ENOENT")),
		);

		expect(access).toMatchObject({ granted: false, status: "error" });
		expect(isMacCursorHelperUnavailable(access.status)).toBe(true);
	});

	it("distinguishes a helper that hung without ever answering", async () => {
		vi.useFakeTimers();
		try {
			const pending = requestMacCursorAccessibilityAccess();
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(5_000);
			const access = await pending;

			expect(access).toMatchObject({ granted: false, status: "timeout" });
			expect(isMacCursorHelperUnavailable(access.status)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * The other half of #515's conflation, and the branch whose dialog used to tell the
	 * user to run a build script. No helper on disk is not a permission problem either.
	 */
	it("reports an absent helper as unavailable, not as a denial", async () => {
		mocks.accessSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		mocks.isTrustedAccessibilityClient.mockReturnValue(false);

		const access = await requestMacCursorAccessibilityAccess();

		expect(access).toMatchObject({ success: true, granted: false, status: "missing-helper" });
		expect(access.accessibilityTrusted).toBe(false);
		expect(isMacCursorHelperUnavailable(access.status)).toBe(true);
		// Nothing was spawned: there was nothing to spawn.
		expect(spawnMock).not.toHaveBeenCalled();
	});

	/**
	 * The probe must not raise the macOS Accessibility prompt. It runs before the helper
	 * is even located, so on every unavailable branch it would be asking for a grant that
	 * is not what is missing.
	 */
	it("reads Accessibility trust without prompting", async () => {
		await settle(requestMacCursorAccessibilityAccess(), () =>
			helper.emitEvent({ type: "ready", timestampMs: 1, accessibilityTrusted: true }),
		);

		expect(mocks.isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
		expect(mocks.isTrustedAccessibilityClient).not.toHaveBeenCalledWith(true);
	});

	it("keeps the app's own trust separate from the helper's fate", async () => {
		mocks.isTrustedAccessibilityClient.mockReturnValue(false);

		const access = await settle(requestMacCursorAccessibilityAccess(), () =>
			helper.emit("exit", 1, null),
		);

		expect(access.accessibilityTrusted).toBe(false);
		expect(access.status).toBe("exited");
	});
});
