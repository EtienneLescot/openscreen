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
