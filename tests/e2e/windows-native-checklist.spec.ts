import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";
import { NATIVE_BRIDGE_CHANNEL, NATIVE_BRIDGE_VERSION } from "../../src/native/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");

async function launchApp() {
	const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-e2e-"));
	const app = await electron.launch({
		args: [
			MAIN_JS,
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			"--lang=en-US",
			`--user-data-dir=${testUserDataDir}`,
		],
		env: {
			...process.env,
			ELECTRON_USER_DATA_DIR: testUserDataDir,
			HEADLESS: process.env["HEADLESS"] ?? "true",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			LANGUAGE: "en_US",
		},
	});

	const childProcess = app.process();
	childProcess.stdout?.on("data", (d) => process.stdout.write(`[electron] ${d}`));
	childProcess.stderr?.on("data", (d) => process.stderr.write(`[electron] ${d}`));
	(
		app as ElectronApplication & {
			__testUserDataDir?: string;
			__childProcess?: ReturnType<ElectronApplication["process"]>;
		}
	).__testUserDataDir = testUserDataDir;
	(
		app as ElectronApplication & {
			__testUserDataDir?: string;
			__childProcess?: ReturnType<ElectronApplication["process"]>;
		}
	).__childProcess = childProcess;

	return app;
}

async function closeApp(app: ElectronApplication) {
	const childProcess = (
		app as ElectronApplication & {
			__childProcess?: ReturnType<ElectronApplication["process"]>;
		}
	).__childProcess;
	await Promise.race([app.close(), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
	if (childProcess && childProcess.exitCode === null && childProcess.signalCode === null) {
		if (!childProcess.killed) {
			childProcess.kill();
		}
		await Promise.race([
			once(childProcess, "close"),
			new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
		]);
	}
	const testUserDataDir = (app as ElectronApplication & { __testUserDataDir?: string })
		.__testUserDataDir;
	if (testUserDataDir && fs.existsSync(testUserDataDir)) {
		fs.rmSync(testUserDataDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	}
}

async function copyFixtureToRecordings(app: ElectronApplication, fileName: string) {
	const userDataDir = await app.evaluate(({ app: electronApp }) => {
		return electronApp.getPath("userData");
	});
	const recordingsDir = path.join(userDataDir, "recordings");
	const targetPath = path.join(recordingsDir, fileName);
	fs.mkdirSync(recordingsDir, { recursive: true });
	fs.copyFileSync(TEST_VIDEO, targetPath);
	return targetPath;
}

async function dismissLanguagePrompt(page: Page) {
	const keepCurrentLanguage = page
		.getByRole("button")
		.filter({ hasText: /Keep current language|Conserver la langue actuelle/ });
	if ((await keepCurrentLanguage.count()) > 0) {
		await keepCurrentLanguage.click();
	}
}

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;

test.describe("Windows native checklist smoke tests", () => {
	test.skip(process.platform !== "win32", "Windows native capture is Windows-only.");

	test("source selector opens, lists thumbnails, and selects a screen/window source", async () => {
		const app = await launchApp();

		try {
			const hudWindow = await app.firstWindow({ timeout: 60_000 });
			await hudWindow.waitForLoadState("domcontentloaded");
			await dismissLanguagePrompt(hudWindow);

			await expect(hudWindow.getByTestId("launch-record-button")).toBeEnabled();
			await expect(hudWindow.getByTestId("launch-source-selector-button")).toBeVisible();
			await expect(hudWindow.getByTestId("launch-system-audio-button")).toBeEnabled();
			await expect(hudWindow.getByTestId("launch-microphone-button")).toBeEnabled();

			await hudWindow.getByTestId("launch-source-selector-button").click();
			const sourceWindow = await app.waitForEvent("window", {
				predicate: (w) => w.url().includes("windowType=source-selector"),
				timeout: 15_000,
			});
			await sourceWindow.waitForLoadState("domcontentloaded");

			const cards = sourceWindow.getByTestId("source-selector-card");
			await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(0);

			const thumbnails = await cards.locator("img").evaluateAll((imgs) =>
				imgs.map((img) => ({
					alt: img.getAttribute("alt"),
					src: img.getAttribute("src"),
				})),
			);
			expect(thumbnails.some((item) => item.alt && item.src?.startsWith("data:image"))).toBe(true);

			const hasScreen = await sourceWindow
				.locator('[data-testid="source-selector-card"][data-source-kind="screen"]')
				.count()
				.then((count) => count > 0);
			const hasWindow = await sourceWindow
				.locator('[data-testid="source-selector-card"][data-source-kind="window"]')
				.count()
				.then((count) => count > 0);
			expect(hasScreen || hasWindow).toBe(true);

			await expect(sourceWindow.getByTestId("source-selector-share-button")).toBeDisabled();
			await cards.first().click();
			await expect(sourceWindow.getByTestId("source-selector-share-button")).toBeEnabled();
			await sourceWindow.getByTestId("source-selector-share-button").click();

			await expect
				.poll(
					() =>
						hudWindow.evaluate(async () => {
							return await window.electronAPI.getSelectedSource();
						}),
					{ timeout: 10_000 },
				)
				.not.toBeNull();
			await expect(hudWindow.getByTestId("launch-record-button")).toBeEnabled();
		} finally {
			await closeApp(app);
		}
	});

	test("launch window opens an existing video into the editor and playback controls respond", async () => {
		const app = await launchApp();
		let testVideoInRecordings = "";

		try {
			const hudWindow = await app.firstWindow({ timeout: 60_000 });
			await hudWindow.waitForLoadState("domcontentloaded");
			await dismissLanguagePrompt(hudWindow);
			testVideoInRecordings = await copyFixtureToRecordings(app, "checklist-sample.webm");

			await app.evaluate(({ ipcMain }, videoPath) => {
				ipcMain.removeHandler("open-video-file-picker");
				ipcMain.handle("open-video-file-picker", () => ({
					success: true,
					path: videoPath,
				}));
			}, testVideoInRecordings);

			await hudWindow.getByTestId("launch-open-video-button").click();
			const editorWindow = await app.waitForEvent("window", {
				predicate: (w) => w.url().includes("windowType=editor"),
				timeout: 15_000,
			});
			await editorWindow.waitForLoadState("domcontentloaded");
			await expect(editorWindow.getByText("Loading video...")).not.toBeVisible({ timeout: 20_000 });

			const playButton = editorWindow.locator(
				'button[aria-label="Play"], button[aria-label="Lire"]',
			);
			await expect(playButton).toBeVisible({ timeout: 10_000 });
			await playButton.click();

			const seekInput = editorWindow.locator('input[type="range"]').first();
			await expect(seekInput).toBeVisible();
			await seekInput.evaluate((input) => {
				const range = input as HTMLInputElement;
				range.value = "0.25";
				range.dispatchEvent(new Event("input", { bubbles: true }));
				range.dispatchEvent(new Event("change", { bubbles: true }));
			});
			await expect.poll(() => seekInput.inputValue(), { timeout: 10_000 }).not.toBe("0");

			await expect(
				editorWindow.getByText("Background").or(editorWindow.getByText("Arrière-plan")),
			).toBeVisible();
			await expect(editorWindow.getByRole("button", { name: "Export", exact: true })).toBeVisible();
		} finally {
			await closeApp(app);
			if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
				fs.unlinkSync(testVideoInRecordings);
			}
		}
	});

	test("launch window opens an existing project into the editor", async () => {
		const app = await launchApp();
		let testVideoInRecordings = "";
		let projectPath = "";

		try {
			const hudWindow = await app.firstWindow({ timeout: 60_000 });
			await hudWindow.waitForLoadState("domcontentloaded");
			await dismissLanguagePrompt(hudWindow);
			testVideoInRecordings = await copyFixtureToRecordings(app, "checklist-project-sample.webm");
			projectPath = path.join(os.tmpdir(), `openscreen-checklist-${Date.now()}.openscreen`);
			const project = {
				version: 2,
				videoPath: testVideoInRecordings,
				editor: {},
			};
			fs.writeFileSync(projectPath, JSON.stringify(project), "utf-8");

			await app.evaluate(
				({ ipcMain }, payload) => {
					ipcMain.removeHandler(payload.nativeBridgeChannel);
					ipcMain.handle(payload.nativeBridgeChannel, (_event, request) => {
						const success = (data: unknown) => ({
							ok: true,
							data,
							meta: {
								version: payload.nativeBridgeVersion,
								requestId: request.requestId ?? "checklist-project-load",
								timestampMs: Date.now(),
							},
						});

						if (request.domain === "project" && request.action === "loadProjectFile") {
							return success({
								success: true,
								path: payload.projectPath,
								project: payload.project,
							});
						}
						if (request.domain === "project" && request.action === "loadCurrentProjectFile") {
							return success({ success: false, canceled: true });
						}
						if (request.domain === "project" && request.action === "getCurrentVideoPath") {
							return success({ success: true, path: payload.videoPath });
						}
						if (request.domain === "system" && request.action === "getPlatform") {
							return success("win32");
						}
						if (request.domain === "system" && request.action === "getAssetBasePath") {
							return success(null);
						}
						if (request.domain === "cursor" && request.action === "getRecordingData") {
							return success({ version: 2, provider: "none", samples: [], assets: [] });
						}
						if (request.domain === "cursor" && request.action === "getTelemetry") {
							return success([]);
						}

						return {
							ok: false,
							error: {
								code: "UNSUPPORTED_ACTION",
								message: `Unexpected native bridge request in test: ${request.domain}.${request.action}`,
								retryable: false,
							},
							meta: {
								version: payload.nativeBridgeVersion,
								requestId: request.requestId ?? "checklist-project-load",
								timestampMs: Date.now(),
							},
						};
					});
				},
				{
					projectPath,
					project,
					videoPath: testVideoInRecordings,
					nativeBridgeChannel: NATIVE_BRIDGE_CHANNEL,
					nativeBridgeVersion: NATIVE_BRIDGE_VERSION,
				},
			);

			await hudWindow.getByTestId("launch-open-project-button").click();
			const editorWindow = await app.waitForEvent("window", {
				predicate: (w) => w.url().includes("windowType=editor"),
				timeout: 15_000,
			});
			await editorWindow.waitForLoadState("domcontentloaded");
			await expect(editorWindow.getByText("Loading video...")).not.toBeVisible({ timeout: 20_000 });
			await expect(editorWindow.getByRole("button", { name: "Export", exact: true })).toBeVisible();
		} finally {
			await closeApp(app);
			if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
				fs.unlinkSync(testVideoInRecordings);
			}
			if (projectPath && fs.existsSync(projectPath)) {
				fs.unlinkSync(projectPath);
			}
		}
	});

	// The HUD must reach click-through by *asking* for it from the renderer, never
	// by being born that way. On Windows the `forward` option is a global
	// WH_MOUSE_LL hook, and it is the only route back out: a HUD that is already
	// input-transparent when the hook fails to install can never be clicked again,
	// which is what bricked the app in issue #266. Both halves matter — that nothing
	// asks during construction, and that the renderer still does after mount.
	test("the HUD asks for click-through instead of being born with it", async () => {
		const app = await launchApp();

		try {
			const hudWindow = await app.firstWindow({ timeout: 60_000 });
			await hudWindow.waitForLoadState("domcontentloaded");
			await dismissLanguagePrompt(hudWindow);

			// A second window keeps the window list non-empty while the HUD is torn
			// down below — emptying it fires window-all-closed, which quits the app.
			await hudWindow.getByTestId("launch-source-selector-button").click();
			await app.waitForEvent("window", {
				predicate: (w) => w.url().includes("windowType=source-selector"),
				timeout: 15_000,
			});

			// Recreate the HUD through the app's own path (second-instance →
			// showMainWindow → createHudOverlayWindow) with the native call taped.
			// Nothing awaits between the tape going on and the snapshot coming off,
			// so no IPC from the renderer can slip into it: what comes back is
			// construction, and construction only.
			const duringConstruction = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
				const tape: unknown[][] = [];
				const original = BrowserWindow.prototype.setIgnoreMouseEvents;
				globalThis.__hudTape = tape;
				globalThis.__hudSetIgnoreMouseEvents = original;
				BrowserWindow.prototype.setIgnoreMouseEvents = function patched(
					this: InstanceType<typeof BrowserWindow>,
					...args: Parameters<typeof original>
				) {
					tape.push(args);
					return original.apply(this, args);
				};

				BrowserWindow.getAllWindows()
					.find((w) => w.webContents.getURL().includes("windowType=hud-overlay"))
					?.destroy();
				electronApp.emit("second-instance");

				return tape.slice();
			});

			expect(duringConstruction).toEqual([]);

			// And the renderer does ask, once it has mounted.
			await expect
				.poll(() => app.evaluate(() => globalThis.__hudTape ?? []), { timeout: 20_000 })
				.toContainEqual([true, { forward: true }]);
		} finally {
			await app.evaluate(({ BrowserWindow }) => {
				const original = globalThis.__hudSetIgnoreMouseEvents;
				if (original) {
					BrowserWindow.prototype.setIgnoreMouseEvents = original;
				}
				globalThis.__hudTape = undefined;
				globalThis.__hudSetIgnoreMouseEvents = undefined;
			});
			await closeApp(app);
		}
	});
});

declare global {
	// Set inside the main process by the click-through test above, read back by a
	// second evaluate — the only way to observe calls that land between two of them.
	var __hudTape: unknown[][] | undefined;
	var __hudSetIgnoreMouseEvents:
		| ((ignore: boolean, options?: { forward?: boolean }) => void)
		| undefined;
}
