export const NATIVE_BRIDGE_CHANNEL = "native-bridge:invoke";
export const NATIVE_BRIDGE_VERSION = 1;

export type NativePlatform = "darwin" | "win32" | "linux";
export type CursorProviderKind = "native" | "none";
export type NativeCursorType =
	| "arrow"
	| "text"
	| "pointer"
	| "crosshair"
	| "open-hand"
	| "closed-hand"
	| "resize-ew"
	| "resize-ns"
	| "resize-nesw"
	| "resize-nwse"
	| "move"
	| "not-allowed"
	| "wait"
	| "app-starting"
	| "help"
	| "up-arrow";

export interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
}

export interface CursorRecordingSample extends CursorTelemetryPoint {
	assetId?: string | null;
	visible?: boolean;
	cursorType?: NativeCursorType | null;
	interactionType?: "move" | "click" | "mouseup";
}

export interface NativeCursorAsset {
	id: string;
	platform: NativePlatform;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	scaleFactor?: number;
	cursorType?: NativeCursorType | null;
}

export interface CursorRecordingData {
	version: number;
	provider: CursorProviderKind;
	samples: CursorRecordingSample[];
	assets: NativeCursorAsset[];
}

export interface CursorCapabilities {
	telemetry: boolean;
	systemAssets: boolean;
	provider: CursorProviderKind;
}

export interface SystemCapabilities {
	bridgeVersion: typeof NATIVE_BRIDGE_VERSION;
	platform: NativePlatform;
	cursor: CursorCapabilities;
	project: {
		currentContext: boolean;
	};
}

export interface ProjectContext {
	currentProjectPath: string | null;
	currentVideoPath: string | null;
}

export interface ProjectPathResult {
	success: boolean;
	path?: string;
	message?: string;
	canceled?: boolean;
	error?: string;
}

export interface ProjectFileResult {
	success: boolean;
	path?: string;
	project?: unknown;
	message?: string;
	canceled?: boolean;
	error?: string;
}

// ---- AI Edition domain (Phase 1+) -----------------------------------------
// v3 AxcutDocument projects live under userData/projects/<id>.axcut. Project
// ids are uuid-prefixed strings (e.g. "proj_<uuid>"). Asset ids likewise.

export interface AiEditionProjectSummary {
	id: string;
	title: string;
	updatedAt: string;
	assetCount: number;
}

export interface AiEditionAssetResult {
	assetId: string;
	document: unknown;
}

export interface AiEditionDocumentResult {
	success: boolean;
	document?: unknown;
	error?: string;
}

export interface AiEditionLlmConfig {
	provider: string;
	model: string;
	baseUrl?: string;
	reasoningEffort?: string;
	/** P2.5 — when false, the agent must ask before running write tools.
	 * Undefined means enabled (edits allowed, protected by checkpoints). */
	allowAgentEdits?: boolean;
}

export interface AiEditionLlmSnapshot {
	config: AiEditionLlmConfig | null;
	connectedProviders: string[];
	availableProviders: Array<{ id: string; label: string; authKind: string }>;
}

/** One executed agent tool call, rendered as a compact "applied: …" line in
 * the chat panel (P1.7). */
export interface AiEditionToolCallSummary {
	name: string;
	summary: string;
}

export interface AiEditionChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	createdAt: string;
	toolCalls?: AiEditionToolCallSummary[];
}

export interface AiEditionChatResult {
	success: boolean;
	assistantMessage?: AiEditionChatMessage;
	/** Updated document when the agent ran write tools during this turn. */
	document?: unknown;
	toolCalls?: AiEditionToolCallSummary[];
	error?: string;
}

export interface AiEditionChatSessionSummary {
	id: string;
	projectId: string;
	title: string;
	createdAt: string;
	messageCount: number;
}

export interface AiEditionChatSession {
	id: string;
	projectId: string;
	title: string;
	createdAt: string;
	messages: AiEditionChatMessage[];
}

export type NativeBridgeErrorCode =
	| "INVALID_REQUEST"
	| "UNSUPPORTED_ACTION"
	| "NOT_FOUND"
	| "UNAVAILABLE"
	| "INTERNAL_ERROR";

export interface NativeBridgeError {
	code: NativeBridgeErrorCode;
	message: string;
	retryable: boolean;
}

export interface NativeBridgeMeta {
	version: typeof NATIVE_BRIDGE_VERSION;
	requestId: string;
	timestampMs: number;
}

export interface NativeBridgeSuccess<TData> {
	ok: true;
	data: TData;
	meta: NativeBridgeMeta;
}

export interface NativeBridgeFailure {
	ok: false;
	error: NativeBridgeError;
	meta: NativeBridgeMeta;
}

export type NativeBridgeResponse<TData = unknown> =
	| NativeBridgeSuccess<TData>
	| NativeBridgeFailure;

type EmptyPayload = Record<string, never>;

export type NativeBridgeRequest =
	| {
			domain: "system";
			action: "getPlatform";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "system";
			action: "getAssetBasePath";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "system";
			action: "getCapabilities";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "getCurrentContext";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "saveProjectFile";
			payload: {
				projectData: unknown;
				suggestedName?: string;
				existingProjectPath?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "loadProjectFile";
			payload?: {
				/** Folder to pre-fill the open dialog with, usually the user's
				 * last-opened project folder from userPreferences. */
				projectFolder?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "loadCurrentProjectFile";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "loadProjectFileFromPath";
			payload: { path: string };
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "setCurrentVideoPath";
			payload: {
				path: string;
			};
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "getCurrentVideoPath";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "project";
			action: "clearCurrentVideoPath";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "cursor";
			action: "getCapabilities";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "cursor";
			action: "getTelemetry";
			payload?: {
				videoPath?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "cursor";
			action: "getRecordingData";
			payload?: {
				videoPath?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.listProjects";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.get";
			payload: { projectId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.create";
			payload: { title?: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.save";
			payload: { document: unknown };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.delete";
			payload: { projectId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.addAsset";
			payload: { projectId: string; path: string; label?: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "document.removeAsset";
			payload: { projectId: string; assetId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "llm.getSnapshot";
			payload?: EmptyPayload;
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "llm.setConfig";
			payload: { config: AiEditionLlmConfig };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "llm.setApiKey";
			payload: { providerId: string; apiKey: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "llm.removeApiKey";
			payload: { providerId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.run";
			payload: {
				projectId: string;
				sessionId: string;
				message: string;
				/** Current AxcutDocument snapshot — enables the agent tool loop.
				 * When omitted the chat runs text-only (no tools). */
				document?: unknown;
			};
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.undoLastBatch";
			payload: { projectId: string; sessionId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.runDefault";
			payload: { projectId: string; message: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.history";
			payload: { projectId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.clear";
			payload: { projectId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.listSessions";
			payload: { projectId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.createSession";
			payload: { projectId: string; title?: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.selectSession";
			payload: { projectId: string; sessionId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.renameSession";
			payload: { projectId: string; sessionId: string; title: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.deleteSession";
			payload: { projectId: string; sessionId: string };
			requestId?: string;
	  };

export type NativeBridgeEventName =
	| "project.contextChanged"
	| "cursor.providerChanged"
	| "cursor.telemetryLoaded";

export interface NativeBridgeEvent<TPayload = unknown> {
	name: NativeBridgeEventName;
	payload: TPayload;
	meta: NativeBridgeMeta;
}
