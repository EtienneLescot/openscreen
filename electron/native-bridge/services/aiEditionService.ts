import { documentSchema } from "../../../src/lib/ai-edition/schema";
import type {
	AiEditionAssetResult,
	AiEditionChatBudget,
	AiEditionChatCompactResult,
	AiEditionChatMessage,
	AiEditionChatResult,
	AiEditionChatSession,
	AiEditionChatSessionSummary,
	AiEditionDeviceChallenge,
	AiEditionDeviceCompletionResult,
	AiEditionDocumentResult,
	AiEditionLlmConfig,
	AiEditionLlmDisconnectResult,
	AiEditionLlmSnapshot,
	AiEditionProjectSummary,
} from "../../../src/native/contracts";
import { compactSession, getSessionBudget } from "../../ai-edition/chat-service";
import type { DocumentService } from "../../ai-edition/document-service";
import type { LlmConfigStore, LlmCredential } from "../../ai-edition/llm-config-store";
import {
	beginCodexDeviceAuth,
	beginGithubDeviceAuth,
	completeCodexDeviceAuth,
	completeGithubDeviceAuth,
	listAnthropicModels,
	listGithubCopilotModels,
	listGoogleModels,
	listMistralModels,
	listOpenAiAccountModels,
	listOpenAiCompatibleModels,
	listOpenRouterModels,
	probeMiniMaxModels,
} from "../../ai-edition/llm-provider-auth";
import { PROVIDER_DEFINITIONS } from "../../ai-edition/provider-registry";

export interface AiEditionServiceOptions {
	documents: DocumentService;
	llmConfig: LlmConfigStore;
	runChat: (
		projectId: string,
		sessionId: string,
		message: string,
		document?: unknown,
	) => Promise<AiEditionChatResult>;
	runChatDefault: (projectId: string, message: string) => Promise<AiEditionChatResult>;
	undoLastToolBatch: (projectId: string, sessionId: string) => AiEditionChatResult;
	getDefaultChatHistory: (projectId: string) => AiEditionChatMessage[];
	clearDefaultChatHistory: (projectId: string) => void;
	listSessions: (projectId: string) => AiEditionChatSessionSummary[];
	createSession: (projectId: string, title?: string) => AiEditionChatSessionSummary;
	selectSession: (projectId: string, sessionId: string) => AiEditionChatSession | null;
	renameSession: (
		projectId: string,
		sessionId: string,
		title: string,
	) => AiEditionChatSessionSummary | null;
	deleteSession: (projectId: string, sessionId: string) => boolean;
}

export class AiEditionService {
	constructor(private readonly options: AiEditionServiceOptions) {}

	async listProjects(): Promise<AiEditionProjectSummary[]> {
		return this.options.documents.listProjects();
	}

	async get(projectId: string): Promise<AiEditionDocumentResult> {
		try {
			const document = await this.options.documents.getProject(projectId);
			return { success: true, document };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async create(title?: string): Promise<AiEditionDocumentResult> {
		try {
			const document = await this.options.documents.createProject(title ?? "");
			return { success: true, document };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async save(document: unknown): Promise<AiEditionDocumentResult> {
		try {
			const parsed = documentSchema.parse(document);
			const saved = await this.options.documents.saveProject(parsed);
			return { success: true, document: saved };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async deleteProject(projectId: string): Promise<AiEditionDocumentResult> {
		try {
			await this.options.documents.deleteProject(projectId);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async addAsset(projectId: string, path: string, label?: string): Promise<AiEditionAssetResult> {
		const document = await this.options.documents.addAsset(projectId, { path, label });
		const assetId = document.project.primaryAssetId ?? document.assets.at(-1)?.id ?? "";
		return { assetId, document };
	}

	async removeAsset(projectId: string, assetId: string): Promise<AiEditionAssetResult> {
		const document = await this.options.documents.removeAsset(projectId, assetId);
		return { assetId, document };
	}

	async llmGetSnapshot(): Promise<AiEditionLlmSnapshot> {
		const config = this.options.llmConfig.getConfig();
		const credentialSummary: AiEditionLlmSnapshot["credentialSummary"] = [];
		const connectedProviders: string[] = [];
		for (const def of PROVIDER_DEFINITIONS) {
			const resolved = this.options.llmConfig.getCredential(def.id, def.envKeys);
			const connected = Boolean(resolved);
			if (connected) connectedProviders.push(def.id);
			credentialSummary.push({
				providerId: def.id,
				connected,
				authKind: def.authKind,
				credentialKind: resolved ? resolved.entry.kind : null,
			});
		}
		return {
			config,
			connectedProviders,
			availableProviders: PROVIDER_DEFINITIONS.map((d) => ({
				id: d.id,
				label: d.label,
				authKind: d.authKind,
			})),
			credentialSummary,
		};
	}

	async llmSetConfig(config: AiEditionLlmConfig): Promise<AiEditionDocumentResult> {
		try {
			await this.options.llmConfig.setConfig(config);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async llmSetApiKey(providerId: string, apiKey: string): Promise<AiEditionDocumentResult> {
		try {
			const entry: LlmCredential = { kind: "api-key", apiKey };
			await this.options.llmConfig.setCredential(providerId, entry);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async llmRemoveApiKey(providerId: string): Promise<AiEditionDocumentResult> {
		try {
			await this.options.llmConfig.removeCredential(providerId);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async llmBeginDeviceAuth(
		providerId: "openai-oauth" | "copilot-proxy",
		_model?: string,
	): Promise<AiEditionDeviceChallenge> {
		if (providerId === "openai-oauth") {
			return await beginCodexDeviceAuth();
		}
		if (providerId === "copilot-proxy") {
			return await beginGithubDeviceAuth();
		}
		throw new Error(`Provider ${providerId} does not support device flow.`);
	}

	async llmCompleteDeviceAuth(
		providerId: "openai-oauth" | "copilot-proxy",
		challenge: AiEditionDeviceChallenge,
		model?: string,
	): Promise<AiEditionDeviceCompletionResult> {
		try {
			if (providerId === "openai-oauth") {
				const tokens = await completeCodexDeviceAuth({
					deviceAuthId: challenge.deviceAuthId ?? "",
					userCode: challenge.userCode,
					intervalMs: challenge.intervalMs,
					expiresAt: challenge.expiresAt,
				});
				const entry: LlmCredential = {
					kind: "codex",
					apiKey: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					accountId: tokens.accountId,
					expiresAt: tokens.expiresAt,
				};
				await this.options.llmConfig.setCredential(providerId, entry);
			} else if (providerId === "copilot-proxy") {
				const token = await completeGithubDeviceAuth({
					deviceCode: challenge.deviceCode ?? "",
					userCode: challenge.userCode,
					intervalMs: challenge.intervalMs,
					expiresAt: challenge.expiresAt,
				});
				const entry: LlmCredential = { kind: "github-device", apiKey: token };
				await this.options.llmConfig.setCredential(providerId, entry);
			} else {
				throw new Error(`Provider ${providerId} does not support device flow.`);
			}

			// Persist the selected model so the chat path knows which model to use.
			const existing = this.options.llmConfig.getConfig();
			if (model && (!existing || existing.provider !== providerId)) {
				await this.options.llmConfig.setConfig({
					provider: providerId,
					model,
					baseUrl: existing?.provider === providerId ? existing.baseUrl : undefined,
					reasoningEffort: existing?.provider === providerId ? existing.reasoningEffort : undefined,
				});
			} else if (!existing) {
				const def = PROVIDER_DEFINITIONS.find((d) => d.id === providerId);
				if (def) {
					await this.options.llmConfig.setConfig({
						provider: providerId,
						model: def.defaultModel,
					});
				}
			}
			return { success: true, snapshot: await this.llmGetSnapshot() };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async llmDisconnect(providerId: string): Promise<AiEditionLlmDisconnectResult> {
		await this.options.llmConfig.removeCredential(providerId);
		const active = this.options.llmConfig.getConfig();
		if (active?.provider === providerId) {
			await this.options.llmConfig.setConfig({
				provider: "",
				model: "",
			});
		}
		return { success: true, snapshot: await this.llmGetSnapshot() };
	}

	async llmListProviderModels(providerId: string): Promise<{ models: string[]; error?: string }> {
		try {
			if (providerId === "openai-oauth") {
				const cred = this.options.llmConfig.getCredential(providerId, []);
				if (!cred) return { models: [], error: "Not connected" };
				const models = await listOpenAiAccountModels(cred.value);
				return { models };
			}
			if (providerId === "copilot-proxy") {
				const cred = this.options.llmConfig.getCredential(providerId, []);
				if (!cred) return { models: [], error: "Not connected" };
				const models = await listGithubCopilotModels(cred.value);
				return { models };
			}
			const def = PROVIDER_DEFINITIONS.find((d) => d.id === providerId);
			if (!def) return { models: [], error: `Unknown provider ${providerId}` };
			const cred = this.options.llmConfig.getCredential(providerId, def.envKeys);
			if (!cred) return { models: [], error: "Not connected" };
			const config = this.options.llmConfig.getConfig();
			const baseUrl = (config?.provider === providerId ? config.baseUrl : undefined) ?? def.baseUrl;

			if (providerId === "anthropic") {
				return { models: await listAnthropicModels(cred.value) };
			}
			if (providerId === "google") {
				return { models: await listGoogleModels(cred.value) };
			}
			if (providerId === "mistral") {
				return { models: await listMistralModels(cred.value) };
			}
			if (providerId === "openrouter") {
				return { models: await listOpenRouterModels() };
			}
			if (providerId === "minimax" || providerId === "minimax-token-plan") {
				return { models: await probeMiniMaxModels(cred.value, baseUrl) };
			}
			if (providerId === "openai" || providerId === "openai-compatible") {
				if (!baseUrl) return { models: [], error: "Missing base URL" };
				return { models: await listOpenAiCompatibleModels(baseUrl, cred.value) };
			}
			return { models: [], error: `Provider ${providerId} does not expose a dynamic model list` };
		} catch (error) {
			return { models: [], error: error instanceof Error ? error.message : String(error) };
		}
	}

	async chatRun(
		projectId: string,
		sessionId: string,
		message: string,
		document?: unknown,
	): Promise<AiEditionChatResult> {
		return this.options.runChat(projectId, sessionId, message, document);
	}

	chatUndoLastBatch(projectId: string, sessionId: string): AiEditionChatResult {
		return this.options.undoLastToolBatch(projectId, sessionId);
	}

	async chatRunDefault(projectId: string, message: string): Promise<AiEditionChatResult> {
		return this.options.runChatDefault(projectId, message);
	}

	chatHistoryDefault(projectId: string): AiEditionChatMessage[] {
		return this.options.getDefaultChatHistory(projectId);
	}

	chatClearDefault(projectId: string): { success: boolean } {
		this.options.clearDefaultChatHistory(projectId);
		return { success: true };
	}

	chatListSessions(projectId: string): AiEditionChatSessionSummary[] {
		return this.options.listSessions(projectId);
	}

	chatCreateSession(projectId: string, title?: string): AiEditionChatSessionSummary {
		return this.options.createSession(projectId, title);
	}

	chatSelectSession(projectId: string, sessionId: string): AiEditionChatSession | null {
		return this.options.selectSession(projectId, sessionId);
	}

	chatRenameSession(
		projectId: string,
		sessionId: string,
		title: string,
	): AiEditionChatSessionSummary | null {
		return this.options.renameSession(projectId, sessionId, title);
	}

	chatDeleteSession(projectId: string, sessionId: string): { success: boolean } {
		return { success: this.options.deleteSession(projectId, sessionId) };
	}

	chatMessages(projectId: string, sessionId: string): AiEditionChatMessage[] {
		const session = this.options.selectSession(projectId, sessionId);
		return session?.messages ?? [];
	}

	chatBudget(projectId: string, sessionId: string): AiEditionChatBudget | null {
		return getSessionBudget(projectId, sessionId);
	}

	async chatCompact(
		projectId: string,
		sessionId: string,
	): Promise<AiEditionChatCompactResult | null> {
		const result = await compactSession(projectId, sessionId, this.options.llmConfig);
		if (!result) return null;
		const session = this.options.selectSession(projectId, sessionId);
		if (!session) return null;
		return {
			session,
			summaryMessageId: result.summaryMessageId,
			summary: result.summary,
		};
	}
}
