import { documentSchema } from "../../../src/lib/ai-edition/schema";
import type {
	AiEditionAssetResult,
	AiEditionChatMessage,
	AiEditionChatResult,
	AiEditionDocumentResult,
	AiEditionLlmConfig,
	AiEditionLlmSnapshot,
	AiEditionProjectSummary,
} from "../../../src/native/contracts";
import type { DocumentService } from "../../ai-edition/document-service";
import type { LlmConfigStore } from "../../ai-edition/llm-config-store";
import { PROVIDER_DEFINITIONS } from "../../ai-edition/provider-registry";

export interface AiEditionServiceOptions {
	documents: DocumentService;
	llmConfig: LlmConfigStore;
	runChat: (projectId: string, message: string) => Promise<AiEditionChatResult>;
	getChatHistory: (projectId: string) => Promise<AiEditionChatMessage[]>;
	clearChatHistory: (projectId: string) => void;
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
		const connectedProviders: string[] = [];
		for (const def of PROVIDER_DEFINITIONS) {
			const key = this.options.llmConfig.getApiKey(def.id, def.envKeys);
			if (key) connectedProviders.push(def.id);
		}
		return {
			config,
			connectedProviders,
			availableProviders: PROVIDER_DEFINITIONS.map((d) => ({
				id: d.id,
				label: d.label,
				authKind: d.authKind,
			})),
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
			await this.options.llmConfig.setApiKey(providerId, apiKey);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async llmRemoveApiKey(providerId: string): Promise<AiEditionDocumentResult> {
		try {
			await this.options.llmConfig.removeApiKey(providerId);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async chatRun(projectId: string, message: string): Promise<AiEditionChatResult> {
		return this.options.runChat(projectId, message);
	}

	async chatHistory(projectId: string): Promise<AiEditionChatMessage[]> {
		return this.options.getChatHistory(projectId);
	}

	async chatClear(projectId: string): Promise<{ success: boolean }> {
		this.options.clearChatHistory(projectId);
		return { success: true };
	}
}
