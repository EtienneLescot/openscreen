// ponytail: the ONLY file in the repository allowed to name the workbench
// environment variables. Everything else asks this module.
//
// The key reaches the process through `node --env-file=.env.workbench` (native
// since Node 20; this worktree runs v22). No dotenv, no hand-rolled parser, no
// second source. `.env.workbench` is written by the user and gitignored.
//
// Hard rule, no exceptions: the workbench NEVER reads the operating system's
// credential store, in any of its forms — not the app's encrypted store, not
// the platform keychain, not the per-user application data directory.
// `workbench/scenarios/contract.wb.ts` holds the enforced ban list and applies
// it to every file under `workbench/`; it is deliberately the only place in the
// repository that spells those names out.

/** Env var names, in one place so the ban-list test can quote them. */
export const ENV_KEYS = {
	apiKey: "OPENSCREEN_WORKBENCH_API_KEY",
	baseUrl: "OPENSCREEN_WORKBENCH_BASE_URL",
	model: "OPENSCREEN_WORKBENCH_MODEL",
} as const;

export interface LiveEnv {
	model: string;
	baseUrl: string;
	apiKey: string;
}

function readVar(name: string): string | null {
	const raw = process.env[name];
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * ponytail: hard, named failure. Both missing-variable paths fail SILENTLY and
 * dangerously downstream, which is why this throws instead of defaulting:
 *   • no baseUrl — `chat-model.ts:412-417` has no fallback and omits
 *     `configuration` entirely, so ChatOpenAI targets api.openai.com and the
 *     Deepseek key would be shipped to a third party;
 *   • no apiKey — `chat-model.ts:319-322` substitutes the no-auth placeholder
 *     and the resulting 401 surfaces as "Empty response from model", blaming
 *     the provider for a configuration mistake.
 */
export function requireLiveEnv(): LiveEnv {
	const apiKey = readVar(ENV_KEYS.apiKey);
	const baseUrl = readVar(ENV_KEYS.baseUrl);
	const model = readVar(ENV_KEYS.model);
	for (const [name, value] of [
		[ENV_KEYS.apiKey, apiKey],
		[ENV_KEYS.baseUrl, baseUrl],
		[ENV_KEYS.model, model],
	] as const) {
		if (!value) {
			throw new Error(
				`${name} manquant — ajoutez-le à .env.workbench à la racine du worktree, ` +
					"puis lancez le workbench via `node --env-file=.env.workbench`.",
			);
		}
	}
	// The three nulls are excluded by the loop above; the casts keep `strict` happy
	// without re-reading process.env.
	return { apiKey: apiKey as string, baseUrl: baseUrl as string, model: model as string };
}

/** True when all three variables are present — lets a suite skip cleanly. */
export function hasLiveEnv(): boolean {
	return Boolean(readVar(ENV_KEYS.apiKey) && readVar(ENV_KEYS.baseUrl) && readVar(ENV_KEYS.model));
}

/** The only diagnostic this module will ever emit about the key. */
export function describeLiveEnv(): string {
	const env = requireLiveEnv();
	return `model=${env.model} baseUrl=${env.baseUrl} key length ${env.apiKey.length}`;
}

/**
 * True when `payload` carries the API key verbatim, an `Authorization: Bearer`
 * header, or an `sk-`-style token. Used as a write barrier by `report.ts` and
 * the cassette writer — never as a sanitizer, because a payload that trips this
 * is refused rather than scrubbed.
 */
export function containsSecret(payload: string): boolean {
	const key = readVar(ENV_KEYS.apiKey);
	if (key && key.length >= 8 && payload.includes(key)) return true;
	if (/Bearer\s+\S+/i.test(payload)) return true;
	if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(payload)) return true;
	return false;
}

/** Replaces every occurrence of the key with `REDACTED`. Defence in depth. */
export function redactSecret(payload: string): string {
	const key = readVar(ENV_KEYS.apiKey);
	let out = payload;
	if (key && key.length >= 8) out = out.split(key).join("REDACTED");
	out = out.replace(/Bearer\s+\S+/gi, "Bearer REDACTED");
	return out.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "REDACTED");
}
