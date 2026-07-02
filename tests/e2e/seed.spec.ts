// ponytail: the seed test gives the planner/generator/healer agents a
// working browser session to bootstrap from. Vite must be running on
// localhost:5173 (npm run dev). It mounts the editor in browser-shim
// mode so no Electron window is required.
import { expect, test } from "@playwright/test";

const EDITOR_URL = "http://localhost:5173/?windowType=editor";

test("seed: editor opens without console errors and exposes the timeline + preview", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});

	await page.goto(EDITOR_URL, { waitUntil: "networkidle" });

	const timeline = page.getByTestId("timeline-pane");
	const preview = page.getByTestId("preview");
	await expect(timeline).toBeVisible();
	await expect(preview).toBeVisible();

	// ponytail: data-* hooks are how the planner/generator agents assert
	// on behavior. If any of these go missing, every behavior spec breaks.
	await expect(timeline).toHaveAttribute("data-clip-count", /^\d+$/);
	await expect(timeline).toHaveAttribute("data-skip-count", /^\d+$/);
	await expect(timeline).toHaveAttribute("data-current-time-sec", /^\d+(\.\d+)?$/);
	await expect(timeline).toHaveAttribute("data-zoom-multiplier", /^\d+(\.\d+)?$/);
	await expect(preview).toHaveAttribute("data-current-time-sec", /^\d+(\.\d+)?$/);
	await expect(preview).toHaveAttribute("data-is-playing", /^(true|false)$/);

	expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toEqual([]);
});
