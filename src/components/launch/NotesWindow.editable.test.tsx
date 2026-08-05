// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { NotesWindow } from "./NotesWindow";

// The sibling suite stubs `@tiptap/react`, so nothing in it can show that the real note ever
// stops accepting edits. `useEditor` honours `editable` only when it CREATES the editor and
// pins every later option pass to the editor's own `isEditable`, which makes `setEditable` the
// one path that carries a mirror toggle — and losing it, to a refactor or a Tiptap upgrade,
// leaves every mocked assertion green. So this one drives the real editor and reads
// `contenteditable` back off the DOM. (The constructor option stays pinned at the mocked
// boundary: React flushes the effect before a test can observe the first paint.)
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
	localStorage.clear();
});

function noteBody(): HTMLElement {
	const body = document.querySelector<HTMLElement>(".tiptap");
	if (!body) {
		throw new Error("the editor never mounted");
	}

	return body;
}

describe("NotesWindow read-only wiring against the real editor", () => {
	it("stops and resumes accepting edits with the mirror", async () => {
		const user = userEvent.setup();
		render(
			<I18nProvider>
				<NotesWindow />
			</I18nProvider>,
		);
		const mirror = screen.getByRole("button", { name: "Mirror horizontally" });

		expect(noteBody()).toHaveAttribute("contenteditable", "true");

		await user.click(mirror);
		expect(noteBody()).toHaveAttribute("contenteditable", "false");

		await user.click(mirror);
		expect(noteBody()).toHaveAttribute("contenteditable", "true");
	});
});
