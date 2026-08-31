import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cast on `actual` is written out in each factory rather than shared in a helper:
 * `vi.mock` calls are HOISTED above every top-level statement, so a module-scope helper
 * is still in its temporal dead zone when the factory runs.
 */
type WithDefault = { default?: Record<string, unknown> };

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = vi.fn();
	return { ...actual, spawn, default: { ...((actual as WithDefault).default ?? {}), spawn } };
});

const mocks = vi.hoisted(() => ({ accessSync: vi.fn() }));

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

import { spawn } from "node:child_process";
import { isMacScreenProbeUnavailable, readMacScreenCaptureAccess } from "./macScreenAccess";

/** Minimal stand-in for the helper: stdio pipes plus kill bookkeeping. */
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
	mocks.accessSync.mockReset();
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

describe("readMacScreenCaptureAccess", () => {
	it("grants when the helper reports the permission", async () => {
		const access = await settle(readMacScreenCaptureAccess(), () =>
			helper.emitEvent({ event: "screen-access", granted: true }),
		);

		expect(access).toMatchObject({ success: true, granted: true, status: "granted" });
	});

	it("denies when the helper reports the permission is absent", async () => {
		const access = await settle(readMacScreenCaptureAccess(), () =>
			helper.emitEvent({ event: "screen-access", granted: false }),
		);

		expect(access).toMatchObject({ success: true, granted: false, status: "denied" });
	});

	it("spawns the probe flag and never a recording request", async () => {
		await settle(readMacScreenCaptureAccess(), () =>
			helper.emitEvent({ event: "screen-access", granted: true }),
		);

		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(spawnMock.mock.calls[0]?.[1]).toEqual(["--screen-access-status"]);
	});

	it("reads a fresh answer per call, which is the point of the child process", async () => {
		// The main process cannot do this: CGPreflightScreenCaptureAccess caches its
		// result for the life of the caller, so a grant made while the app runs is
		// invisible to it. Every call here is a new process, so the second read sees
		// the grant the first one missed.
		const first = await settle(readMacScreenCaptureAccess(), () =>
			helper.emitEvent({ event: "screen-access", granted: false }),
		);
		helper = new FakeHelper();
		spawnMock.mockReturnValue(helper as unknown as ReturnType<typeof spawn>);
		const second = await settle(readMacScreenCaptureAccess(), () =>
			helper.emitEvent({ event: "screen-access", granted: true }),
		);

		expect(first.granted).toBe(false);
		expect(second.granted).toBe(true);
		expect(spawnMock).toHaveBeenCalledTimes(2);
	});

	it("reports missing-helper rather than a refusal when no binary is installed", async () => {
		mocks.accessSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const access = await readMacScreenCaptureAccess();

		expect(access).toMatchObject({ granted: false, status: "missing-helper" });
		expect(isMacScreenProbeUnavailable(access.status)).toBe(true);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("reads the answer even when the helper dies in the same tick", async () => {
		// The helper prints one line and exits immediately, so the process-death event can
		// land before stdout has been drained. Racing it away would report a good answer
		// as a dead helper on a machine that is merely fast.
		const access = await settle(readMacScreenCaptureAccess(), () => {
			helper.emitEvent({ event: "screen-access", granted: true });
			helper.emit("close", 0, null);
		});

		expect(access).toMatchObject({ granted: true, status: "granted" });
	});

	it("reports exited rather than a refusal when an older helper rejects the flag", async () => {
		// A build predating the probe mode answers `invalidArguments` and exits 1.
		// Calling that a denial would tell a user with a working grant to go and
		// re-grant it.
		const access = await settle(readMacScreenCaptureAccess(), () => helper.emit("close", 1, null));

		expect(access).toMatchObject({ granted: false, status: "exited" });
		expect(isMacScreenProbeUnavailable(access.status)).toBe(true);
	});

	it("reports error when the helper cannot be launched at all", async () => {
		const access = await settle(readMacScreenCaptureAccess(), () =>
			helper.emit("error", new Error("EACCES")),
		);

		expect(access).toMatchObject({ granted: false, status: "error", error: "EACCES" });
		expect(isMacScreenProbeUnavailable(access.status)).toBe(true);
	});

	it("answers granted off-darwin without spawning anything", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });

		const access = await readMacScreenCaptureAccess();

		expect(access).toMatchObject({ granted: true, status: "granted" });
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
