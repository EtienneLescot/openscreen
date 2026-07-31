// ponytail: the security guard of the whole workbench, deliberately written
// before any measurement code. An earlier agent reached the user's credential
// store and left junk entries in their keychain; that route is closed by test,
// not by good intentions.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { containsSecret, ENV_KEYS, redactSecret, requireLiveEnv } from "../lib/env";

const WORKBENCH_ROOT = resolve(__dirname, "..");

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === ".build" || entry === "node_modules" || entry === "reports") continue;
			out.push(...listTsFiles(full));
			continue;
		}
		if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}

// Every route an agent has been tempted by, or could be.
//
// The credential store gets a narrower rule than the rest: `harness.ts` and
// `runner.ts` legitimately do `import type { LlmConfigStore }`, which
// TypeScript ERASES, so the module — and the `safeStorage` import on its line
// 13 — is never resolved at runtime. The pattern therefore targets a real
// import STATEMENT that is not type-only, and leaves prose references alone.
const BANNED: Array<{ label: string; pattern: RegExp }> = [
	{ label: "safeStorage", pattern: /safeStorage/ },
	{ label: "llm-credentials", pattern: /llm-credentials/ },
	{ label: "Application Support", pattern: /Application Support/ },
	{ label: "~/Library", pattern: /~\/Library|Library\/Keychains/ },
	{ label: "app.setName", pattern: /app\.setName/ },
	{ label: "security find-generic-password", pattern: /find-generic-password/ },
	{
		label: "value import of llm-config-store",
		pattern: /^\s*import\s+(?!type\b)[^\n]*llm-config-store/m,
	},
	{
		label: "runtime require of llm-config-store",
		pattern: /require\(\s*["'][^"']*llm-config-store/,
	},
];

describe("workbench credential contract", () => {
	const files = listTsFiles(WORKBENCH_ROOT).filter((f) => !f.endsWith("contract.wb.ts"));

	it("finds the workbench sources it is supposed to police", () => {
		expect(files.length).toBeGreaterThan(5);
	});

	it("no workbench source can reach the credential store", () => {
		const offences: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const { label, pattern } of BANNED) {
				if (pattern.test(source)) {
					offences.push(`${file.slice(WORKBENCH_ROOT.length + 1)} → ${label}`);
				}
			}
		}
		expect(offences).toEqual([]);
	});

	it("the credential-store rule still catches a real value import", () => {
		// The rule is narrowed to spare `import type`, so it has to be shown that
		// it still bites — a guard nobody has seen fail is not a guard.
		const rule = BANNED.find((b) => b.label === "value import of llm-config-store");
		if (!rule) throw new Error("the credential-store rule vanished from BANNED");
		expect(
			rule.pattern.test(
				'import { LlmConfigStore } from "../../electron/ai-edition/llm-config-store";',
			),
		).toBe(true);
		expect(
			rule.pattern.test('import LlmConfigStore from "../../electron/ai-edition/llm-config-store";'),
		).toBe(true);
		expect(
			rule.pattern.test(
				'import type { LlmConfigStore } from "../../electron/ai-edition/llm-config-store";',
			),
		).toBe(false);
		expect(rule.pattern.test("// see llm-config-store.ts:13 for the safeStorage import")).toBe(
			false,
		);
	});

	it("only env.ts names the workbench environment variables", () => {
		const names = Object.values(ENV_KEYS);
		const offenders = files
			.filter((f) => !f.endsWith(`lib${sep}env.ts`))
			.filter((f) => {
				const source = readFileSync(f, "utf8");
				return names.some((n) => source.includes(n));
			});
		expect(offenders.map((f) => f.slice(WORKBENCH_ROOT.length + 1))).toEqual([]);
	});

	it("requireLiveEnv fails loudly rather than falling back to another source", () => {
		const saved = process.env[ENV_KEYS.apiKey];
		process.env[ENV_KEYS.apiKey] = "";
		try {
			expect(() => requireLiveEnv()).toThrow(/OPENSCREEN_WORKBENCH_API_KEY manquant/);
		} finally {
			if (saved === undefined) delete process.env[ENV_KEYS.apiKey];
			else process.env[ENV_KEYS.apiKey] = saved;
		}
	});

	it("containsSecret catches the key, bearer headers and sk- tokens", () => {
		const saved = process.env[ENV_KEYS.apiKey];
		process.env[ENV_KEYS.apiKey] = "wb-not-a-real-key-0123456789";
		try {
			expect(containsSecret("prefix wb-not-a-real-key-0123456789 suffix")).toBe(true);
			expect(containsSecret("authorization: Bearer abc.def")).toBe(true);
			expect(containsSecret("sk-abcdefghijklmnop")).toBe(true);
			expect(containsSecret("a perfectly ordinary report line")).toBe(false);
			expect(redactSecret("x wb-not-a-real-key-0123456789 y")).toBe("x REDACTED y");
		} finally {
			if (saved === undefined) delete process.env[ENV_KEYS.apiKey];
			else process.env[ENV_KEYS.apiKey] = saved;
		}
	});
});
