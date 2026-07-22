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
