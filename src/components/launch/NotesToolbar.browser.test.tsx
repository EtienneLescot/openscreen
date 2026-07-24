import "@/index.css";
import type { Editor } from "@tiptap/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { NotesToolbar } from "./NotesToolbar";

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => {
		const labels: Record<string, string> = {
			"tooltips.notesToolbar.play": "Play",
			"tooltips.notesToolbar.pause": "Pause",
			"tooltips.notesToolbar.speed": "Scroll speed",
			"tooltips.notesToolbar.decreaseSpeed": "Decrease scroll speed",
			"tooltips.notesToolbar.increaseSpeed": "Increase scroll speed",
			"tooltips.notesToolbar.fontSize": "Font size",
			"tooltips.notesToolbar.decreaseFontSize": "Decrease font size",
			"tooltips.notesToolbar.increaseFontSize": "Increase font size",
			"tooltips.notesToolbar.mirror": "Mirror",
		};
		return labels[key] ?? key;
	},
}));

function createEditor(): Editor {
	const chain: Record<string, ReturnType<typeof vi.fn>> = {};
	for (const command of [
		"focus",
		"toggleBold",
		"toggleItalic",
		"toggleStrike",
		"toggleBulletList",
		"toggleOrderedList",
		"toggleBlockquote",
		"toggleCodeBlock",
	]) {
		chain[command] = vi.fn(() => chain);
	}
	chain.run = vi.fn(() => true);

	return {
		can: () => ({ chain: () => chain }),
		chain: () => chain,
		isActive: () => false,
		on: vi.fn(),
		off: vi.fn(),
	} as unknown as Editor;
}

function ToolbarHarness() {
	const [isPlaying, setIsPlaying] = useState(false);
	const [speed, setSpeed] = useState(40);
	const [fontSize, setFontSize] = useState(16);
	const [mirrored, setMirrored] = useState(false);

	return (
		<NotesToolbar
			editor={createEditor()}
			isPlaying={isPlaying}
			speed={speed}
			fontSize={fontSize}
			mirrored={mirrored}
			onTogglePlaying={() => setIsPlaying((current) => !current)}
			onDecreaseSpeed={() => setSpeed((current) => current - 10)}
			onIncreaseSpeed={() => setSpeed((current) => current + 10)}
			onDecreaseFontSize={() => setFontSize((current) => current - 2)}
			onIncreaseFontSize={() => setFontSize((current) => current + 2)}
			onToggleMirror={() => setMirrored((current) => !current)}
		/>
	);
}

describe("NotesToolbar narrow-width reachability", () => {
	let root: Root | null = null;
	let host: HTMLDivElement | null = null;

	afterEach(() => {
		root?.unmount();
		host?.remove();
		root = null;
		host = null;
	});

	it("keeps every teleprompter control reachable at a severe 160px width", async () => {
		host = document.createElement("div");
		host.style.width = "160px";
		document.body.append(host);
		root = createRoot(host);
		flushSync(() => root?.render(<ToolbarHarness />));

		const row = host.querySelector<HTMLElement>('[data-testid="notes-teleprompter-controls"]');
		const controls = Array.from(
			host.querySelectorAll<HTMLButtonElement>("[data-teleprompter-control]"),
		);
		if (!row || controls.length === 0) {
			throw new Error("Teleprompter controls did not render");
		}

		expect(row.scrollWidth).toBeGreaterThan(row.clientWidth);
		await userEvent.wheel(row, { delta: { x: row.scrollWidth } });
		await new Promise(requestAnimationFrame);
		expect(row.scrollLeft).toBeGreaterThan(0);

		const rowRect = row.getBoundingClientRect();
		const lastRect = controls.at(-1)?.getBoundingClientRect();
		expect(lastRect).toBeDefined();
		expect(lastRect!.left).toBeGreaterThanOrEqual(rowRect.left - 1);
		expect(lastRect!.right).toBeLessThanOrEqual(rowRect.right + 1);

		controls[0]?.focus();
		expect(document.activeElement).toBe(controls[0]);
		for (let index = 1; index < controls.length; index++) {
			await userEvent.tab();
			expect(document.activeElement).toBe(controls[index]);
		}

		controls[0]?.focus();
		await userEvent.keyboard("{Enter}");
		expect(controls[0]?.getAttribute("aria-label")).toBe("Pause");

		const mirror = controls.at(-1)!;
		await userEvent.click(mirror);
		expect(mirror.getAttribute("aria-pressed")).toBe("true");
	});
});
