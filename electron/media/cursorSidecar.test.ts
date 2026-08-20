// ponytail: these tests exist because the readers moved out of an IPC handler,
// and the ONLY way to prove they still behave is to call them without one. That
// was the whole obstacle: the parsing was fine, it just could not be reached (or
// exercised) from anywhere but Electron.
//
// The case that matters most is the least dramatic one — a missing sidecar has
// to come back `found: false` and NOT throw. An exception here becomes, three
// layers up, an agent that cannot distinguish "this recording has no pointer
// data" from "something broke", which is the exact conflation D-TELEM is about.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readCursorRecordingFileAt,
	readCursorSidecar,
	readCursorTelemetryFile,
} from "./cursorSidecar";
import { whenRegistryIdle } from "./mediaLinksRegistry";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sidecar-"));
});

afterEach(async () => {
	// The registry fallback below starts a path-refresh write that the lookup
	// deliberately does not await, so it can still be queued when the test ends.
	// Removing the tree underneath it made `fs.rm` fail with ENOTEMPTY — the write
	// recreating an entry between rm's recursive walk and its final rmdir — which
	// failed this hook, intermittently, only in the full parallel suite.
	await whenRegistryIdle();
	await fs.rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function writeSidecar(videoPath: string, payload: unknown): Promise<void> {
	await fs.writeFile(`${videoPath}.cursor.json`, JSON.stringify(payload), "utf-8");
}

describe("readCursorSidecar", () => {
	it("reads the sidecar next to the recording", async () => {
		const video = path.join(dir, "rec.mp4");
		await writeSidecar(video, {
			version: 2,
			provider: "native",
			samples: [
				{ timeMs: 100, cx: 0.5, cy: 0.5, interactionType: "move" },
				{ timeMs: 0, cx: 0.1, cy: 0.2, interactionType: "click" },
			],
			assets: [],
		});

		const result = await readCursorSidecar(video, {});

		expect(result.found).toBe(true);
		expect(result.source).toBe("sidecar");
		expect(result.path).toBe(`${video}.cursor.json`);
		// Sorted by time, and the interaction type survives — the digest counts
		// clicks off it, and the renderer's own projection throws it away.
		expect(result.data.samples.map((s) => s.timeMs)).toEqual([0, 100]);
		expect(result.data.samples[0].interactionType).toBe("click");
	});

	it("reports found:false — not an error — when there is no sidecar", async () => {
		const result = await readCursorSidecar(path.join(dir, "absent.mp4"), {});

		expect(result.found).toBe(false);
		expect(result.source).toBe("none");
		expect(result.path).toBeNull();
		expect(result.data.samples).toEqual([]);
		expect(result.data.provider).toBe("none");
	});

	it("survives a malformed sidecar instead of throwing", async () => {
		const video = path.join(dir, "broken.mp4");
		await fs.writeFile(`${video}.cursor.json`, "{ this is not json", "utf-8");
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await readCursorSidecar(video, {});

		// A file we cannot parse is a file we could not read: `found:false`, so
		// the caller reports "unavailable" rather than inventing an absence.
		expect(result.found).toBe(false);
		expect(result.data.samples).toEqual([]);
	});

	it("falls back to the fingerprint registry when the file has moved", async () => {
		// The sidecar convention only holds while the video stays where it was
		// recorded; P4's registry is the second chance, and it has to still be
		// wired after the extraction.
		const { registerMediaLinks } = await import("./mediaLinksRegistry");
		const recordingsDir = path.join(dir, "recordings");
		await fs.mkdir(recordingsDir, { recursive: true });

		const original = path.join(recordingsDir, "original.mp4");
		await fs.writeFile(original, "video-bytes-for-fingerprinting", "utf-8");
		const telemetryPath = path.join(recordingsDir, "original.mp4.cursor.json");
		await fs.writeFile(
			telemetryPath,
			JSON.stringify({
				version: 2,
				provider: "native",
				samples: [{ timeMs: 5, cx: 0.4, cy: 0.4 }],
			}),
			"utf-8",
		);
		await registerMediaLinks(recordingsDir, original, { cursorTelemetryPath: telemetryPath });

		// Same bytes, different name and no sidecar beside it.
		const moved = path.join(dir, "moved.mp4");
		await fs.copyFile(original, moved);

		const result = await readCursorSidecar(moved, { recordingsDir });

		expect(result.source).toBe("registry");
		expect(result.data.samples).toHaveLength(1);
	});

	it("does not consult the registry when no recordingsDir is injected", async () => {
		// The point of the extraction: `RECORDINGS_DIR` is an `app.getPath` call,
		// so a reader without one must degrade rather than reach for Electron.
		const result = await readCursorSidecar(path.join(dir, "nope.mp4"), {});
		expect(result.source).toBe("none");
	});
});

describe("readCursorRecordingFileAt", () => {
	it("accepts a bare array of samples as well as the versioned envelope", async () => {
		const file = path.join(dir, "bare.cursor.json");
		await fs.writeFile(file, JSON.stringify([{ timeMs: 1, cx: 0.2, cy: 0.3 }]), "utf-8");

		const data = await readCursorRecordingFileAt(file);

		expect(data.samples).toHaveLength(1);
		expect(data.samples[0].interactionType).toBe("move");
	});
});

describe("readCursorTelemetryFile", () => {
	it("drops interactionType — which is why the digest does not use it", async () => {
		const video = path.join(dir, "clicks.mp4");
		await writeSidecar(video, {
			samples: [{ timeMs: 10, cx: 0.5, cy: 0.5, interactionType: "click" }],
		});

		const result = await readCursorTelemetryFile(video, {});

		expect(result.success).toBe(true);
		expect(result.samples).toEqual([{ timeMs: 10, cx: 0.5, cy: 0.5 }]);
		// Locked deliberately: this projection is fine for the timeline overlay it
		// feeds and useless for "where did the user act". Anything that wants
		// clicks must go through `readCursorSidecar`, and this assertion is the
		// reminder of why.
		expect(Object.keys(result.samples[0])).not.toContain("interactionType");
	});
});
