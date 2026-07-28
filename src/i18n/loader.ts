import i18next, { type Resource } from "i18next";
import { DEFAULT_LOCALE, I18N_NAMESPACES, type I18nNamespace, type Locale } from "./config";

const modules = import.meta.glob("./locales/**/*.json", {
	eager: true,
	import: "default",
}) as Record<string, unknown>;

const byLocale: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(modules)) {
	const [locale, namespace] = path.replace("./locales/", "").replace(".json", "").split("/");
	if (!byLocale[locale]) byLocale[locale] = {};
	byLocale[locale][namespace] = mod;
}

const isComplete = (locale: string) => I18N_NAMESPACES.every((ns) => byLocale[locale]?.[ns]);

const incomplete = Object.keys(byLocale).filter((locale) => !isComplete(locale));
if (incomplete.length > 0) {
	console.error("[i18n] Incomplete locale folders were excluded:", incomplete.join(", "));
}

const availableLocales = Object.keys(byLocale)
	.filter(isComplete)
	.sort((a, b) => (a === DEFAULT_LOCALE ? -1 : b === DEFAULT_LOCALE ? 1 : a.localeCompare(b)));

const resources = Object.fromEntries(
	availableLocales.map((locale) => [locale, byLocale[locale] as Resource[string]]),
) as Resource;

// `lng` is inert here: every lookup below passes an explicit `lng`, so the init
// language never reaches the output. Reading localStorage at module scope would
// add a failure mode for no gain — it can throw SecurityError, and at module
// scope that takes down the whole graph rather than one component. The user's
// stored preference is applied by I18nContext, which guards its access.
await i18next.init({
	lng: DEFAULT_LOCALE,
	fallbackLng: DEFAULT_LOCALE,
	defaultNS: "common",
	resources,
	interpolation: { escapeValue: false },
	// A non-leaf key would otherwise render i18next's English developer message
	// ("key 'x' returned an object instead of string") straight into the UI.
	// Returning undefined keeps the old loader's behaviour: fall through to the
	// `namespace.key` marker.
	returnedObjectHandler: () => undefined,
});

function tAt(
	lng: Locale,
	ns: I18nNamespace,
	key: string,
	vars?: Record<string, string | number>,
): string | undefined {
	if (!i18next.exists(key, { lng, ns })) return undefined;
	const result = i18next.t(key, { lng, ns, ...vars });
	return typeof result === "string" ? result : undefined;
}

export function getAvailableLocales(): Locale[] {
	return availableLocales.length > 0 ? availableLocales : [DEFAULT_LOCALE];
}

export function getLocaleName(locale: Locale): string {
	return tAt(locale, "common", "locale.name") ?? locale;
}

export function getLocaleShort(locale: Locale): string {
	return tAt(locale, "common", "locale.short") ?? locale;
}

export function translate(
	locale: Locale,
	namespace: I18nNamespace,
	key: string,
	vars?: Record<string, string | number>,
): string {
	return tAt(locale, namespace, key, vars) ?? `${namespace}.${key}`;
}
