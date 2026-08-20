// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { NewProjectModal } from "./Modals";

function renderWithI18n(ui: ReactElement) {
	return render(<I18nProvider>{ui}</I18nProvider>);
}

describe("NewProjectModal starting points", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("offers only the two wired starting points", () => {
		renderWithI18n(<NewProjectModal open={true} onClose={() => {}} onCreate={() => {}} />);

		expect(screen.getByText(/import media/i)).toBeInTheDocument();
		expect(screen.getByText(/screen recording/i)).toBeInTheDocument();
		expect(screen.queryByText(/blank project/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/from template/i)).not.toBeInTheDocument();
	});

	it("creates with the import starting point by default", () => {
		const onCreate = vi.fn();
		renderWithI18n(<NewProjectModal open={true} onClose={() => {}} onCreate={onCreate} />);

		fireEvent.click(screen.getByRole("button", { name: /create project/i }));

		expect(onCreate).toHaveBeenCalledWith("Untitled project", "import");
	});

	it("creates with the screen-recording starting point once that cell is picked", () => {
		const onCreate = vi.fn();
		renderWithI18n(<NewProjectModal open={true} onClose={() => {}} onCreate={onCreate} />);

		fireEvent.click(screen.getByText(/screen recording/i));
		fireEvent.click(screen.getByRole("button", { name: /create project/i }));

		expect(onCreate).toHaveBeenCalledWith("Untitled project", "screen-recording");
	});
});
