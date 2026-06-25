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
