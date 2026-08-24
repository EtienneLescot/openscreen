// Translation for toasts fired OUTSIDE React -- stores, and anything else that reports
// to the user without a component around it to call `useScopedT`.

import { DEFAULT_LOCALE, type I18nNamespace, LOCALE_STORAGE_KEY, type Locale } from "./config";
import { getAvailableLocales, translate } from "./loader";

/**
 * Toasts fired outside React still have to speak the user's language. Same source as
 * `I18nProvider` (stored preference, else the default), validated so a stale value
 * cannot push `translate` onto a locale it does not have.
 */
export function toastText(
	namespace: I18nNamespace,
	key: string,
	vars?: Record<string, string | number>,
): string {
	let locale: Locale = DEFAULT_LOCALE;
	try {
		const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
		if (stored && getAvailableLocales().includes(stored as Locale)) locale = stored as Locale;
	} catch {
		// localStorage may be unavailable -- the default locale is a fine answer.
	}
	return translate(locale, namespace, key, vars);
}
