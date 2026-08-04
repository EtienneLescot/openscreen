import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;

async function launchApp(userDataDir: string, tmpDir: string) {
	const app = await electron.launch({
		args: [
			MAIN_JS,
			// Required in CI sandbox environments (GitHub Actions, Docker, etc.)
			"--no-sandbox",
			// Force software WebGL in headless CI to avoid GPU framebuffer errors.
			"--enable-unsafe-swiftshader",
			// The selectors below are the English accessible names, so pin the locale.
			"--lang=en-US",
			`--user-data-dir=${userDataDir}`,
		],
		env: {
			...process.env,
			ELECTRON_USER_DATA_DIR: userDataDir,
			// Keep this run's scratch files out of the shared temp dir so a dev instance
			// cannot collide with them. The single-instance lock keys on userData, which
			// `--user-data-dir` above already makes private to this launch.
			TMPDIR: tmpDir,
			TMP: tmpDir,
			TEMP: tmpDir,
			// Set HEADLESS=false to show windows while debugging.
			HEADLESS: process.env["HEADLESS"] ?? "true",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			LANGUAGE: "en_US",
		},
	});

	app.process().stdout?.on("data", (d) => process.stdout.write(`[electron] ${d}`));
	app.process().stderr?.on("data", (d) => process.stderr.write(`[electron] ${d}`));
	return app;
}

async function closeApp(app: ElectronApplication) {
	const childProcess = app.process();
	await Promise.race([app.close(), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
	if (childProcess.exitCode === null && childProcess.signalCode === null) {
		if (!childProcess.killed) {
			childProcess.kill("SIGKILL");
		}
		await Promise.race([
			once(childProcess, "close"),
			new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
		]);
	}
}

/**
 * Drives the v4 editor's Export dialog end to end and returns the bytes it wrote.
 *
 * The native save dialog can't be driven from Playwright, so `pick-export-save-path`
 * is stubbed in the main process to return a temp path. Everything after that is the
 * real pipeline: the dialog hands that path straight to the native exporter
 * (`exportMultiNative` / `exportGifNative`), which writes the file itself — there is
 * no `write-export-to-path` round-trip through the renderer any more, so the test
 * reads the finished file off disk instead of intercepting a buffer.
 */
async function exportFromLoadedVideo(format: "gif" | "mp4"): Promise<Buffer> {
	const outputPath = path.join(os.tmpdir(), `test-${format}-export-${Date.now()}.${format}`);
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-e2e-export-"));
	const appTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-e2e-tmp-"));
	const app = await launchApp(userDataDir, appTmpDir);

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		await app.evaluate(({ ipcMain }, targetPath: string) => {
			ipcMain.removeHandler("pick-export-save-path");
			ipcMain.handle("pick-export-save-path", () => ({
				success: true,
				path: targetPath,
				canceled: false,
			}));
		}, outputPath);

		const recordingsDir = path.join(
			await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData")),
			"recordings",
		);
		const testVideoInRecordings = path.join(recordingsDir, "test-sample.webm");
		fs.mkdirSync(recordingsDir, { recursive: true });
		fs.copyFileSync(TEST_VIDEO, testVideoInRecordings);

		await hudWindow.evaluate(
			(videoPath: string) => window.electronAPI.setCurrentVideoPath(videoPath),
			testVideoInRecordings,
		);
		try {
			await hudWindow.evaluate(() => window.electronAPI.switchToEditor());
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/closed|destroyed|target page|target closed/i.test(error.message)
			) {
				throw error;
			}
		}

		const editorWindow = await app.waitForEvent("window", {
			predicate: (w) => w.url().includes("windowType=editor"),
			timeout: 15_000,
		});

		// WebCodecs may not be registered in the renderer on first load.
		await editorWindow.reload();
		await editorWindow.waitForLoadState("domcontentloaded");

		// Top bar: the Export control is disabled until the seeded recording has been
		// imported into the project, so waiting for it to be enabled doubles as the
		// "editor finished loading" gate. `exact` keeps it off the dialog's own
		// "Export MP4" / "Export GIF" button.
		const openExport = editorWindow.getByRole("button", { name: "Export", exact: true });
		await expect(openExport).toBeEnabled({ timeout: 30_000 });
		await openExport.click();

		const dialog = editorWindow.getByRole("dialog");
		await expect(dialog.getByRole("heading", { name: "Export" })).toBeVisible();

		await dialog
			.getByRole("button", { name: format === "gif" ? "GIF" : "MP4", exact: true })
			.click();

		const startExport = dialog.getByRole("button", {
			name: format === "gif" ? "Export GIF" : "Export MP4",
			exact: true,
		});
		await expect(startExport).toBeEnabled();
		await startExport.click();

		// The dialog swaps the placeholder for a progress block while the native
		// exporter runs and finally reports the path it wrote to.
		await expect(dialog.getByText("Saved to")).toBeVisible({ timeout: 85_000 });
		await expect(dialog.getByText(outputPath)).toBeVisible();

		expect(fs.existsSync(outputPath), `${format.toUpperCase()} not found at ${outputPath}`).toBe(
			true,
		);
		expect(fs.statSync(outputPath).size).toBeGreaterThan(1024);
		return fs.readFileSync(outputPath);
	} finally {
		await closeApp(app);
		if (fs.existsSync(outputPath)) {
			fs.unlinkSync(outputPath);
		}
		for (const dir of [userDataDir, appTmpDir]) {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}
}

test("exports an MP4 from a loaded video", async () => {
	const exported = await exportFromLoadedVideo("mp4");

	expect(exported.subarray(4, 8).toString("ascii")).toBe("ftyp");
});

test("exports a GIF from a loaded video", async () => {
	const exported = await exportFromLoadedVideo("gif");

	expect(exported.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a/);
});
