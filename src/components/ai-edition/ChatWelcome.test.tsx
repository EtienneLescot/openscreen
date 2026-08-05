// @vitest-environment jsdom
// ChatWelcome guards the "no provider connected" empty state: the copy reaches
// the DOM, the CTA fires, and a non-English locale is really translated rather
// than falling back to English. localeParity.test.ts covers key presence for
// the other locales; only the fallback check needs a rendered card.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { ChatWelcome } from "./ChatWelcome";

function renderIn(locale: string, ui: ReactElement) {
	localStorage.setItem(LOCALE_STORAGE_KEY, locale);
	return render(<I18nProvider>{ui}</I18nProvider>);
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("ChatWelcome", () => {
	it("renders the English welcome card with the CTA and disclaimer", () => {
		const onOpen = vi.fn();
		renderIn("en", <ChatWelcome onOpenProviderSettings={onOpen} />);

		expect(screen.getByRole("heading", { name: /bring your own ai/i })).toBeInTheDocument();
		expect(screen.getByText(/talk.*language model/i)).toBeInTheDocument();
		// The 3 feature lines are inside a <ul>; query them by text so we know
		// they actually reach the DOM, not just an unused i18n key.
		expect(screen.getByText(/cut silences/i)).toBeInTheDocument();
		expect(screen.getByText(/add captions/i)).toBeInTheDocument();
		expect(screen.getByText(/rewrite a section/i)).toBeInTheDocument();
		expect(screen.getByText(/transcript will be sent/i)).toBeInTheDocument();
	});

	it("invokes the onOpenProviderSettings callback when the CTA is clicked", () => {
		const onOpen = vi.fn();
		renderIn("en", <ChatWelcome onOpenProviderSettings={onOpen} />);

		fireEvent.click(screen.getByRole("button", { name: /set up a provider/i }));

		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("renders the French welcome card with translated copy", () => {
		renderIn("fr", <ChatWelcome onOpenProviderSettings={vi.fn()} />);

		expect(screen.getByRole("heading", { name: /apportez votre ia/i })).toBeInTheDocument();
		expect(screen.getByText(/configurer un fournisseur/i)).toBeInTheDocument();
		// Disclaimer must NOT be the English fallback
		expect(screen.queryByText(/transcript will be sent/i)).not.toBeInTheDocument();
		expect(screen.getByText(/transcription de votre vidéo/i)).toBeInTheDocument();
	});
});
