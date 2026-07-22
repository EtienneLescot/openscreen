# Hyprland Cursor Position Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Linux cursor-position telemetry so recordings on Hyprland show a tracked cursor instead of a frozen `(0, 0)`, by sourcing position from Hyprland's own IPC socket instead of Electron's broken `screen.getCursorScreenPoint()`.

**Architecture:** A new pure protocol module (`hyprlandCursorIpc.ts`, no Electron dependency, fully unit-testable) talks to Hyprland's Unix domain control socket. A new `CursorRecordingSession` implementation (`hyprlandCursorRecordingSession.ts`, matching the shape of the existing `TelemetryRecordingSession`) polls that protocol module on an interval and feeds the *existing* `provider: "none"` cursor-overlay pipeline — no editor/rendering changes needed. `factory.ts` picks this session over `TelemetryRecordingSession` only when `HYPRLAND_INSTANCE_SIGNATURE` is set.

**Tech Stack:** TypeScript, Node's built-in `net` module (Unix domain sockets), Vitest.

## Global Constraints

- No changes to `CursorRecordingSession`, `CursorRecordingData`, `CursorRecordingSample`, or any consumer of recording data (`electron/ipc/handlers.ts`, `src/lib/cursor/nativeCursor.ts`, the editor) — the spec requires the new session to produce the exact existing wire format.
- Non-Hyprland Linux compositors must keep using `TelemetryRecordingSession` unchanged — no regression risk for them.
- Socket/IPC failures must never throw out of the session or crash a recording — always degrade to a missed sample (reuse last known position) per the spec's Error Handling section.
- Sample cadence matches the existing `CURSOR_SAMPLE_INTERVAL_MS = 33` (~30Hz) used today in `electron/ipc/handlers.ts:400`.
- Spec source of truth: `docs/superpowers/specs/2026-07-22-hyprland-cursor-position-design.md`.

---

### Task 1: Hyprland IPC protocol module

**Files:**
- Create: `electron/native-bridge/cursor/recording/hyprlandCursorIpc.ts`
- Test: `electron/native-bridge/cursor/recording/hyprlandCursorIpc.test.ts`

**Interfaces:**
- Produces:
  - `resolveHyprlandSocketPath(): string | null` — reads `process.env.HYPRLAND_INSTANCE_SIGNATURE` and `process.env.XDG_RUNTIME_DIR`; returns `null` if either is unset, otherwise `path.join(runtimeDir, "hypr", signature, ".socket.sock")`.
  - `queryHyprlandCursorPos(socketPath: string): Promise<{ x: number; y: number } | null>` — connects to the given Unix socket, writes `"j/cursorpos"`, reads the response until the peer closes the connection, parses it as JSON, and resolves with `{ x, y }` on success or `null` on any failure (bad JSON, missing fields, connection error, 200ms timeout). Never rejects.

This module has **no Electron import** — it's plain Node (`node:net`, `node:path`), which is what makes it unit-testable under the project's Vitest/jsdom setup (Electron's `screen`/`app` modules can't be imported outside a running Electron process, which is why no other native-bridge cursor session has unit tests today — see `macNativeCursorRecordingSession.ts`, `windowsNativeRecordingSession.ts`, `telemetryRecordingSession.ts`).

- [ ] **Step 1: Write the failing tests**

Create `electron/native-bridge/cursor/recording/hyprlandCursorIpc.test.ts`:

```ts
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryHyprlandCursorPos, resolveHyprlandSocketPath } from "./hyprlandCursorIpc";

describe("resolveHyprlandSocketPath", () => {
	const originalSignature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
	const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;

	afterEach(() => {
		if (originalSignature === undefined) {
			delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
		} else {
			process.env.HYPRLAND_INSTANCE_SIGNATURE = originalSignature;
		}
		if (originalRuntimeDir === undefined) {
			delete process.env.XDG_RUNTIME_DIR;
		} else {
			process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
		}
	});

	it("returns null when HYPRLAND_INSTANCE_SIGNATURE is unset", () => {
		delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
		process.env.XDG_RUNTIME_DIR = "/run/user/1000";

		expect(resolveHyprlandSocketPath()).toBeNull();
	});

	it("returns null when XDG_RUNTIME_DIR is unset", () => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "abc123";
		delete process.env.XDG_RUNTIME_DIR;

		expect(resolveHyprlandSocketPath()).toBeNull();
	});

	it("joins the runtime dir, signature, and socket filename when both are set", () => {
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "abc123";
		process.env.XDG_RUNTIME_DIR = "/run/user/1000";

		expect(resolveHyprlandSocketPath()).toBe("/run/user/1000/hypr/abc123/.socket.sock");
	});
});

describe("queryHyprlandCursorPos", () => {
	const testDirs: string[] = [];
	const servers: net.Server[] = [];

	function createTestSocketPath() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-hypr-ipc-test-"));
		testDirs.push(dir);
		return path.join(dir, ".socket.sock");
	}

	function startFakeHyprlandServer(socketPath: string, respond: (command: string) => string) {
		const server = net.createServer((socket) => {
			socket.once("data", (chunk) => {
				socket.end(respond(chunk.toString("utf8")));
			});
		});
		server.listen(socketPath);
		servers.push(server);
		return new Promise<void>((resolve) => server.once("listening", () => resolve()));
	}

	afterEach(async () => {
		for (const server of servers.splice(0)) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		for (const dir of testDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves with the parsed position for a valid response", async () => {
		const socketPath = createTestSocketPath();
		await startFakeHyprlandServer(socketPath, () => JSON.stringify({ x: 960, y: 540 }));

		await expect(queryHyprlandCursorPos(socketPath)).resolves.toEqual({ x: 960, y: 540 });
	});

	it("sends the j/cursorpos command", async () => {
		const socketPath = createTestSocketPath();
		let receivedCommand = "";
		await startFakeHyprlandServer(socketPath, (command) => {
			receivedCommand = command;
			return JSON.stringify({ x: 0, y: 0 });
		});

		await queryHyprlandCursorPos(socketPath);

		expect(receivedCommand).toBe("j/cursorpos");
	});

	it("resolves with null for a malformed JSON response", async () => {
		const socketPath = createTestSocketPath();
		await startFakeHyprlandServer(socketPath, () => "not json");

		await expect(queryHyprlandCursorPos(socketPath)).resolves.toBeNull();
	});

	it("resolves with null for a response missing x/y fields", async () => {
		const socketPath = createTestSocketPath();
		await startFakeHyprlandServer(socketPath, () => JSON.stringify({ foo: "bar" }));

		await expect(queryHyprlandCursorPos(socketPath)).resolves.toBeNull();
	});

	it("resolves with null when the socket doesn't exist", async () => {
		const socketPath = createTestSocketPath();
		// Never started a server on this path.

		await expect(queryHyprlandCursorPos(socketPath)).resolves.toBeNull();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node_modules/.bin/vitest --run electron/native-bridge/cursor/recording/hyprlandCursorIpc.test.ts`
Expected: FAIL — `Cannot find module './hyprlandCursorIpc'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `electron/native-bridge/cursor/recording/hyprlandCursorIpc.ts`:

```ts
import net from "node:net";
import path from "node:path";

const SOCKET_TIMEOUT_MS = 200;

export function resolveHyprlandSocketPath(): string | null {
	const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (!signature || !runtimeDir) {
		return null;
	}
	return path.join(runtimeDir, "hypr", signature, ".socket.sock");
}

export function queryHyprlandCursorPos(
	socketPath: string,
): Promise<{ x: number; y: number } | null> {
	return new Promise((resolve) => {
		const socket = net.createConnection(socketPath);
		const chunks: Buffer[] = [];
		let settled = false;

		const finish = (value: { x: number; y: number } | null) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};

		socket.setTimeout(SOCKET_TIMEOUT_MS, () => finish(null));
		socket.on("error", () => finish(null));
		socket.on("connect", () => socket.write("j/cursorpos"));
		socket.on("data", (chunk) => chunks.push(chunk));
		socket.on("close", () => {
			if (settled) return;
			try {
				const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
					finish({ x: parsed.x, y: parsed.y });
					return;
				}
			} catch {
				// Falls through to finish(null) below.
			}
			finish(null);
		});
	});
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest --run electron/native-bridge/cursor/recording/hyprlandCursorIpc.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json && node_modules/.bin/biome check electron/native-bridge/cursor/recording/hyprlandCursorIpc.ts electron/native-bridge/cursor/recording/hyprlandCursorIpc.test.ts`
Expected: No errors from either command.

- [ ] **Step 6: Commit**

```bash
git add electron/native-bridge/cursor/recording/hyprlandCursorIpc.ts electron/native-bridge/cursor/recording/hyprlandCursorIpc.test.ts
git commit -m "feat(linux): add Hyprland IPC socket protocol module for cursor position"
```

---

### Task 2: Hyprland cursor recording session

**Files:**
- Create: `electron/native-bridge/cursor/recording/hyprlandCursorRecordingSession.ts`
- Reference (read-only, don't modify): `electron/native-bridge/cursor/recording/telemetryRecordingSession.ts` (this task mirrors its shape), `electron/native-bridge/cursor/recording/session.ts` (the `CursorRecordingSession` interface it implements)

**Interfaces:**
- Consumes: `resolveHyprlandSocketPath()` and `queryHyprlandCursorPos(socketPath: string): Promise<{x: number, y: number} | null>` from Task 1's `./hyprlandCursorIpc`.
- Produces: `HyprlandCursorRecordingSession` class implementing `CursorRecordingSession` (from `./session`), constructed with the same option shape as `TelemetryRecordingSession` (`getDisplayBounds: () => Rectangle | null`, `maxSamples: number`, `sampleIntervalMs: number`, `startTimeMs?: number`), plus an optional `socketPath?: string` override used only by tests. Consumed by Task 3's `factory.ts` change.

This class **does** import Electron's `screen` module (for the same `getDisplayNearestPoint` fallback `TelemetryRecordingSession` already uses), which is why — matching the existing convention for this family of session classes (none of `macNativeCursorRecordingSession.ts`, `windowsNativeRecordingSession.ts`, or `telemetryRecordingSession.ts` have unit tests, since Electron's modules can't be imported outside a running Electron process) — this task has no automated test. It's covered by the manual verification in Task 4.

- [ ] **Step 1: Write the implementation**

Create `electron/native-bridge/cursor/recording/hyprlandCursorRecordingSession.ts`:

```ts
import { type Rectangle, screen } from "electron";
import type { CursorRecordingData, CursorRecordingSample } from "../../../../src/native/contracts";
import { queryHyprlandCursorPos, resolveHyprlandSocketPath } from "./hyprlandCursorIpc";
import type { CursorRecordingSession } from "./session";

interface HyprlandCursorRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
	startTimeMs?: number;
	/** Overrides the resolved Hyprland socket path. Test-only. */
	socketPath?: string;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export class HyprlandCursorRecordingSession implements CursorRecordingSession {
	private samples: CursorRecordingSample[] = [];
	private interval: NodeJS.Timeout | null = null;
	private startTimeMs = 0;
	private isSampling = false;
	private lastPosition: { x: number; y: number } | null = null;
	private readonly socketPath: string | null;

	constructor(private readonly options: HyprlandCursorRecordingSessionOptions) {
		this.socketPath = options.socketPath ?? resolveHyprlandSocketPath();
	}

	async start(): Promise<void> {
		this.samples = [];
		this.lastPosition = null;
		this.startTimeMs = this.options.startTimeMs ?? Date.now();
		await this.captureSample();
		this.interval = setInterval(() => {
			void this.captureSample();
		}, this.options.sampleIntervalMs);
	}

	async stop(): Promise<CursorRecordingData> {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}

		return {
			version: 2,
			provider: "none",
			samples: this.samples,
			assets: [],
		};
	}

	private async captureSample() {
		if (this.isSampling || !this.socketPath) {
			return;
		}
		this.isSampling = true;
		try {
			const position = (await queryHyprlandCursorPos(this.socketPath)) ?? this.lastPosition;
			if (!position) {
				return;
			}
			this.lastPosition = position;

			const display =
				this.options.getDisplayBounds() ?? screen.getDisplayNearestPoint(position).bounds;
			const width = Math.max(1, display.width);
			const height = Math.max(1, display.height);

			this.samples.push({
				timeMs: Math.max(0, Date.now() - this.startTimeMs),
				cx: clamp((position.x - display.x) / width, 0, 1),
				cy: clamp((position.y - display.y) / height, 0, 1),
				visible: true,
			});

			if (this.samples.length > this.options.maxSamples) {
				this.samples.shift();
			}
		} finally {
			this.isSampling = false;
		}
	}
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json && node_modules/.bin/biome check electron/native-bridge/cursor/recording/hyprlandCursorRecordingSession.ts`
Expected: No errors from either command.

- [ ] **Step 3: Commit**

```bash
git add electron/native-bridge/cursor/recording/hyprlandCursorRecordingSession.ts
git commit -m "feat(linux): add Hyprland cursor recording session"
```

---

### Task 3: Wire into the session factory

**Files:**
- Modify: `electron/native-bridge/cursor/recording/factory.ts`

**Interfaces:**
- Consumes: `HyprlandCursorRecordingSession` from Task 2's `./hyprlandCursorRecordingSession`.

- [ ] **Step 1: Update the factory**

In `electron/native-bridge/cursor/recording/factory.ts`, add the import and replace the Linux fallback branch:

```ts
import type { Rectangle } from "electron";
import { HyprlandCursorRecordingSession } from "./hyprlandCursorRecordingSession";
import { MacNativeCursorRecordingSession } from "./macNativeCursorRecordingSession";
import type { CursorRecordingSession } from "./session";
import { TelemetryRecordingSession } from "./telemetryRecordingSession";
import { WindowsNativeRecordingSession } from "./windowsNativeRecordingSession";

interface CreateCursorRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	platform: NodeJS.Platform;
	sampleIntervalMs: number;
	sourceId?: string | null;
	startTimeMs?: number;
}

export function createCursorRecordingSession(
	options: CreateCursorRecordingSessionOptions,
): CursorRecordingSession {
	if (options.platform === "win32") {
		return new WindowsNativeRecordingSession({
			getDisplayBounds: options.getDisplayBounds,
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
			sourceId: options.sourceId,
			startTimeMs: options.startTimeMs,
		});
	}

	if (options.platform === "darwin") {
		return new MacNativeCursorRecordingSession({
			getDisplayBounds: options.getDisplayBounds,
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
			startTimeMs: options.startTimeMs,
		});
	}

	// Linux: capture cursor positions via an interval sampler. Hyprland's own IPC
	// socket gives an accurate position at any time (moving or static); Electron's
	// screen.getCursorScreenPoint() is known-broken (frozen at 0,0) there. Other
	// compositors don't have an equivalent IPC channel today, so they keep using
	// the Electron API.
	if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
		return new HyprlandCursorRecordingSession({
			getDisplayBounds: options.getDisplayBounds,
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
			startTimeMs: options.startTimeMs,
		});
	}

	return new TelemetryRecordingSession({
		getDisplayBounds: options.getDisplayBounds,
		maxSamples: options.maxSamples,
		sampleIntervalMs: options.sampleIntervalMs,
		startTimeMs: options.startTimeMs,
	});
}
```

- [ ] **Step 2: Typecheck, lint, and run the full test suite**

Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json && node_modules/.bin/biome check electron/native-bridge/cursor/recording/factory.ts && node_modules/.bin/vitest --run`
Expected: No typecheck/lint errors; full test suite passes (including the new tests from Task 1).

- [ ] **Step 3: Commit**

```bash
git add electron/native-bridge/cursor/recording/factory.ts
git commit -m "feat(linux): use Hyprland IPC for cursor telemetry when available"
```

---

### Task 4: Manual verification on Hyprland

**Files:** None — this task runs the app, no code changes.

- [ ] **Step 1: Build and run**

Run: `npm run dev`

- [ ] **Step 2: Record with movement and stillness**

In the running app, start a recording. Move the cursor around the screen, then deliberately hold it still in a couple of different spots for 2-3 seconds each (this is the exact case the old `screen.getCursorScreenPoint()` telemetry — and any frame-diffing-based approach — silently failed on). Stop the recording.

- [ ] **Step 3: Inspect the raw telemetry file**

Run: `cat ~/.config/openscreen/recordings/recording-<timestamp>.webm.cursor.json | python3 -c "import json,sys; d=json.load(sys.stdin); xs=set(s['cx'] for s in d['samples']); print('unique cx values:', len(xs)); print('sample:', d['samples'][:3])"`

Expected: `unique cx values` is greater than 1 (position genuinely varies — this is the exact check that proved the bug originally, where every sample had `cx: 0, cy: 0`), and the printed samples show plausible `cx`/`cy` values in the `[0, 1]` range.

- [ ] **Step 4: Confirm the overlay renders**

Open the recording in the OpenScreen editor. Confirm a generic cursor icon (SVG arrow from `src/assets/cursors/`) appears and visibly tracks where the mouse was during the recording, including staying parked correctly during the still periods (not disappearing or snapping to a wrong position).

- [ ] **Step 5: Confirm no regression on the audio path**

Repeat steps 2-4 once with "record system audio" enabled in the recorder UI, to confirm this change (cursor-telemetry only) hasn't affected the unrelated audio-capture path.
