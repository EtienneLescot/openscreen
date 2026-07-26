// Boot smoke test for the v4 editor shell: no project seeded, so this is the
// cold-start path a user hits before they have anything to edit. Its companion
// `v4-shell.spec.ts` always seeds a document; this one deliberately doesn't —
// the empty state is its own render branch (Preview → EditorEmptyState) and the
// only thing that catches a mount-time crash with an empty shim.
//
// Needs a dev server: `npm run dev` (default 5173, override with E2E_BASE_URL).
import { expect, test } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const EDITOR_URL = `${BASE_URL}/?windowType=editor`;

test("editor boots into the empty state with no project, and logs no console errors", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

	// A fresh Playwright context has empty localStorage, so the shell's mount
	// effect finds no project via listProjects() and renders the empty branch.
	await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded" });

	// Preview shell — the transport-state hooks the editor exposes to the outside.
	const preview = page.getByTestId("preview");
	await expect(preview).toBeVisible();
	await expect(preview).toHaveAttribute("data-current-time-sec", /^\d+(\.\d+)?$/);
	await expect(preview).toHaveAttribute("data-is-playing", /^(true|false)$/);
	await expect(preview).toContainText("No project open");

	// Timeline mounts even with nothing on it (V4Timeline's tools toolbar).
	await expect(page.getByRole("toolbar", { name: "Timeline tools" })).toBeVisible();
	// Top bar mounted, defaulting to Edit mode.
	await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");

	expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
