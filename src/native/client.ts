import {
	type AiEditionAssetResult,
	type AiEditionChatMessage,
	type AiEditionChatResult,
	type AiEditionDocumentResult,
	type AiEditionLlmConfig,
	type AiEditionLlmSnapshot,
	type AiEditionProjectSummary,
	type CursorCapabilities,
	type CursorRecordingData,
	type CursorTelemetryPoint,
	NATIVE_BRIDGE_CHANNEL,
	type NativeBridgeRequest,
	type NativeBridgeResponse,
	type NativePlatform,
	type ProjectContext,
	type ProjectFileResult,
	type ProjectPathResult,
	type SystemCapabilities,
} from "./contracts";

function createRequestId() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}

	return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getElectronBridge() {
	if (!window.electronAPI?.invokeNativeBridge) {
		throw new Error(
			`Native bridge unavailable. Expected ${NATIVE_BRIDGE_CHANNEL} transport in preload.`,
		);
	}

	return window.electronAPI.invokeNativeBridge;
}

export async function invokeNativeBridge<TData = unknown>(
	request: NativeBridgeRequest,
): Promise<NativeBridgeResponse<TData>> {
	const invoke = getElectronBridge();
	return invoke({
		...request,
		requestId: request.requestId ?? createRequestId(),
	});
}

export async function requireNativeBridgeData<TData>(request: NativeBridgeRequest): Promise<TData> {
	const response = await invokeNativeBridge<TData>(request);
	if (!response.ok) {
		throw new Error(response.error.message);
	}

	return response.data;
}

export const nativeBridgeClient = {
	rawInvoke: invokeNativeBridge,
	system: {
		getPlatform: () =>
			requireNativeBridgeData<NativePlatform>({
				domain: "system",
				action: "getPlatform",
			}),
		getAssetBasePath: () =>
			requireNativeBridgeData<string | null>({
				domain: "system",
				action: "getAssetBasePath",
			}),
		getCapabilities: () =>
			requireNativeBridgeData<SystemCapabilities>({
				domain: "system",
				action: "getCapabilities",
			}),
	},
	project: {
		getCurrentContext: () =>
			requireNativeBridgeData<ProjectContext>({
				domain: "project",
				action: "getCurrentContext",
			}),
		saveProjectFile: (projectData: unknown, suggestedName?: string, existingProjectPath?: string) =>
			requireNativeBridgeData<ProjectFileResult>({
				domain: "project",
				action: "saveProjectFile",
				payload: {
					projectData,
					suggestedName,
					existingProjectPath,
				},
			}),
		loadProjectFile: (projectFolder?: string) =>
			requireNativeBridgeData<ProjectFileResult>({
				domain: "project",
				action: "loadProjectFile",
				payload: { projectFolder },
			}),
		loadCurrentProjectFile: () =>
			requireNativeBridgeData<ProjectFileResult>({
				domain: "project",
				action: "loadCurrentProjectFile",
			}),
		loadProjectFileFromPath: (path: string) =>
			requireNativeBridgeData<ProjectFileResult>({
				domain: "project",
				action: "loadProjectFileFromPath",
				payload: { path },
			}),
		setCurrentVideoPath: (path: string) =>
			requireNativeBridgeData<ProjectPathResult>({
				domain: "project",
				action: "setCurrentVideoPath",
				payload: { path },
			}),
		getCurrentVideoPath: () =>
			requireNativeBridgeData<ProjectPathResult>({
				domain: "project",
				action: "getCurrentVideoPath",
			}),
		clearCurrentVideoPath: () =>
			requireNativeBridgeData<ProjectPathResult>({
				domain: "project",
				action: "clearCurrentVideoPath",
			}),
	},
	cursor: {
		getCapabilities: () =>
			requireNativeBridgeData<CursorCapabilities>({
				domain: "cursor",
				action: "getCapabilities",
			}),
		getRecordingData: (videoPath?: string) =>
			requireNativeBridgeData<CursorRecordingData>({
				domain: "cursor",
				action: "getRecordingData",
				payload: videoPath ? { videoPath } : {},
			}),
		getTelemetry: (videoPath?: string) =>
			requireNativeBridgeData<CursorTelemetryPoint[]>({
				domain: "cursor",
				action: "getTelemetry",
				payload: videoPath ? { videoPath } : {},
			}),
	},
	aiEdition: {
		listProjects: () =>
			requireNativeBridgeData<AiEditionProjectSummary[]>({
				domain: "aiEdition",
				action: "document.listProjects",
			}),
		get: (projectId: string) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "document.get",
				payload: { projectId },
			}),
		create: (title?: string) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "document.create",
				payload: { title },
			}),
		save: (document: unknown) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "document.save",
				payload: { document },
			}),
		delete: (projectId: string) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "document.delete",
				payload: { projectId },
			}),
		addAsset: (projectId: string, path: string, label?: string) =>
			requireNativeBridgeData<AiEditionAssetResult>({
				domain: "aiEdition",
				action: "document.addAsset",
				payload: { projectId, path, label },
			}),
		removeAsset: (projectId: string, assetId: string) =>
			requireNativeBridgeData<AiEditionAssetResult>({
				domain: "aiEdition",
				action: "document.removeAsset",
				payload: { projectId, assetId },
			}),
		llmGetSnapshot: () =>
			requireNativeBridgeData<AiEditionLlmSnapshot>({
				domain: "aiEdition",
				action: "llm.getSnapshot",
			}),
		llmSetConfig: (config: AiEditionLlmConfig) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "llm.setConfig",
				payload: { config },
			}),
		llmSetApiKey: (providerId: string, apiKey: string) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "llm.setApiKey",
				payload: { providerId, apiKey },
			}),
		llmRemoveApiKey: (providerId: string) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "llm.removeApiKey",
				payload: { providerId },
			}),
		chatRun: (projectId: string, message: string) =>
			requireNativeBridgeData<AiEditionChatResult>({
				domain: "aiEdition",
				action: "chat.run",
				payload: { projectId, message },
			}),
		chatHistory: (projectId: string) =>
			requireNativeBridgeData<AiEditionChatMessage[]>({
				domain: "aiEdition",
				action: "chat.history",
				payload: { projectId },
			}),
		chatClear: (projectId: string) =>
			requireNativeBridgeData<{ success: boolean }>({
				domain: "aiEdition",
				action: "chat.clear",
				payload: { projectId },
			}),
	},
};
