// LLM credential + config storage using Electron's safeStorage (OS keychain).
// Per locked decision 4: no plain JSON for credentials.
//
// The shape of the encrypted credentials blob changed from
// `{ [providerId]: string }` to a typed entry per provider so OAuth
// sessions (refresh tokens, account ids, expiries) can ride along with
// plain API keys. Existing single-string rows (pre-OAuth) keep working:
// the loader coerces them to `{ kind: "api-key", apiKey }`.

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";

export interface LlmConfig {
	provider: string;
	model: string;
	baseUrl?: string;
	reasoningEffort?: string;
	/** P2.5 — when false, the agent's write tools are refused and the model is
	 * told to ask the user for confirmation. Undefined means enabled. */
	allowAgentEdits?: boolean;
}

export type LlmCredentialKind = "api-key" | "codex" | "github-device" | "github-pat";

export interface ApiKeyCredential {
	kind: "api-key";
	apiKey: string;
}

export interface CodexCredential {
	kind: "codex";
	apiKey: string; // access token
	refreshToken?: string;
	accountId?: string;
	expiresAt?: number;
}

export interface GithubDeviceCredential {
	kind: "github-device";
	apiKey: string; // github pat/secondary token
	accountLogin?: string;
	expiresAt?: number;
}

export interface GithubPatCredential {
	kind: "github-pat";
	apiKey: string; // user-pasted GitHub PAT
}

export type LlmCredential =
	| ApiKeyCredential
	| CodexCredential
	| GithubDeviceCredential
	| GithubPatCredential;

export type LlmCredentials = { [providerId: string]: LlmCredential | string };

export class LlmConfigStore {
	private readonly configPath: string;
	private readonly credentialsPath: string;
	private config: LlmConfig | null = null;
	private credentials: LlmCredentials = {};

	constructor(userDataPath: string) {
		this.configPath = path.join(userDataPath, "llm-config.json");
		this.credentialsPath = path.join(userDataPath, "llm-credentials.enc");
		this.loadSync();
	}

	private loadSync(): void {
		try {
			const raw = readFileSync(this.configPath, "utf8");
			this.config = JSON.parse(raw);
		} catch {
			this.config = null;
		}
		try {
			const encrypted = readFileSync(this.credentialsPath);
			if (safeStorage.isEncryptionAvailable()) {
				const decrypted = safeStorage.decryptString(encrypted);
				this.credentials = JSON.parse(decrypted) as LlmCredentials;
			}
		} catch {
			this.credentials = {};
		}
	}

	async load(): Promise<void> {
		this.loadSync();
	}

	getConfig(): LlmConfig | null {
		return this.config;
	}

	async setConfig(config: LlmConfig): Promise<void> {
		this.config = config;
		await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), "utf8");
	}

	/**
	 * Resolves the effective credential for a provider, normalizing older
	 * string-only rows to a typed entry. Returns `null` when no credential
	 * is available (env vars are the caller's responsibility).
	 */
	getCredential(
		providerId: string,
		envKeys: string[] = [],
	): { value: string; entry: LlmCredential } | null {
		for (const envKey of envKeys) {
			const envValue = process.env[envKey];
			if (envValue) {
				const entry: ApiKeyCredential = { kind: "api-key", apiKey: envValue };
				return { value: envValue, entry };
			}
		}
		const stored = this.credentials[providerId];
		if (!stored) return null;
		if (typeof stored === "string") {
			return { value: stored, entry: { kind: "api-key", apiKey: stored } };
		}
		if (
			stored.kind === "api-key" ||
			stored.kind === "codex" ||
			stored.kind === "github-device" ||
			stored.kind === "github-pat"
		) {
			return { value: stored.apiKey, entry: stored };
		}
		return null;
	}

	/** Back-compat helper used by the chat routing path. Returns just the
	 * usable bearer string (any env var OR stored entry). */
	getApiKey(providerId: string, envKeys: string[] = []): string | null {
		return this.getCredential(providerId, envKeys)?.value ?? null;
	}

	/**
	 * Write a typed credential entry for the given provider. Used by both
	 * the API-key form (kind = "api-key") and device-flow completion
	 * (kind = "codex" / "github-device"). Pass an empty `apiKey` to clear.
	 */
	async setCredential(providerId: string, entry: LlmCredential): Promise<void> {
		if (!entry.apiKey) {
			delete this.credentials[providerId];
		} else {
			this.credentials[providerId] = entry;
		}
		await this.saveCredentials();
	}

	async removeCredential(providerId: string): Promise<void> {
		delete this.credentials[providerId];
		await this.saveCredentials();
	}

	/**
	 * Convenience: clear every credential and forget the active provider
	 * from `LlmConfig` (caller's job). Used by `llmDisconnect` in the IPC service.
	 */
	async clearAll(): Promise<void> {
		this.credentials = {};
		await this.saveCredentials();
	}

	private async saveCredentials(): Promise<void> {
		if (!safeStorage.isEncryptionAvailable()) {
			throw new Error("safeStorage is not available on this platform.");
		}
		const encrypted = safeStorage.encryptString(JSON.stringify(this.credentials));
		await fs.writeFile(this.credentialsPath, encrypted);
	}
}
