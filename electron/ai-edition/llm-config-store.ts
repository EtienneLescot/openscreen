// LLM credential + config storage using Electron's safeStorage (OS keychain).
// Per locked decision 4: no plain JSON for credentials.
//
// ponytail: the config (provider, model, baseUrl, reasoningEffort) lives in
// a plain JSON file; the API keys live in safeStorage-encrypted bytes. Env
// vars override stored keys (same precedence as axcut).

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

export interface LlmCredentials {
	[providerId: string]: string;
}

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
				this.credentials = JSON.parse(decrypted);
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

	getApiKey(providerId: string, envKeys: string[]): string | null {
		for (const envKey of envKeys) {
			const envValue = process.env[envKey];
			if (envValue) return envValue;
		}
		return this.credentials[providerId] ?? null;
	}

	async setApiKey(providerId: string, apiKey: string): Promise<void> {
		this.credentials[providerId] = apiKey;
		await this.saveCredentials();
	}

	async removeApiKey(providerId: string): Promise<void> {
		delete this.credentials[providerId];
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
