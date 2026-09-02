// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { CursorPane } from "./RightPanes";

function stubStorage() {
	const store = new Map<string, string>();
	const localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => {
			store.clear();
		},
		key: (index: number) => [...store.keys()][index] ?? null,
		get length() {
			return store.size;
		},
	};
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
}

beforeEach(() => {
	stubStorage();
	window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

afterEach(() => {
	cleanup();
});

describe("CursorPane theme previews", () => {
	it("full: hello-kitty-watermelon theme cell shows arrow and pointer", () => {
		render(
			<I18nProvider>
				<CursorPane />
			</I18nProvider>,
		);
		const cell = screen.getByRole("button", { name: "Hello Kitty & Watermelon" });
		expect(cell.querySelectorAll("img")).toHaveLength(2);
	});

	it("empty: default theme cell shows a single preview img", () => {
		render(
			<I18nProvider>
				<CursorPane />
			</I18nProvider>,
		);
		const cell = screen.getByRole("button", { name: "Default" });
		expect(cell.querySelectorAll("img")).toHaveLength(1);
	});
});
