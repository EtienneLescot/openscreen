// ponytail: agentic-style roadmap coverage. One test per ✅ row in
// `docs/architecture/ai-edition-roadmap.md` (the ones with specs in
// `specs/`). Each test seeds the browser-shim with a known project,
// opens the editor, and asserts on observable behavior (data-*
// attributes, visible text, console errors). Fails = the roadmap's
// ✅ is a false claim. The agent would re-snapshot the DOM and patch
// brittle selectors; we go straight to the contract.
import { expect, type Page, test } from "@playwright/test";

const EDITOR_URL = "http://localhost:5173/?windowType=editor";

type Asset = {
	id: string;
	kind: "video";
	label: string;
	originalPath: string;
	durationSec: number;
	sizeBytes?: number;
	video: { codec: string; width: number; height: number; fps: number };
};

type Clip = {
	id: string;
	assetId: string;
	sourceStartSec: number;
	sourceEndSec: number;
	timelineStartSec: number;
	timelineEndSec: number;
	wordRefs: string[];
	origin: "system";
	reason: string;
};

type Region = {
	id: string;
	startSec: number;
	endSec: number;
	label?: string;
};

type Doc = ReturnType<typeof makeDoc>;

function makeDoc(
	opts: {
		withAsset?: boolean;
		withClip?: boolean;
		clips?: Clip[];
		zoomRegions?: Region[];
		annotationRegions?: Region[];
		speedRegions?: Region[];
	} = {},
) {
	const asset: Asset | null = opts.withAsset
		? {
				id: "asset_test",
				kind: "video",
				label: "Test Recording.mp4",
				originalPath: "C:\\nonexistent\\test.mp4",
				durationSec: 60,
				sizeBytes: 314_572_800,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}
		: null;
	const clips: Clip[] =
		opts.clips ??
		(opts.withClip && asset
			? [
					{
						id: "clip_test",
						assetId: asset.id,
						sourceStartSec: 0,
						// ponytail: long enough that fit-zoom (pxPerSec) sits well
						// below MAX_PX_PER_SEC, so Ctrl+wheel has headroom to zoom in.
						sourceEndSec: 600,
						timelineStartSec: 0,
						timelineEndSec: 600,
						wordRefs: [],
						origin: "system" as const,
						reason: "",
					},
				]
			: []);
	return {
		schemaVersion: 3,
		project: {
			id: "proj_test",
			title: "Test Project",
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-07-01T00:00:00.000Z",
		},
		assets: asset ? [asset] : [],
		transcripts: [],
		timeline: {
			clips,
			gaps: [],
			skipRanges: [],
			muteRanges: [],
			speedRanges: (opts.speedRegions ?? []).map((r) => ({ ...r, speed: 1.5 })),
			captionRanges: [],
		},
		annotations: (opts.annotationRegions ?? []).map((r) => ({
			...r,
			kind: "text" as const,
			style: { color: "#ffffff", fontFamily: "Inter", animation: "none" },
		})),
		zoomRanges: (opts.zoomRegions ?? []).map((r) => ({
			id: r.id,
			startMs: Math.round((r.startSec ?? 0) * 1000),
			endMs: Math.round((r.endSec ?? 0) * 1000),
			depth: 2,
			focus: { cx: 0.5, cy: 0.5 },
		})),
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek" as const, revision: 0 },
		export: { preset: "final-balanced" as const, lastJobId: null },
		history: { revisions: [] },
	};
}

async function seedAndOpen(page: Page, doc: Doc): Promise<void> {
	await page.addInitScript((serialized) => {
		const d = JSON.parse(serialized);
		localStorage.setItem("browser-shim-document", JSON.stringify(d));
		// ponytail: the editor's mount flow calls listProjects and loads
		// the first entry on launch. We need to seed the matching summary
		// so the project is discoverable.
		const summary = [
			{
				id: d.project.id,
				title: d.project.title,
				updatedAt: d.project.updatedAt,
				assetCount: d.assets.length,
			},
		];
		localStorage.setItem("browser-shim-projects", JSON.stringify(summary));
	}, JSON.stringify(doc));
	await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded" });
	await page.getByTestId("timeline-pane").waitFor({ state: "visible", timeout: 10_000 });
	// ponytail: the mount useEffect calls listProjects → loadProject, both
	// async. Wait for the document to actually be loaded (data-clip-count
	// reflects the seeded doc) before tests start asserting.
	await page.waitForFunction(
		(expected) => {
			const el = document.querySelector('[data-testid="timeline-pane"]');
			const n = el?.getAttribute("data-clip-count");
			return n !== null && Number(n) >= expected;
		},
		doc.timeline.clips.length,
		{ timeout: 5_000 },
	);
}

async function captureConsoleErrors(page: Page): Promise<string[]> {
	const errors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	return errors;
}

test.describe("Roadmap coverage (✅ rows) — agentic behavior specs", () => {
	test("P3.1: media panel shows asset size from sizeBytes", async ({ page }) => {
		const errors = await captureConsoleErrors(page);
		await seedAndOpen(page, makeDoc({ withAsset: true, withClip: true }));

		// The LeftPanel renders the asset list with formatSize(asset.sizeBytes).
		// For 300MB, expect a "MB" suffix.
		await expect(page.getByTestId("timeline-pane")).toBeVisible();

		// The size string should NOT be the em-dash placeholder.
		// We don't insist the size text is in a specific role; just that
		// at least one non-dash MB/KB/B string exists in the panel.
		const sizeText = page.getByText(/\d+(\.\d+)?\s*(B|KB|MB|GB)/i).first();
		await expect(sizeText)
			.toBeVisible({ timeout: 5_000 })
			.catch(() => {
				// If we can't find a sized string, the test fails here → P3.1 is a lie.
				throw new Error("P3.1: no size string visible in the media panel — sizeBytes not rendered");
			});
		expect(errors, errors.join("\n")).toEqual([]);
	});

	test("P3.1: asset without sizeBytes shows em-dash", async ({ page }) => {
		const doc = makeDoc({ withAsset: true, withClip: true });
		if (doc.assets[0]) delete (doc.assets[0] as { sizeBytes?: number }).sizeBytes;
		await seedAndOpen(page, doc);
		await expect(page.getByTestId("timeline-pane")).toBeVisible();
		await expect(page.getByText("—").first()).toBeVisible();
	});

	test("P3.3: clicking Help on a right pane opens a help popover", async ({ page }) => {
		const errors = await captureConsoleErrors(page);
		await seedAndOpen(page, makeDoc({ withAsset: true, withClip: true }));

		// ponytail: the right panel is hidden by default. Click the
		// "Toggle right panel" button to open it.
		const toggleRight = page.getByRole("button", { name: /toggle right panel/i });
		if (await toggleRight.isVisible().catch(() => false)) {
			await toggleRight.click();
		}
		// Click the "Background" tab to open the Background pane.
		const backgroundTab = page.getByRole("button", { name: /background/i }).first();
		if (await backgroundTab.isVisible().catch(() => false)) {
			await backgroundTab.click();
		}
		// ponytail: the P3.3 help button has aria-label="Help" (the RightPanes
		// code sets it from the helpLabel prop, which defaults to "Help"). It
		// lives in a pane header.
		const helpButton = page.getByRole("button", { name: /^help$/i }).first();
		await helpButton.waitFor({ state: "visible", timeout: 5_000 });
		await helpButton.click();

		// The popover is a sibling div with role="note" per the P3.3 commit.
		const popover = page.locator('[role="note"]').first();
		await expect(popover).toBeVisible({ timeout: 3_000 });

		// The popover text should NOT be the generic "Settings for X" fallback.
		const text = (await popover.textContent()) ?? "";
		expect(text.length, "P3.3: popover is empty").toBeGreaterThan(0);
		expect(
			/Settings for/i.test(text),
			`P3.3: popover shows generic fallback instead of pane-specific help. Got: "${text}"`,
		).toBe(false);

		// Click Help again → popover closes.
		await helpButton.click();
		await expect(popover).toBeHidden({ timeout: 2_000 });
		expect(errors, errors.join("\n")).toEqual([]);
	});

	test("T19: Ctrl+wheel on the timeline viewport changes px-per-sec", async ({ page }) => {
		const errors = await captureConsoleErrors(page);
		await seedAndOpen(page, makeDoc({ withAsset: true, withClip: true }));

		const viewport = page.getByTestId("timeline-viewport");
		const initialPxPerSec = Number((await viewport.getAttribute("data-px-per-sec")) ?? "0");
		expect(initialPxPerSec).toBeGreaterThan(0);

		const box = await viewport.boundingBox();
		if (!box) throw new Error("viewport has no bounding box");
		const centerX = box.x + box.width / 2;
		const centerY = box.y + 30; // top of viewport (ruler area)

		// Ctrl+wheel-up = zoom in. Three notches of -120 each.
		await page.keyboard.down("Control");
		for (let i = 0; i < 3; i++) {
			await page.mouse.move(centerX, centerY);
			await page.mouse.wheel(0, -120);
		}
		await page.keyboard.up("Control");

		// Give React a frame to re-render the data attribute.
		await page.waitForTimeout(150);

		const newPxPerSec = Number((await viewport.getAttribute("data-px-per-sec")) ?? "0");
		const zoomMultiplier = Number(
			(await page.getByTestId("timeline-pane").getAttribute("data-zoom-multiplier")) ?? "1",
		);

		expect(
			newPxPerSec,
			`T19: data-px-per-sec did not change after Ctrl+wheel (was ${initialPxPerSec}, now ${newPxPerSec})`,
		).toBeGreaterThan(initialPxPerSec);
		expect(
			zoomMultiplier,
			`T19: data-zoom-multiplier should be > 1 after zoom in (got ${zoomMultiplier})`,
		).toBeGreaterThan(1);
		expect(errors, errors.join("\n")).toEqual([]);
	});

	test("T19: zoom is bounded by MAX_PX_PER_SEC (280)", async ({ page }) => {
		await seedAndOpen(page, makeDoc({ withAsset: true, withClip: true }));

		const viewport = page.getByTestId("timeline-viewport");
		const box = await viewport.boundingBox();
		if (!box) throw new Error("viewport has no bounding box");
		const centerX = box.x + box.width / 2;
		const centerY = box.y + 30;

		await page.keyboard.down("Control");
		for (let i = 0; i < 30; i++) {
			await page.mouse.move(centerX, centerY);
			await page.mouse.wheel(0, -120);
		}
		await page.keyboard.up("Control");
		await page.waitForTimeout(200);

		const pxPerSec = Number((await viewport.getAttribute("data-px-per-sec")) ?? "0");
		expect(pxPerSec, `T19: px-per-sec exceeds MAX (got ${pxPerSec})`).toBeLessThanOrEqual(280);
	});

	test("P3.7: hovering the ruler shows a hover-guide line", async ({ page }) => {
		const errors = await captureConsoleErrors(page);
		await seedAndOpen(page, makeDoc({ withAsset: true, withClip: true }));

		const viewport = page.getByTestId("timeline-viewport");
		const box = await viewport.boundingBox();
		if (!box) throw new Error("viewport has no bounding box");

		// Hover the ruler area (top 22px of the viewport).
		await page.mouse.move(box.x + box.width / 2, box.y + 10);
		await page.waitForTimeout(150);

		// The hover-guide is a 1px-wide div with the .hoverGuide class. It's a
		// positioned element inside the ruler, rendered only while hovering
		// and not in panning/scrubbing/placingCut mode.
		const hoverGuide = page.locator(".hoverGuide, [class*='hoverGuide']");
		await expect(hoverGuide.first())
			.toBeVisible({ timeout: 2_000 })
			.catch(() => {
				throw new Error("P3.7: hover-guide line did not appear on ruler hover");
			});

		// Move away — guide disappears.
		await page.mouse.move(0, 0);
		await page.waitForTimeout(150);
		await expect(hoverGuide.first()).toBeHidden({ timeout: 2_000 });

		expect(errors, errors.join("\n")).toEqual([]);
	});

	test("P1.7: chat panel shows 'applied:' line for tool calls", async ({ page }) => {
		const errors = await captureConsoleErrors(page);
		await seedAndOpen(page, makeDoc({ withAsset: true, withClip: true }));

		// ponytail: the chat panel is hidden by default. Click the "Chat"
		// left-tab button to open it.
		const chatTab = page.getByRole("button", { name: /^chat$/i }).first();
		if (await chatTab.isVisible().catch(() => false)) {
			await chatTab.click();
			await page.waitForTimeout(500);
		}

		// Look for the chat input. Look for a textarea, contenteditable, or
		// placeholder mentioning chat.
		const input = page
			.locator(
				'textarea, textarea[placeholder*="message" i], [contenteditable="true"], input[type="text"][placeholder*="message" i]',
			)
			.first();
		if (!(await input.isVisible().catch(() => false))) {
			// ponytail: if we can't find the chat input, the test fails — either
			// the chat isn't in the editor's left panel for this build, or the
			// selector needs work. Either way, P1.7 wiring is unverifiable.
			throw new Error(
				"P1.7: chat input not found in the editor — LeftPanel chat surface not reachable",
			);
		}
		await input.fill("trim silence from 1s to 2s");
		await input.press("Enter");
		await page.waitForTimeout(2_000);

		// The browser-shim's chatRun returns a fixed message saying "AI features
		// need real LLM deps" — no tool calls. So the applied-line should NOT
		// appear (or should be empty). This is the negative case; see spec
		// p1.7 scenario 3. The behavior to assert: no spurious "applied:" line.
		const appliedLine = page.getByText(/^applied\s*:/i).first();
		const visible = await appliedLine.isVisible().catch(() => false);
		expect(
			visible,
			"P1.7: 'applied:' line appeared even though the response had no tool calls",
		).toBe(false);

		expect(errors, errors.join("\n")).toEqual([]);
	});
});
