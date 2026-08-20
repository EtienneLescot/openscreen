import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");

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

	// The HUD must reach click-through by *asking* for it from the renderer, never
	// by being born that way: a window born input-transparent whose renderer never
	// mounts can never be clicked again, which is what bricked the app in issue #266.
	// Both halves matter — that nothing asks during construction, and that the
	// renderer still does after mount.
	//
	// The tape assertions also pin `forward` OFF. It used to be the only route back
	// out of click-through, via a global WH_MOUSE_LL hook that Windows can refuse or
	// silently revoke — which is how #385 reproduced a dead HUD on a build that already
	// carried the #266 fix. The way out is now the "hud-overlay-cursor" poll in
	// electron/windows.ts, and asking for `forward` again would restore the dependency
	// without restoring the need.
	//
	// Note what this test therefore cannot do, and what no test in this file can.
	// Only a real OS cursor move drives a WH_MOUSE_LL hook; CDP-injected input
	// arrives below the OS hit-test, so Playwright's own `.click()` on a HUD testid
	// — as in the source-selector test above — reaches the DOM handler whether or
	// not click-through is installed, or even working. Those
	// clicks assert renderer wiring and nothing else. The failure #266 actually shipped
	// (a painted, permanently inert HUD) is invisible to injected input by construction,
	// so it belongs on the manual computer-use checklist and cannot be regression-tested
	// here. Do not read a green run as evidence that the HUD is clickable.
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
				const tape: Array<{ hud: boolean; args: unknown[] }> = [];
				const original = BrowserWindow.prototype.setIgnoreMouseEvents;
				globalThis.__hudTape = tape;
				globalThis.__hudSetIgnoreMouseEvents = original;
				BrowserWindow.prototype.setIgnoreMouseEvents = function patched(
					this: InstanceType<typeof BrowserWindow>,
					...args: Parameters<typeof original>
				) {
					// The patch is on the prototype, so every window's calls land here.
					// Tag them: an unfiltered tape would let another overlay's options
					// object fail the `forward` claim under this test's name, and let its
					// bare [true] satisfy the first-ask claim. Tag rather than filter,
					// because loadURL runs after this handler is installed — during
					// construction the URL is still "", and that is exactly the window
					// the empty-tape assertion below has to be able to see.
					tape.push({
						hud: this.isDestroyed()
							? false
							: this.webContents.getURL().includes("windowType=hud-overlay"),
						args,
					});
					return original.apply(this, args);
				};

				BrowserWindow.getAllWindows()
					.find((w) => w.webContents.getURL().includes("windowType=hud-overlay"))
					?.destroy();
				electronApp.emit("second-instance");

				return tape.slice();
			});

			expect(duringConstruction).toEqual([]);

			// And the renderer does ask, once it has mounted. Keep the snapshot the
			// poll settled on rather than fetching a second time, so all three claims
			// below are made about one state of the tape and not three.
			let hudCalls: unknown[][] = [];
			await expect
				.poll(
					async () => {
						hudCalls = await app.evaluate(() =>
							(globalThis.__hudTape ?? []).filter((entry) => entry.hud).map((entry) => entry.args),
						);
						return hudCalls;
					},
					{ timeout: 20_000 },
				)
				.toContainEqual([true]);

			// Containment is not enough by itself: a second caller asking with
			// `forward` would sit in the tape beside the renderer's own bare [true]
			// and still satisfy it, which is exactly the shape a re-arm of the hook
			// takes. So pin the HUD's whole tape — the first ask is the renderer's,
			// and no ask carries an options object, the only way `forward` returns.
			expect(hudCalls[0]).toEqual([true]);
			expect(hudCalls.filter((call) => call.length > 1)).toEqual([]);
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
	var __hudTape: Array<{ hud: boolean; args: unknown[] }> | undefined;
	var __hudSetIgnoreMouseEvents:
		| ((ignore: boolean, options?: { forward?: boolean }) => void)
		| undefined;
}
