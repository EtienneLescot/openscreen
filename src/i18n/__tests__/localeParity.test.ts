// Every locale must define every key `en` defines.
//
// The loader silently falls back to `en` for a missing key (see `translate` in
// `../loader.ts`), so an untranslated block doesn't crash — it just renders in
// English forever. That is exactly how the whole `settings.captions` pane
// shipped English-only in 11 locales. A per-feature test with a hand-written key
// list can't catch the next one; this walks the files instead.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `import.meta.url` isn't a file: URL under the test environment's transform.
const LOCALES_DIR = resolve(process.cwd(), "src/i18n/locales");
const REFERENCE_LOCALE = "en";

function flatten(value: unknown, prefix = ""): string[] {
	if (value == null || typeof value !== "object" || Array.isArray(value))
		return [prefix.slice(0, -1)];
	return Object.entries(value).flatMap(([key, child]) => flatten(child, `${prefix}${key}.`));
}

function keysOf(locale: string, namespace: string): string[] {
	return flatten(JSON.parse(readFileSync(`${LOCALES_DIR}/${locale}/${namespace}`, "utf8")));
}

const namespaces = readdirSync(`${LOCALES_DIR}/${REFERENCE_LOCALE}`).filter((f) =>
	f.endsWith(".json"),
);
const locales = readdirSync(LOCALES_DIR).filter((l) => l !== REFERENCE_LOCALE);

describe("locale parity", () => {
	it.each(locales)("%s defines every key en defines", (locale) => {
		const missing = namespaces.flatMap((namespace) => {
			const translated = new Set(keysOf(locale, namespace));
			return keysOf(REFERENCE_LOCALE, namespace)
				.filter((key) => !translated.has(key))
				.map((key) => `${namespace.replace(".json", "")}.${key}`);
		});
		expect(missing).toEqual([]);
	});
});
