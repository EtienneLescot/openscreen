// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { NotesToolbar, type NotesToolbarProps } from "./NotesToolbar";

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
	// `setLocale` persists its choice, and `I18nProvider` reads it back on mount — without
	// this, the one test that switches language would leak into every test after it.
	localStorage.removeItem(LOCALE_STORAGE_KEY);
});

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
		formattingDisabled: false,
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

	it("announces playback through its label rather than a second pressed state", () => {
		const { rerender } = renderToolbar(createProps());
		expect(screen.getByRole("button", { name: "Start auto-scroll" })).not.toHaveAttribute(
			"aria-pressed",
		);

		rerender(
			<I18nProvider>
				<NotesToolbar {...createProps({ isPlaying: true, formattingDisabled: true })} />
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Pause auto-scroll" })).not.toHaveAttribute(
			"aria-pressed",
		);
	});

	it("locks formatting when the note is locked, keeping teleprompter controls live", () => {
		// formattingDisabled without isPlaying is the mirrored-while-paused case.
		renderToolbar(createProps({ formattingDisabled: true }));

		// Sweep the whole row rather than a hand-written list, so a formatting button added
		// later cannot quietly escape the lock.
		const formatting = within(screen.getByTestId("notes-formatting-controls")).getAllByRole(
			"button",
		);
		expect(formatting).toHaveLength(7);
		for (const button of formatting) {
			expect(button).toBeDisabled();
		}

		// Teleprompter controls stay live so the lock can always be lifted, and the play
		// button's label keeps tracking isPlaying alone rather than the lock.
		expect(screen.getByRole("button", { name: "Start auto-scroll" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Mirror horizontally" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Decrease scroll speed" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Increase font size" })).toBeEnabled();
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

function ToolbarHarness() {
	const [isPlaying, setIsPlaying] = useState(false);
	const [mirrored, setMirrored] = useState(false);

	return (
		<NotesToolbar
			{...createProps({
				isPlaying,
				mirrored,
				formattingDisabled: isPlaying || mirrored,
				onTogglePlaying: () => setIsPlaying((current) => !current),
				onToggleMirror: () => setMirrored((current) => !current),
			})}
		/>
	);
}

describe("NotesToolbar keyboard reachability", () => {
	it("walks every teleprompter control in order and toggles them from the keyboard", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<I18nProvider>
				<ToolbarHarness />
			</I18nProvider>,
		);

		const row = container.querySelector<HTMLElement>('[data-testid="notes-teleprompter-controls"]');
		const controls = Array.from(
			container.querySelectorAll<HTMLButtonElement>("[data-teleprompter-control]"),
		);
		expect(row).not.toBeNull();
		expect(controls).toHaveLength(6);

		controls[0]?.focus();
		expect(document.activeElement).toBe(controls[0]);
		for (let index = 1; index < controls.length; index++) {
			await user.tab();
			expect(document.activeElement).toBe(controls[index]);
		}

		controls[0]?.focus();
		await user.keyboard("{Enter}");
		expect(controls[0]).toHaveAttribute("aria-label", "Pause auto-scroll");

		const mirror = controls.at(-1);
		await user.click(mirror as HTMLButtonElement);
		expect(mirror).toHaveAttribute("aria-pressed", "true");
	});
});
