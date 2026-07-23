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

// ---- Compositor view domain (Option A embed) -----------------------------
// Drives a native D3D11 compositor preview window embedded in the main app
// window. The Rust napi-rs addon (`compositor_view.node`) lives at
// `electron/native/compositor-view/` and is built OUT OF SCOPE for the TS
// layer; the service falls back to a safe no-op when the addon is absent so
// the renderer keeps running. Defined here (not in the addon .d.ts) so the
// renderer, the IPC contract, and the main-side service all import from a
// single TS source — never from the native `.d.ts`.

export interface CompositorViewRect {
	/** Device pixels, relative to the parent window's client area. */
	x: number;
	y: number;
	width: number;
	height: number;
}

export type CompositorParamValue = boolean | number | string;

export interface CompositorViewResult {
	id: number;
}

/** A self-describing preview frame returned by `readFrame` (native → renderer): pixels
 *  (`data`, RGBA8, `width * height * 4` bytes) plus their dimensions and a monotonic
 *  generation. The hook keeps `gen` and passes it back as `sinceGen`; an unchanged frame
 *  is never re-delivered, so the whole per-frame copy cost vanishes while nothing moves. */
export interface CompositorFramePacket {
	gen: number;
	width: number;
	height: number;
	data: Buffer;
}

/** Un clip de la timeline pour l'export multiclip natif (fichiers screen+webcam + trim). */
export interface CompositorClipInput {
	screenPath: string;
	webcamPath: string;
	sourceStartSec: number;
	sourceEndSec: number;
	/** temps source webcam = temps source screen − ceci. */
	webcamOffsetSec: number;
	/** `true` when this clip's screen asset has a decodable audio track the native
	 *  compositor should mix into the export. `false` skips audio decode/encode/mux
	 *  for this clip entirely (and the webcam path never carries audio by product
	 *  convention). Populated by `buildSceneDescription` and `buildNativeClipList`;
	 *  see the comment on the producer side for the exact rule. */
	hasAudio: boolean;
}

/** Bilan d'un export natif (mesure enveloppante §10 : frames, durée, fps). */
export interface CompositorExportResult {
	frames: number;
	wallS: number;
	fps: number;
	/** Durée de la vidéo exportée (secondes) — distincte de `wallS` (temps de rendu réel). */
	videoDurationS: number;
}

/** Taille/cadence/codec de sortie voulus. Tout omis → 1920x1080 / fps du 1er clip / h264. */
export interface CompositorExportParams {
	width?: number;
	height?: number;
	fps?: number;
	/** "h264" | "h265" — pas de vp9 (aucun équivalent matériel AMF côté natif). */
	codec?: string;
}

// ---- AI Edition domain (Phase 1+) -----------------------------------------
// v3/v4 AxcutDocument projects live under userData/projects/<id>.openscreen
// (older builds used <id>.axcut, migrated on access). Project ids are
// uuid-prefixed strings (e.g. "proj_<uuid>"). Asset ids likewise.

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

export type AiEditionLlmCredentialKind = "api-key" | "codex" | "github-device" | "github-pat";

export interface AiEditionLlmSnapshot {
	config: AiEditionLlmConfig | null;
	connectedProviders: string[];
	availableProviders: Array<{ id: string; label: string; authKind: string }>;
	/** Per-provider credential metadata so the UI can show `Connect via OAuth` vs `Connect via API key`. */
	credentialSummary: Array<{
		providerId: string;
		connected: boolean;
		authKind: string;
		credentialKind: AiEditionLlmCredentialKind | null;
	}>;
}

export interface AiEditionDeviceChallenge {
	verificationUri: string;
	verificationUriComplete?: string;
	userCode: string;
	deviceCode?: string;
	deviceAuthId?: string;
	intervalMs: number;
	expiresAt: number;
}

export interface AiEditionDeviceCompletionResult {
	success: boolean;
	snapshot?: AiEditionLlmSnapshot;
	error?: string;
}

export interface AiEditionLlmDisconnectResult {
	success: boolean;
	snapshot: AiEditionLlmSnapshot;
}

export interface AiEditionLlmProviderModelsResult {
	models: string[];
	error?: string;
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
	/**
	 * id of the rewind-able document snapshot taken right before
	 * the user message triggered its chat turn. Non-null = the per-message
	 * ↩ button is shown. Matches axcut's Message.checkpointId.
	 */
	checkpointId?: string | null;
}

export interface AiEditionChatResult {
	success: boolean;
	assistantMessage?: AiEditionChatMessage;
	/** Updated document when the agent ran write tools during this turn. */
	document?: unknown;
	toolCalls?: AiEditionToolCallSummary[];
	error?: string;
	/** Document checkpoint id recorded for the user message that triggered this turn (axcut parity). */
	userMessageCheckpointId?: string;
}

export interface AiEditionChatRewindResult {
	success: true;
	document: unknown;
	messages: AiEditionChatMessage[];
	/** The user message content of the rewound turn, prefilled back into the composer. */
	prompt: string;
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

export interface AiEditionChatBudget {
	usedTokens: number;
	budgetTokens: number;
	ratio: number;
	/** Ratio * 100, clamped to 0..100 — what the "% context" pill shows. */
	fillPercent: number;
}

// re-export of the timeline-operation discriminated union so the
// IPC contract type and the renderer share one shape. Kept here (not in
// src/lib/ai-edition/document/operations) so the IPC type bundle stays
// self-contained.
import type {
	AppliedTimelineOperation,
	AxcutTimelineOperation,
} from "../lib/ai-edition/document/operations";

export type { AppliedTimelineOperation, AxcutTimelineOperation };

export interface AiEditionChatCompactResult {
	session: AiEditionChatSession;
	summaryMessageId: string | null;
	summary: string;
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
			action: "llm.beginDeviceAuth";
			payload: {
				providerId: "openai-oauth" | "copilot-proxy";
				/** Optional model — recorded into the config when the device flow completes. */
				model?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "llm.completeDeviceAuth";
			payload: {
				providerId: "openai-oauth" | "copilot-proxy";
				challenge: AiEditionDeviceChallenge;
				model?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "llm.disconnect";
			payload: { providerId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "llm.listProviderModels";
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
	  }
	| {
			domain: "aiEdition";
			action: "chat.budget";
			payload: { projectId: string; sessionId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.compact";
			payload: { projectId: string; sessionId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.rewind";
			payload: { projectId: string; sessionId: string; messageId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.contextUsage";
			payload: { projectId: string; sessionId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "chat.compactNow";
			payload: { projectId: string; sessionId: string };
			requestId?: string;
	  }
	| {
			domain: "aiEdition";
			action: "timeline.run";
			payload: {
				projectId: string;
				sessionId: string;
				operation: AxcutTimelineOperation;
				conversationMessage: string;
			};
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "createView";
			/** F3: optional real-recording sources (screen + webcam, two separate H264 files) +
			 *  cursor telemetry; omitted → the POC fixture. The compositor renders OFFSCREEN
			 *  at `rect.width`x`rect.height`; no HWND/native-window-handle is carried over IPC
			 *  anymore (the addon no longer parents a top-level window). `rect.x` / `rect.y`
			 *  are vestigial — kept on the wire so the existing `CompositorViewRect` shape
			 *  stays source-compatible. */
			payload: {
				rect: CompositorViewRect;
				screenPath?: string;
				webcamPath?: string;
				cursorPath?: string;
			};
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "setRect";
			payload: { id: number; rect: CompositorViewRect };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "readFrame";
			/** Polled every rAF tick (target ~30fps) by the renderer's
			 *  `useNativeCompositorView` hook. `sinceGen` is the generation the hook
			 *  last painted; native returns a {@link CompositorFramePacket} only when a
			 *  newer frame exists, else `null` (view absent, no frame yet, or the hook
			 *  already holds the current generation — the idle path, no buffer copied).
			 *  The nested `data` Buffer survives IPC via Electron's structured clone. */
			payload: { id: number; sinceGen: number };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "setParam";
			payload: { id: number; key: string; value: CompositorParamValue };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "setPlaying";
			payload: { id: number; playing: boolean };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "destroyView";
			payload: { id: number };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "export";
			payload: { outPath?: string };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "exportMulti";
			payload: {
				clips: CompositorClipInput[];
				outPath?: string;
				sceneJson?: string;
				params?: CompositorExportParams;
			};
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "presentTime";
			payload: { id: number; seconds: number };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "setScene";
			payload: { id: number; sceneJson: string };
			requestId?: string;
	  }
	| {
			domain: "compositor";
			action: "setActiveClip";
			payload: {
				id: number;
				screenPath: string;
				webcamPath: string;
				webcamOffsetSec: number;
				/** Index in the sorted SceneDescription.clips stream (disambiguates shared assets). */
				clipIndex: number;
				/** Current screen-source time within the active clip's source window. */
				sourceTimeSec: number;
			};
			requestId?: string;
	  };

export type NativeBridgeEventName =
	| "project.contextChanged"
	| "cursor.providerChanged"
	| "cursor.telemetryLoaded"
	| "ai-edition.chat-event";

// streamed chat-progress event broadcast by runChat so the renderer
// can render text deltas + tool ops live instead of waiting for the final RPC
// return. Empty `assistant` slot + `kind: "error"` means the upstream
// provider failed and the toast was a side-channel; the renderer shows it
// inline so the chat doesn't appear to "echo back my question".
export type AiEditionChatEvent =
	| { kind: "text"; sessionId: string; delta: string }
	| { kind: "toolStart"; sessionId: string; name: string; args: unknown }
	| { kind: "toolEnd"; sessionId: string; name: string; ok: boolean; summary?: string }
	| { kind: "error"; sessionId: string; message: string };

export interface NativeBridgeEvent<TPayload = unknown> {
	name: NativeBridgeEventName;
	payload: TPayload;
	meta: NativeBridgeMeta;
}
