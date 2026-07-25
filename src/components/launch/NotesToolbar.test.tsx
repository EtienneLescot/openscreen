import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/react";
import { type ReactNode, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "@/contexts/I18nContext";
import { NotesToolbar, type NotesToolbarProps } from "./NotesToolbar";

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children: React.ReactNode }) => children,
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

function ActiveLocale({ children, locale }: { children: ReactNode; locale: string }) {
	const { setLocale } = useI18n();

	useLayoutEffect(() => {
		setLocale(locale);
	}, [locale, setLocale]);

	return children;
}

function renderToolbar(props: NotesToolbarProps, locale = "en") {
	return render(
		<I18nProvider>
			<ActiveLocale locale={locale}>
				<NotesToolbar {...props} />
			</ActiveLocale>
		</I18nProvider>,
	);
}

describe("NotesToolbar teleprompter controls", () => {
	it("exposes values and dispatches every manual control", async () => {
		const user = userEvent.setup();
		const props = createProps();
		renderToolbar(props);

		const speed = within(screen.getByRole("group", { name: "Scroll speed" })).getByRole("status");
		const fontSize = within(screen.getByRole("group", { name: "Font size" })).getByRole("status");
		expect(speed).not.toHaveAccessibleName();
		expect(speed).toHaveTextContent("40 px/s");
		expect(fontSize).not.toHaveAccessibleName();
		expect(fontSize).toHaveTextContent("16 px");
		expect(screen.getByRole("button", { name: "Mirror horizontally" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		expect(screen.getByRole("button", { name: "Decrease scroll speed" })).not.toHaveAttribute(
			"aria-pressed",
		);
		expect(screen.getByRole("button", { name: "Increase font size" })).not.toHaveAttribute(
			"aria-pressed",
		);

		await user.click(screen.getByRole("button", { name: "Start auto-scroll" }));
		await user.click(screen.getByRole("button", { name: "Decrease scroll speed" }));
		await user.click(screen.getByRole("button", { name: "Increase scroll speed" }));
		await user.click(screen.getByRole("button", { name: "Decrease font size" }));
		await user.click(screen.getByRole("button", { name: "Increase font size" }));
		await user.click(screen.getByRole("button", { name: "Mirror horizontally" }));

		expect(props.onTogglePlaying).toHaveBeenCalledOnce();
		expect(props.onDecreaseSpeed).toHaveBeenCalledOnce();
		expect(props.onIncreaseSpeed).toHaveBeenCalledOnce();
		expect(props.onDecreaseFontSize).toHaveBeenCalledOnce();
		expect(props.onIncreaseFontSize).toHaveBeenCalledOnce();
		expect(props.onToggleMirror).toHaveBeenCalledOnce();
	});

	it("disables controls at their bounds", () => {
		const { rerender } = renderToolbar(createProps({ speed: 10, fontSize: 14 }));
		expect(screen.getByRole("button", { name: "Decrease scroll speed" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Decrease font size" })).toBeDisabled();

		rerender(
			<I18nProvider>
				<NotesToolbar {...createProps({ speed: 100, fontSize: 48 })} />
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Increase scroll speed" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Increase font size" })).toBeDisabled();
	});

	it("keeps playback paused and disabled until the editor is ready", () => {
		renderToolbar(createProps({ editor: null }));
		expect(screen.getByRole("button", { name: "Start auto-scroll" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Pause auto-scroll" })).not.toBeInTheDocument();
	});

	it("formats readout values for the active locale", () => {
		renderToolbar(createProps(), "ar");
		const speed = within(screen.getByRole("group", { name: "سرعة التمرير" })).getByRole("status");
		const fontSize = within(screen.getByRole("group", { name: "حجم الخط" })).getByRole("status");

		expect(speed).not.toHaveAccessibleName();
		expect(speed).toHaveTextContent(`${new Intl.NumberFormat("ar").format(40)} بكسل/ثانية`);
		expect(fontSize).not.toHaveAccessibleName();
		expect(fontSize).toHaveTextContent(`${new Intl.NumberFormat("ar").format(16)} بكسل`);
	});
});
