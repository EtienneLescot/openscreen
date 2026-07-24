import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { NotesToolbar, type NotesToolbarProps } from "./NotesToolbar";

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

function createProps(overrides: Partial<NotesToolbarProps> = {}): NotesToolbarProps {
	return {
		editor: createEditor(),
		isPlaying: false,
		speed: 40,
		fontSize: 16,
		mirrored: false,
		onTogglePlaying: vi.fn(),
		onDecreaseSpeed: vi.fn(),
		onIncreaseSpeed: vi.fn(),
		onDecreaseFontSize: vi.fn(),
		onIncreaseFontSize: vi.fn(),
		onToggleMirror: vi.fn(),
		...overrides,
	};
}

describe("NotesToolbar teleprompter controls", () => {
	it("exposes values and dispatches every manual control", async () => {
		const user = userEvent.setup();
		const props = createProps();
		render(<NotesToolbar {...props} />);

		expect(screen.getByRole("status", { name: "Scroll speed" })).toHaveTextContent("40 px/s");
		expect(screen.getByRole("status", { name: "Font size" })).toHaveTextContent("16 px");
		expect(screen.getByRole("button", { name: "Mirror" })).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByRole("button", { name: "Decrease scroll speed" })).not.toHaveAttribute(
			"aria-pressed",
		);
		expect(screen.getByRole("button", { name: "Increase font size" })).not.toHaveAttribute(
			"aria-pressed",
		);

		await user.click(screen.getByRole("button", { name: "Play" }));
		await user.click(screen.getByRole("button", { name: "Decrease scroll speed" }));
		await user.click(screen.getByRole("button", { name: "Increase scroll speed" }));
		await user.click(screen.getByRole("button", { name: "Decrease font size" }));
		await user.click(screen.getByRole("button", { name: "Increase font size" }));
		await user.click(screen.getByRole("button", { name: "Mirror" }));

		expect(props.onTogglePlaying).toHaveBeenCalledOnce();
		expect(props.onDecreaseSpeed).toHaveBeenCalledOnce();
		expect(props.onIncreaseSpeed).toHaveBeenCalledOnce();
		expect(props.onDecreaseFontSize).toHaveBeenCalledOnce();
		expect(props.onIncreaseFontSize).toHaveBeenCalledOnce();
		expect(props.onToggleMirror).toHaveBeenCalledOnce();
	});

	it("disables controls at their bounds", () => {
		const { rerender } = render(<NotesToolbar {...createProps({ speed: 10, fontSize: 14 })} />);
		expect(screen.getByRole("button", { name: "Decrease scroll speed" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Decrease font size" })).toBeDisabled();

		rerender(<NotesToolbar {...createProps({ speed: 100, fontSize: 48 })} />);
		expect(screen.getByRole("button", { name: "Increase scroll speed" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Increase font size" })).toBeDisabled();
	});

	it("keeps playback paused and disabled until the editor is ready", () => {
		render(<NotesToolbar {...createProps({ editor: null })} />);
		expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
	});
});
