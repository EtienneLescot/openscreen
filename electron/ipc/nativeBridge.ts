import { ipcMain } from "electron";
import type { AiEditionChatEvent } from "../../src/native/contracts";
import {
	NATIVE_BRIDGE_CHANNEL,
	NATIVE_BRIDGE_VERSION,
	type NativeBridgeErrorCode,
	type NativeBridgeRequest,
	type NativeBridgeResponse,
	type NativePlatform,
	type ProjectFileResult,
	type ProjectPathResult,
} from "../../src/native/contracts";
import type { ChatEventSink } from "../ai-edition/chat-service";
import type { DocumentService } from "../ai-edition/document-service";
import type { CursorTelemetryLoadResult } from "../native-bridge/cursor/adapter";
import { TelemetryCursorAdapter } from "../native-bridge/cursor/telemetryCursorAdapter";
import { AiEditionService } from "../native-bridge/services/aiEditionService";
import { CompositorViewService } from "../native-bridge/services/compositorViewService";
import { CursorService } from "../native-bridge/services/cursorService";
import { ProjectService } from "../native-bridge/services/projectService";
import { SystemService } from "../native-bridge/services/systemService";
import { NativeBridgeStateStore } from "../native-bridge/store";

export interface NativeBridgeContext {
	getPlatform: () => NodeJS.Platform;
	getCurrentProjectPath: () => string | null;
	getCurrentVideoPath: () => string | null;
	saveProjectFile: (
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
	) => Promise<ProjectFileResult>;
	loadProjectFile: (projectFolder?: string) => Promise<ProjectFileResult>;
	loadCurrentProjectFile: () => Promise<ProjectFileResult>;
	loadProjectFileFromPath: (path: string) => Promise<ProjectFileResult>;
	setCurrentVideoPath: (path: string) => ProjectPathResult | Promise<ProjectPathResult>;
	getCurrentVideoPathResult: () => ProjectPathResult;
	clearCurrentVideoPath: () => ProjectPathResult;
	resolveAssetBasePath: () => string | null;
	resolveVideoPath: (videoPath?: string | null) => string | null;
	loadCursorRecordingData: (
		videoPath: string,
	) => Promise<import("../../src/native/contracts").CursorRecordingData>;
	loadCursorTelemetry: (videoPath: string) => Promise<CursorTelemetryLoadResult>;
	/**
	 * returns the native (HWND / NSView / xcb_window) handle buffer
	 * for the BrowserWindow that hosts the requesting renderer. Used by the
	 * compositor domain's `createView` to wire the embedded native window
	 * to its D3D11 parent. May return `null` if the sender has no live window
	 * (e.g. mid-teardown), in which case `createView` fails with UNAVAILABLE.
	 */
	getNativeWindowHandle?: (sender: import("electron").WebContents) => Buffer | null;
	getAiEditionDocuments: () => DocumentService;
	getAiEditionLlmConfig: () => import("../ai-edition/llm-config-store").LlmConfigStore;
	runAiEditionChat: (
		projectId: string,
		sessionId: string,
		message: string,
		document?: unknown,
		sink?: ChatEventSink,
	) => Promise<import("../../src/native/contracts").AiEditionChatResult>;
	undoAiEditionToolBatch: (
		projectId: string,
		sessionId: string,
	) => import("../../src/native/contracts").AiEditionChatResult;
	rewindToMessage: (
		projectId: string,
		sessionId: string,
		messageId: string,
	) =>
		| {
				success: true;
				prompt: string;
				document: unknown;
				messages: import("../../src/native/contracts").AiEditionChatMessage[];
		  }
		| { success: false; error: string };
	compactNow: (
		projectId: string,
		sessionId: string,
	) => Promise<import("../../src/native/contracts").AiEditionChatCompactResult | null>;
	runTimelineOperation: (
		projectId: string,
		sessionId: string,
		op: import("../../src/native/contracts").AxcutTimelineOperation,
		conversationMessage: string,
	) => Promise<
		| {
				success: true;
				result: import("../../src/native/contracts").AppliedTimelineOperation;
		  }
		| { success: false; error: string }
	>;
	getContextUsage: (
		projectId: string,
		sessionId: string,
	) => import("../../src/native/contracts").AiEditionChatBudget | null;
	runAiEditionChatDefault: (
		projectId: string,
		message: string,
		sink?: ChatEventSink,
	) => Promise<import("../../src/native/contracts").AiEditionChatResult>;
	getAiEditionChatHistoryDefault: (
		projectId: string,
	) => import("../../src/native/contracts").AiEditionChatMessage[];
	clearAiEditionChatHistoryDefault: (projectId: string) => void;
	listAiEditionChatSessions: (
		projectId: string,
	) => import("../../src/native/contracts").AiEditionChatSessionSummary[];
	createAiEditionChatSession: (
		projectId: string,
		title?: string,
	) => import("../../src/native/contracts").AiEditionChatSessionSummary;
	selectAiEditionChatSession: (
		projectId: string,
		sessionId: string,
	) => import("../../src/native/contracts").AiEditionChatSession | null;
	renameAiEditionChatSession: (
		projectId: string,
		sessionId: string,
		title: string,
	) => import("../../src/native/contracts").AiEditionChatSessionSummary | null;
	deleteAiEditionChatSession: (projectId: string, sessionId: string) => boolean;
}

function normalizePlatform(platform: NodeJS.Platform): NativePlatform {
	if (platform === "darwin" || platform === "win32") {
		return platform;
	}

	return "linux";
}

function createMeta(requestId?: string) {
	return {
		version: NATIVE_BRIDGE_VERSION,
		requestId: requestId || `native-${Date.now()}`,
		timestampMs: Date.now(),
	} as const;
}

function createSuccessResponse<TData>(requestId: string | undefined, data: TData) {
	return {
		ok: true,
		data,
		meta: createMeta(requestId),
	} satisfies NativeBridgeResponse<TData>;
}

function createErrorResponse(
	requestId: string | undefined,
	code: NativeBridgeErrorCode,
	message: string,
	retryable = false,
) {
	return {
		ok: false,
		error: {
			code,
			message,
			retryable,
		},
		meta: createMeta(requestId),
	} satisfies NativeBridgeResponse;
}

function isBridgeRequest(value: unknown): value is NativeBridgeRequest {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Partial<NativeBridgeRequest>;
	return typeof candidate.domain === "string" && typeof candidate.action === "string";
}

// build a ChatEventSink that broadcasts each event to the renderer
// that requested the chat run. The webContents may be gone by the time a late
// delta fires (tab closed, window destroyed) — webContents.send throws, so we
// swallow the error to keep the loop running. The renderer treats a missing
// "end of stream" as "the run was abandoned" and shows an inline error.
function buildChatEventSink(sender: Electron.WebContents, sessionId: string): ChatEventSink {
	const send = (payload: AiEditionChatEvent) => {
		try {
			sender.send("ai-edition.chat-event", payload);
		} catch {
			// webContents gone — keep the loop running silently.
		}
	};
	return {
		text: (delta) => send({ kind: "text", sessionId, delta }),
		toolStart: (name, args) => send({ kind: "toolStart", sessionId, name, args }),
		toolEnd: (name, ok, summary) => send({ kind: "toolEnd", sessionId, name, ok, summary }),
		error: (message) => send({ kind: "error", sessionId, message }),
	};
}

export function registerNativeBridgeHandlers(context: NativeBridgeContext) {
	ipcMain.removeHandler(NATIVE_BRIDGE_CHANNEL);

	const platform = normalizePlatform(context.getPlatform());
	const store = new NativeBridgeStateStore(platform);
	const projectService = new ProjectService({
		store,
		getCurrentProjectPath: context.getCurrentProjectPath,
		getCurrentVideoPath: context.getCurrentVideoPath,
		saveProjectFile: context.saveProjectFile,
		loadProjectFile: context.loadProjectFile,
		loadCurrentProjectFile: context.loadCurrentProjectFile,
		loadProjectFileFromPath: context.loadProjectFileFromPath,
		setCurrentVideoPath: context.setCurrentVideoPath,
		getCurrentVideoPathResult: context.getCurrentVideoPathResult,
		clearCurrentVideoPath: context.clearCurrentVideoPath,
	});
	const cursorService = new CursorService({
		store,
		adapter: new TelemetryCursorAdapter({
			loadRecordingData: context.loadCursorRecordingData,
			resolveVideoPath: context.resolveVideoPath,
			loadTelemetry: context.loadCursorTelemetry,
		}),
	});
	const systemService = new SystemService({
		store,
		getPlatform: () => platform,
		getAssetBasePath: context.resolveAssetBasePath,
		getCursorCapabilities: () => cursorService.getCapabilities(),
	});
	const compositorViewService = new CompositorViewService();
	const aiEditionService = new AiEditionService({
		documents: context.getAiEditionDocuments(),
		llmConfig: context.getAiEditionLlmConfig(),
		runChat: context.runAiEditionChat,
		runChatDefault: context.runAiEditionChatDefault,
		undoLastToolBatch: context.undoAiEditionToolBatch,
		rewindToMessage: context.rewindToMessage,
		compactNow: context.compactNow,
		runTimelineOperation: context.runTimelineOperation,
		getContextUsage: context.getContextUsage,
		getDefaultChatHistory: context.getAiEditionChatHistoryDefault,
		clearDefaultChatHistory: context.clearAiEditionChatHistoryDefault,
		listSessions: context.listAiEditionChatSessions,
		createSession: context.createAiEditionChatSession,
		selectSession: context.selectAiEditionChatSession,
		renameSession: context.renameAiEditionChatSession,
		deleteSession: context.deleteAiEditionChatSession,
	});

	ipcMain.handle(NATIVE_BRIDGE_CHANNEL, async (event, request: unknown) => {
		if (!isBridgeRequest(request)) {
			return createErrorResponse(undefined, "INVALID_REQUEST", "Invalid native bridge request.");
		}

		const requestId = request.requestId;
		const domain = request.domain as string;

		try {
			switch (request.domain) {
				case "system": {
					const action = request.action as string;
					switch (request.action) {
						case "getPlatform":
							return createSuccessResponse(requestId, systemService.getPlatform());
						case "getAssetBasePath":
							return createSuccessResponse(requestId, systemService.getAssetBasePath());
						case "getCapabilities":
							return createSuccessResponse(requestId, await systemService.getCapabilities());
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported system action: ${action}`,
							);
					}
				}

				case "project": {
					const action = request.action as string;
					switch (request.action) {
						case "getCurrentContext":
							return createSuccessResponse(requestId, projectService.getCurrentContext());
						case "saveProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.saveProjectFile(
									request.payload.projectData,
									request.payload.suggestedName,
									request.payload.existingProjectPath,
								),
							);
						case "loadProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.loadProjectFile(request.payload?.projectFolder),
							);
						case "loadCurrentProjectFile":
							return createSuccessResponse(
								requestId,
								await projectService.loadCurrentProjectFile(),
							);
						case "loadProjectFileFromPath":
							return createSuccessResponse(
								requestId,
								await projectService.loadProjectFileFromPath(request.payload.path),
							);
						case "setCurrentVideoPath":
							return createSuccessResponse(
								requestId,
								await projectService.setCurrentVideoPath(request.payload.path),
							);
						case "getCurrentVideoPath":
							return createSuccessResponse(requestId, projectService.getCurrentVideoPath());
						case "clearCurrentVideoPath":
							return createSuccessResponse(requestId, projectService.clearCurrentVideoPath());
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported project action: ${action}`,
							);
					}
				}

				case "cursor": {
					const action = request.action as string;
					switch (request.action) {
						case "getCapabilities":
							return createSuccessResponse(requestId, await cursorService.getCapabilities());
						case "getTelemetry":
							return createSuccessResponse(
								requestId,
								await cursorService.getTelemetry(request.payload?.videoPath),
							);
						case "getRecordingData":
							return createSuccessResponse(
								requestId,
								await cursorService.getRecordingData(request.payload?.videoPath),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported cursor action: ${action}`,
							);
					}
				}

				case "compositor": {
					const action = request.action as string;
					switch (request.action) {
						case "createView": {
							const id = compositorViewService.createView(request.payload.rect, {
								screenPath: request.payload.screenPath,
								webcamPath: request.payload.webcamPath,
								cursorPath: request.payload.cursorPath,
							});
							return createSuccessResponse(requestId, { id });
						}
						case "setRect":
							compositorViewService.setRect(request.payload.id, request.payload.rect);
							return createSuccessResponse(requestId, { ok: true });
						case "readFrame": {
							// The renderer polls this every rAF tick (~30fps) and paints the
							// returned buffer into a `<canvas>`. The response wrapper does NOT
							// JSON-stringify — `ipcMain.handle` round-trips via structured clone,
							// which preserves `Buffer`/`Uint8Array` instances as binary. We return
							// the raw `Buffer | null` straight through; the success wrapper is fine
							// here because `{ ok: true, data: <Buffer>, meta: {...} }` is a plain
							// object whose `.data` field IS the Buffer — structured clone keeps it.
							const frame = compositorViewService.readFrame(request.payload.id);
							return createSuccessResponse(requestId, frame);
						}
						case "setParam":
							compositorViewService.setParam(
								request.payload.id,
								request.payload.key,
								request.payload.value,
							);
							return createSuccessResponse(requestId, { ok: true });
						case "setPlaying":
							compositorViewService.setPlaying(request.payload.id, request.payload.playing);
							return createSuccessResponse(requestId, { ok: true });
						case "presentTime":
							compositorViewService.presentTime(request.payload.id, request.payload.seconds);
							return createSuccessResponse(requestId, { ok: true });
						case "setScene":
							compositorViewService.setScene(request.payload.id, request.payload.sceneJson);
							return createSuccessResponse(requestId, { ok: true });
						case "setActiveClip":
							compositorViewService.setActiveClip(
								request.payload.id,
								request.payload.screenPath,
								request.payload.webcamPath,
								request.payload.webcamOffsetSec,
								request.payload.clipIndex,
								request.payload.sourceTimeSec,
							);
							return createSuccessResponse(requestId, { ok: true });
						case "destroyView":
							compositorViewService.destroyView(request.payload.id);
							return createSuccessResponse(requestId, { ok: true });
						case "export": {
							const sender = event.sender;
							const stats = await compositorViewService.export(
								request.payload.outPath,
								(frames) => {
									if (!sender.isDestroyed()) {
										sender.send("export:native-progress", frames);
									}
								},
							);
							if (!stats) {
								return createErrorResponse(
									requestId,
									"UNAVAILABLE",
									"Native compositor addon not present.",
								);
							}
							return createSuccessResponse(requestId, stats);
						}
						case "exportMulti": {
							const sender = event.sender;
							const stats = await compositorViewService.exportMulti(
								request.payload.clips,
								request.payload.outPath,
								request.payload.sceneJson,
								request.payload.params,
								(frames) => {
									if (!sender.isDestroyed()) {
										sender.send("export:native-progress", frames);
									}
								},
							);
							if (!stats) {
								return createErrorResponse(
									requestId,
									"UNAVAILABLE",
									"Native compositor addon not present.",
								);
							}
							return createSuccessResponse(requestId, stats);
						}
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported compositor action: ${action}`,
							);
					}
				}

				case "aiEdition": {
					const action = request.action as string;
					switch (request.action) {
						case "document.listProjects":
							return createSuccessResponse(requestId, await aiEditionService.listProjects());
						case "document.get":
							return createSuccessResponse(
								requestId,
								await aiEditionService.get(request.payload.projectId),
							);
						case "document.create":
							return createSuccessResponse(
								requestId,
								await aiEditionService.create(request.payload?.title),
							);
						case "document.save":
							return createSuccessResponse(
								requestId,
								await aiEditionService.save(request.payload.document),
							);
						case "document.delete":
							return createSuccessResponse(
								requestId,
								await aiEditionService.deleteProject(request.payload.projectId),
							);
						case "document.addAsset":
							return createSuccessResponse(
								requestId,
								await aiEditionService.addAsset(
									request.payload.projectId,
									request.payload.path,
									request.payload.label,
								),
							);
						case "document.removeAsset":
							return createSuccessResponse(
								requestId,
								await aiEditionService.removeAsset(
									request.payload.projectId,
									request.payload.assetId,
								),
							);
						case "llm.getSnapshot":
							return createSuccessResponse(requestId, await aiEditionService.llmGetSnapshot());
						case "llm.setConfig":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmSetConfig(request.payload.config),
							);
						case "llm.setApiKey":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmSetApiKey(
									request.payload.providerId,
									request.payload.apiKey,
								),
							);
						case "llm.removeApiKey":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmRemoveApiKey(request.payload.providerId),
							);
						case "llm.beginDeviceAuth":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmBeginDeviceAuth(
									request.payload.providerId,
									request.payload.model,
								),
							);
						case "llm.completeDeviceAuth":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmCompleteDeviceAuth(
									request.payload.providerId,
									request.payload.challenge,
									request.payload.model,
								),
							);
						case "llm.disconnect":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmDisconnect(request.payload.providerId),
							);
						case "llm.listProviderModels":
							return createSuccessResponse(
								requestId,
								await aiEditionService.llmListProviderModels(request.payload.providerId),
							);
						case "chat.run": {
							const sessionId = request.payload.sessionId;
							const sink = buildChatEventSink(event.sender, sessionId);
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatRun(
									request.payload.projectId,
									sessionId,
									request.payload.message,
									request.payload.document,
									sink,
								),
							);
						}
						case "chat.undoLastBatch":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatUndoLastBatch(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.runDefault": {
							const sink = buildChatEventSink(event.sender, "default");
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatRunDefault(
									request.payload.projectId,
									request.payload.message,
									sink,
								),
							);
						}
						case "chat.history":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatHistoryDefault(request.payload.projectId),
							);
						case "chat.clear":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatClearDefault(request.payload.projectId),
							);
						case "chat.listSessions":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatListSessions(request.payload.projectId),
							);
						case "chat.createSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatCreateSession(
									request.payload.projectId,
									request.payload.title,
								),
							);
						case "chat.selectSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatSelectSession(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.renameSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatRenameSession(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.title,
								),
							);
						case "chat.deleteSession":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatDeleteSession(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.budget":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatBudget(request.payload.projectId, request.payload.sessionId),
							);
						case "chat.compact":
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatCompact(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.rewind":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatRewindToMessage(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.messageId,
								),
							);
						case "chat.contextUsage":
							return createSuccessResponse(
								requestId,
								aiEditionService.chatContextUsage(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "chat.compactNow":
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatCompactNow(
									request.payload.projectId,
									request.payload.sessionId,
								),
							);
						case "timeline.run":
							return createSuccessResponse(
								requestId,
								await aiEditionService.chatRunTimelineOperation(
									request.payload.projectId,
									request.payload.sessionId,
									request.payload.operation,
									request.payload.conversationMessage,
								),
							);
						default:
							return createErrorResponse(
								requestId,
								"UNSUPPORTED_ACTION",
								`Unsupported aiEdition action: ${action}`,
							);
					}
				}

				default:
					return createErrorResponse(
						requestId,
						"UNSUPPORTED_ACTION",
						`Unsupported bridge domain: ${domain}`,
					);
			}
		} catch (error) {
			return createErrorResponse(
				requestId,
				"INTERNAL_ERROR",
				error instanceof Error ? error.message : "Unknown native bridge error.",
				true,
			);
		}
	});
}
