// Diagnostic: open the editor with a seeded project and dump the
// accessibility tree. Used to figure out the right selectors for
// chat input, help button, and timeline ruler — selectors I can't
// guess from the source alone.
import { expect, test } from "@playwright/test";

const EDITOR_URL = "http://localhost:5173/?windowType=editor";

const DOC = {
	schemaVersion: 3,
	project: {
		id: "proj_diag",
		title: "Diagnostic",
		createdAt: "2026-07-01T00:00:00.000Z",
		updatedAt: "2026-07-01T00:00:00.000Z",
	},
	assets: [
		{
			id: "asset_diag",
			kind: "video",
			label: "diagnostic.mp4",
			originalPath: "C:\\nonexistent\\diagnostic.mp4",
			durationSec: 600,
			sizeBytes: 12_345_678,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		},
	],
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "clip_diag",
				assetId: "asset_diag",
				sourceStartSec: 0,
				sourceEndSec: 600,
				timelineStartSec: 0,
				timelineEndSec: 600,
				wordRefs: [],
				origin: "system",
				reason: "",
			},
		],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [
		{
			id: "z1",
			startMs: 5_000,
			endMs: 15_000,
			depth: 2,
			focus: { cx: 0.5, cy: 0.5 },
		},
		{
			id: "z2",
			startMs: 30_000,
			endMs: 45_000,
			depth: 3,
			focus: { cx: 0.5, cy: 0.5 },
		},
	],
	legacyEditor: null,
	agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
	preview: { strategy: "seek", revision: 0 },
	export: { preset: "final-balanced", lastJobId: null },
	history: { revisions: [] },
};

test("diagnostic: dump editor DOM + accessibility tree", async ({ page }) => {
	await page.addInitScript((serialized) => {
		const d = JSON.parse(serialized);
		localStorage.setItem("browser-shim-document", serialized);
		localStorage.setItem(
			"browser-shim-projects",
			JSON.stringify([
				{
					id: d.project.id,
					title: d.project.title,
					updatedAt: d.project.updatedAt,
					assetCount: d.assets.length,
				},
			]),
		);
	}, JSON.stringify(DOC));
	await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded" });
	// Hook all console output from the renderer.
	page.on("console", (msg) => {
		console.log(`[renderer:${msg.type()}] ${msg.text()}`);
	});
	page.on("pageerror", (err) => {
		console.log(`[renderer:pageerror] ${err.message}`);
	});
	await page.getByTestId("timeline-pane").waitFor({ state: "visible" });
	// ponytail: wait for the mount useEffect to actually load the project
	// (data-clip-count > 0), so the dump reflects a populated editor.
	try {
		await page.waitForFunction(
			() => {
				const el = document.querySelector('[data-testid="timeline-pane"]');
				const n = el?.getAttribute("data-clip-count");
				return n !== null && Number(n) > 0;
			},
			undefined,
			{ timeout: 5_000 },
		);
	} catch {
		console.log("[diag] clip-count never went > 0 — editor stayed in empty state");
	}
	// Print the localStorage keys we ended up with, to verify the seed.
	const storageKeys = await page.evaluate(() => {
		return Object.keys(localStorage).map((k) => ({
			key: k,
			preview: (localStorage.getItem(k) ?? "").slice(0, 80),
		}));
	});
	console.log(`[diag] localStorage keys: ${JSON.stringify(storageKeys)}`);

	// Probe the shim directly. We need to reach the project store's listProjects.
	const shimResult = await page.evaluate(async () => {
		try {
			// The shim is installed on window.electronAPI; the project store
			// goes through nativeBridgeClient which is also window-attached
			// via the shim's module. Try both routes.
			const win = window as unknown as {
				electronAPI?: { getPlatform?: () => unknown };
				nativeBridgeClient?: {
					aiEdition?: {
						listProjects?: () => Promise<unknown>;
						get?: (id: string) => Promise<unknown>;
					};
				};
			};
			const out: Record<string, unknown> = {};
			out.electronAPI = Object.keys(win.electronAPI ?? {});
			out.nativeBridgeClient = Object.keys(win.nativeBridgeClient ?? {});
			out.aiEdition = Object.keys(win.nativeBridgeClient?.aiEdition ?? {});
			try {
				out.listProjectsResult = await win.nativeBridgeClient?.aiEdition?.listProjects?.();
			} catch (e) {
				out.listProjectsError = String(e);
			}
			return out;
		} catch (err) {
			return { error: String(err) };
		}
	});
	console.log(`[diag] shim probe: ${JSON.stringify(shimResult)}`);
	await page.screenshot({ path: "test-results/diagnostic.png", fullPage: true });

	// Buttons in the right pane header.
	const helpButtons = await page.getByRole("button", { name: /help/i }).count();
	console.log(`[diag] help buttons found via getByRole('button', {name: /help/i}): ${helpButtons}`);

	const allButtons = await page.locator("button").count();
	console.log(`[diag] total <button> elements: ${allButtons}`);

	// Dump the aria-label of every button so we can find the right selector.
	const buttonLabels = await page.evaluate(() => {
		const buttons = Array.from(document.querySelectorAll("button"));
		return buttons.map((b) => ({
			text: (b.textContent ?? "").trim().slice(0, 30),
			ariaLabel: b.getAttribute("aria-label"),
			title: b.getAttribute("title"),
		}));
	});
	console.log(`[diag] button labels: ${JSON.stringify(buttonLabels)}`);

	// What are the data-testid values present in the DOM?
	const testIds = await page.evaluate(() => {
		const els = Array.from(document.querySelectorAll("[data-testid]"));
		return els.map((e) => e.getAttribute("data-testid"));
	});
	console.log(`[diag] data-testids: ${JSON.stringify(testIds)}`);

	// What does the data-testid="preview" look like?
	const preview = page.getByTestId("preview");
	console.log(`[diag] preview visible: ${await preview.isVisible()}`);
	console.log(`[diag] preview html start: ${(await preview.innerHTML()).slice(0, 300)}`);

	// Look for the chat input. Try several selectors.
	for (const sel of [
		"textarea",
		'input[type="text"]',
		'[contenteditable="true"]',
		'[role="textbox"]',
		'[data-testid*="chat" i]',
	]) {
		const n = await page.locator(sel).count();
		console.log(`[diag] ${sel} count: ${n}`);
	}

	// Look for the right pane container.
	const rightPane = page
		.locator('[data-testid*="right" i], [class*="rightPane" i], [class*="RightPane" i]')
		.first();
	console.log(`[diag] rightPane exists: ${(await rightPane.count()) > 0}`);

	// Dump the first 1500 chars of the page HTML so we can see structure.
	const html = await page.content();
	console.log(`[diag] page html length: ${html.length}`);
	console.log(`[diag] first 1500 chars: ${html.slice(0, 1500)}`);

	// Force the test to pass (we're just printing diagnostics).
	expect(true).toBe(true);
});
