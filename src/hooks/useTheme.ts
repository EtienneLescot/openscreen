import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "openscreen-theme";

function readStoredTheme(): Theme {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw === "dark" ? "dark" : "light";
	} catch {
		return "light";
	}
}

function applyTheme(theme: Theme) {
	if (theme === "dark") {
		document.documentElement.setAttribute("data-theme", "dark");
	} else {
		document.documentElement.removeAttribute("data-theme");
	}
	// Keep the legacy shadcn/Tailwind `.dark` class (index.css's `--accent`/
	// `--border`/`--muted` HSL-triplet tokens) in sync with the ai-edition
	// `data-theme` attribute — these are two separate token systems that
	// happen to share property names, so leaving `.dark` stuck on regardless
	// of the real theme silently overrides design-tokens.css's light values.
	document.documentElement.classList.toggle("dark", theme === "dark");

	// Repaint the native Windows/Linux window controls in the new theme, so the
	// titlebar reads as one continuous surface with the app. Reading the tokens
	// back keeps the palette in design-tokens.css only. No-op elsewhere.
	const css = getComputedStyle(document.documentElement);
	window.electronAPI?.setTitleBarOverlay?.(
		css.getPropertyValue("--bg").trim(),
		css.getPropertyValue("--muted").trim(),
	);
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
	const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

	useEffect(() => {
		applyTheme(theme);
		try {
			localStorage.setItem(STORAGE_KEY, theme);
		} catch {
			// ponytail: storage may be unavailable in private browsing
		}
	}, [theme]);

	const toggle = useCallback(() => {
		setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
	}, []);

	const setTheme = useCallback((t: Theme) => {
		setThemeState(t);
	}, []);

	return { theme, toggle, setTheme };
}
