// Browser-shim e2e for the v4 editor shell (EditorTopBar + FloatingInspector +
// V4Timeline). Each test seeds a v5 document into the shim's localStorage, opens
// the editor, and asserts on what the user can actually see. Selectors come from
// `src/components/ai-edition/v4/` — stable hooks only (aria-labels, roles,
// `data-clip-id`), plus `[class*="…"]` for the two CSS-module elements that have
// no accessible name (the timeline's tracks + nav window).
//
// Needs a dev server: `npm run dev` (default 5173, override with E2E_BASE_URL).
import { expect, type Page, test } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const EDITOR_URL = `${BASE_URL}/?windowType=editor`;

// 300 MB exactly, so MediaStage's formatSize renders "300 MB".
const SIZED_BYTES = 314_572_800;

function makeAsset(id: string, label: string, sizeBytes?: number) {
	return {
		id,
		kind: "video" as const,
		label,
		originalPath: `C:\\nonexistent\\${id}.mp4`,
		durationSec: 600,
		...(sizeBytes === undefined ? {} : { sizeBytes }),
		video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		cameraTrack: null,
	};
}

function makeDoc() {
	return {
		schemaVersion: 5,
		project: {
			id: "proj_e2e",
			title: "E2E Fixture",
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-07-01T00:00:00.000Z",
			primaryAssetId: "asset_sized",
		},
		assets: [
			makeAsset("asset_sized", "Sized.mp4", SIZED_BYTES),
			makeAsset("asset_unsized", "Unsized.mp4"),
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip_e2e",
					assetId: "asset_sized",
					sourceStartSec: 0,
					sourceEndSec: 600,
					timelineStartSec: 0,
					timelineEndSec: 600,
					wordRefs: [],
					origin: "system" as const,
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
		zoomRanges: [],
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek" as const, revision: 0 },
		export: { preset: "final-balanced" as const, lastJobId: null },
		history: { revisions: [] },
	};
}

// Same fixture, split into two clips: FloatingInspector's "Edit clip" button
// only renders its picker popover past one clip (clips.length === 1 jumps
// straight to onEditClip instead), so testing the popover needs a second clip.
function makeTwoClipDoc(): ReturnType<typeof makeDoc> {
	const doc = makeDoc();
	doc.timeline.clips = [
		{
			id: "clip_e2e_a",
			assetId: "asset_sized",
			sourceStartSec: 0,
			sourceEndSec: 300,
			timelineStartSec: 0,
			timelineEndSec: 300,
			wordRefs: [],
			origin: "system" as const,
			reason: "",
		},
		{
			id: "clip_e2e_b",
			assetId: "asset_sized",
			sourceStartSec: 300,
			sourceEndSec: 600,
			timelineStartSec: 300,
			timelineEndSec: 600,
			wordRefs: [],
			origin: "system" as const,
			reason: "",
		},
	];
	return doc;
}

async function seedAndOpen(page: Page, doc: ReturnType<typeof makeDoc> = makeDoc()): Promise<void> {
	await page.addInitScript((serialized) => {
		const parsed = JSON.parse(serialized);
		// The shim keys documents by project id under one blob (see
		// `createShimBridgeClient` in src/native/browserShim.ts); the shell's mount
		// effect calls listProjects() → loadProject(first) on launch, so seeding
		// this is what lands us in a populated editor.
		localStorage.setItem(
			"browser-shim-projects-v2",
			JSON.stringify({ documents: { [parsed.project.id]: parsed }, order: [parsed.project.id] }),
		);
	}, JSON.stringify(doc));
	await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded" });
	// listProjects → loadProject are both async. Rendered clip pills are the
	// first observable proof the seeded document reached the timeline.
	await expect(page.locator("[data-clip-id]")).toHaveCount(doc.timeline.clips.length, {
		timeout: 15_000,
	});
}

test.describe("v4 editor shell", () => {
	test("media stage shows each asset's file size, em-dash when unknown", async ({ page }) => {
		await seedAndOpen(page);
		await page.getByRole("tab", { name: "Media" }).click();

		const sized = page.getByRole("button", { name: /Sized\.mp4/ }).first();
		const unsized = page.getByRole("button", { name: /Unsized\.mp4/ }).first();
		await expect(sized).toContainText("300 MB");
		// formatSize's placeholder for a missing sizeBytes.
		await expect(unsized).toContainText("—");
	});

	test("inspector facet header opens a contextual help popover", async ({ page }) => {
		await seedAndOpen(page);

		// The inspector opens on the "effects" facet; the rail buttons are labelled
		// from settings.<facet>.title (FloatingInspector's FACETS).
		await page.getByRole("button", { name: "Background" }).click();
		const help = page.getByRole("button", { name: "Help" });
		await help.click();

		// RightPanes' `Pane` renders the help text in a role="note" popover.
		const popover = page.locator('[role="note"]');
		await expect(popover).toBeVisible();
		// Pane-specific text, not a generic stub: settings.background.help.
		await expect(popover).toContainText("behind the recording");

		await help.click();
		await expect(popover).toBeHidden();
	});

	test("ctrl+wheel over the tracks zooms the timeline, bounded at 2% of its span", async ({
		page,
	}) => {
		await seedAndOpen(page);

		// The nav window's width mirrors the visible fraction of the timeline
		// (V4Timeline's `nav` state, which the ctrl+wheel handler drives).
		const navWindow = page.locator('[class*="tlNavWindow"]');
		const widthPct = () =>
			navWindow.evaluate((el) => Number.parseFloat((el as HTMLElement).style.width));
		expect(await widthPct()).toBe(100);

		const tracks = page.locator('[class*="tlTracks"]');
		const box = await tracks.boundingBox();
		if (!box) throw new Error("timeline tracks have no bounding box");
		const zoom = async (notches: number) => {
			await page.keyboard.down("Control");
			for (let i = 0; i < notches; i++) {
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await page.mouse.wheel(0, -120);
			}
			await page.keyboard.up("Control");
		};

		await zoom(3);
		await expect.poll(widthPct).toBeLessThan(100);

		// Each notch divides the span by 1.12; the handler clamps at 0.02, which
		// ~40 more notches overshoots comfortably.
		await zoom(40);
		await expect.poll(widthPct).toBe(2);
	});

	// The playhead reads `currentTimeSec` off the project store itself rather than
	// receiving it as a prop from the editor shell, so that playback (which rewrites
	// it ~60×/s) no longer re-renders the whole editor to move one line — see
	// PlayheadOverlay in V4Timeline.tsx. This covers both directions of that: a bare
	// store write must move it, and a scrub drag must still drive it and the store.
	test("the playhead follows both a store write and a scrub drag", async ({ page }) => {
		await seedAndOpen(page);

		// `left` is a percentage of the 600 s fixture timeline. Addressed by position
		// in the overlay rather than by class: `tlPlayhead`, `tlPlayheadLayer` and
		// `tlPlayheadDiamond` all share a `[class*=]` prefix.
		const playhead = page.locator('[class*="tlPlayheadLayer"] > [class*="tlCanvas"] > div');
		const leftPct = () =>
			playhead.evaluate((el) => Number.parseFloat((el as HTMLElement).style.left));
		const storeTimeSec = () =>
			page.evaluate(
				() =>
					(
						window as unknown as {
							__osProjectStore: { getState: () => { currentTimeSec: number } };
						}
					).__osProjectStore.getState().currentTimeSec,
			);

		expect(await leftPct()).toBe(0);

		// Nothing re-renders the shell here — the store write alone has to move it.
		await page.evaluate(() =>
			(
				window as unknown as {
					__osProjectStore: { getState: () => { setCurrentTime: (s: number) => void } };
				}
			).__osProjectStore
				.getState()
				.setCurrentTime(300),
		);
		await expect.poll(leftPct).toBeCloseTo(50, 1);
		await expect(page.getByRole("toolbar", { name: /playback/i })).toContainText("5:00.0");

		// Scrub: press at 25% of the timeline canvas, drag to 75%, release. The
		// playhead tracks the pointer and the store lands on the release position.
		const canvas = page.locator('[class*="tlTracks"] [class*="tlCanvas"]').first();
		const box = await canvas.boundingBox();
		if (!box) throw new Error("timeline canvas has no bounding box");
		const y = box.y + box.height / 2;
		await page.mouse.move(box.x + box.width * 0.25, y);
		await page.mouse.down();
		await expect.poll(leftPct).toBeCloseTo(25, 0);
		await page.mouse.move(box.x + box.width * 0.75, y, { steps: 8 });
		await page.mouse.up();
		await expect.poll(leftPct).toBeCloseTo(75, 0);
		expect(await storeTimeSec()).toBeGreaterThan(400);
	});

	test("clicking outside the clip picker popover closes it", async ({ page }) => {
		await seedAndOpen(page, makeTwoClipDoc());

		await page.getByRole("button", { name: "Edit clip" }).click();
		const picker = page.getByRole("menu", { name: "Choose a clip to edit" });
		await expect(picker).toBeVisible();

		// Any unrelated point outside the popover — the timeline tracks are a
		// stable target the other tests already click on.
		await page.locator('[class*="tlTracks"]').click({ position: { x: 10, y: 10 } });
		await expect(picker).toBeHidden();
	});
});
