// Browser-mode shim: when running in a plain browser (no Electron shell), provide
// stubs for window.electronAPI + nativeBridgeClient so the renderer renders.
// The dev server at http://localhost:5173 can be opened in Chrome/Firefox for
// rapid iteration without the Electron window overhead.

import { PROVIDER_DEFINITIONS } from "../../electron/ai-edition/provider-registry";
import { nativeBridgeClient as realClient } from "./client";

function detectBrowserMode(): boolean {
	if (typeof window === "undefined") return false;
	if (window.electronAPI) return false; // Electron present, no shim needed
	const params = new URLSearchParams(window.location.search);
	return params.has("browser") || params.get("windowType") === "editor";
}

function isBrowserMode(): boolean {
	return detectBrowserMode();
}

// ponytail: RecStage's source picker + recording-prefs need something to talk
// to in browser-mode preview too — real desktopCapturer isn't available in a
// plain browser tab, so fake a couple of plausible screen/window entries
// (no thumbnails; RecStage already falls back to an icon when thumbnail is
// null). Prefs persist to localStorage, same pattern as the LLM config shim
// below, so toggles survive a reload like the real main-process store would.
type ShimDesktopSource = {
	id: string;
	name: string;
	display_id: string;
	thumbnail: string | null;
	appIcon: string | null;
};
const SHIM_SOURCES: ShimDesktopSource[] = [
	{ id: "screen:0", name: "Entire Screen", display_id: "0", thumbnail: null, appIcon: null },
	{ id: "screen:1", name: "Display 2", display_id: "1", thumbnail: null, appIcon: null },
	{ id: "window:100", name: "OpenScreen", display_id: "", thumbnail: null, appIcon: null },
	{ id: "window:101", name: "Terminal", display_id: "", thumbnail: null, appIcon: null },
];
let shimSelectedSource: ShimDesktopSource | null = null;

type ShimRecordingPrefs = {
	micEnabled: boolean;
	micDeviceId: string | null;
	camEnabled: boolean;
	camDeviceId: string | null;
	systemAudioEnabled: boolean;
	cursorCaptureMode: "editable-overlay" | "system";
};
const recordingPrefsStorageKey = "browser-shim-recording-prefs";
let shimRecordingPrefs: ShimRecordingPrefs = {
	micEnabled: false,
	micDeviceId: null,
	camEnabled: false,
	camDeviceId: null,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
};
(() => {
	try {
		const raw = localStorage.getItem(recordingPrefsStorageKey);
		if (raw) shimRecordingPrefs = { ...shimRecordingPrefs, ...JSON.parse(raw) };
	} catch {
		// ponytail: corrupt/unavailable localStorage — start fresh.
	}
})();

// ponytail: real file dialogs/ffmpeg probing aren't available in a plain
// browser tab, but a hidden <input type="file"> + blob URL gets us a real,
// playable video without any native bridge — NewEditorShell/toFileUrl
// already special-case blob:/http(s):/data: asset paths and pass them
// through untouched, so this just has to produce one.
type PickVideoResult =
	| { success: true; canceled: false; path: string; name: string }
	| { success: false; canceled: true };

function pickVideoFileViaInput(): Promise<PickVideoResult> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept =
			"video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,video/x-ms-wmv,video/*";
		input.style.position = "fixed";
		input.style.top = "-9999px";
		let settled = false;
		const finish = (result: PickVideoResult) => {
			if (settled) return;
			settled = true;
			input.remove();
			resolve(result);
		};
		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (!file) {
				finish({ success: false, canceled: true });
				return;
			}
			finish({ success: true, canceled: false, path: URL.createObjectURL(file), name: file.name });
		});
		// Chrome fires this when the picker is dismissed without a selection.
		input.addEventListener("cancel", () => finish({ success: false, canceled: true }));
		document.body.appendChild(input);
		input.click();
	});
}

function createShimElectronAPI() {
	return {
		assetBaseUrl: "",
		openVideoFilePicker: pickVideoFileViaInput,
		openProjectFile: () => Promise.resolve({ success: false, canceled: true }),
		pickExportSavePath: () => Promise.resolve({ success: false, canceled: true }),
		writeExportToPath: () => Promise.resolve({ success: false }),
		getCurrentRecordingSession: () => Promise.resolve({ success: false, session: null }),
		switchToHud: () => Promise.resolve({ success: true }),
		switchToEditor: () => Promise.resolve({ success: true }),
		startNewRecording: () => Promise.resolve({ success: true }),
		openSourceSelector: () => Promise.resolve({ success: true }),
		setHasUnsavedChanges: () => undefined,
		sendCloseConfirmResponse: () => undefined,
		onRequestCloseConfirm: () => () => undefined,
		onRequestSaveBeforeClose: () => () => undefined,
		loadProjectFileFromPath: () => Promise.resolve({ success: false, canceled: true }),
		getPathForFile: () => "",
		getSources: () => Promise.resolve(SHIM_SOURCES),
		selectSource: (source: ShimDesktopSource) => {
			shimSelectedSource = source;
			return Promise.resolve(source);
		},
		getSelectedSource: () => Promise.resolve(shimSelectedSource),
		onSelectedSourceChanged: () => () => undefined,
		getRecordingPrefs: () => Promise.resolve(shimRecordingPrefs),
		setRecordingPrefs: (patch: Partial<ShimRecordingPrefs>) => {
			shimRecordingPrefs = { ...shimRecordingPrefs, ...patch };
			try {
				localStorage.setItem(recordingPrefsStorageKey, JSON.stringify(shimRecordingPrefs));
			} catch {
				// ponytail: localStorage may be full or unavailable; silently skip
			}
			return Promise.resolve(shimRecordingPrefs);
		},
		onRecordingPrefsChanged: () => () => undefined,
		invokeNativeBridge: (req: { domain: string; action: string; payload?: unknown }) => {
			console.info("[browser-shim] invokeNativeBridge", req.domain, req.action, req.payload);
			return Promise.resolve({
				ok: true,
				data: null,
				meta: { version: 1, requestId: "shim", timestampMs: Date.now() },
			});
		},
	};
}

function createShimBridgeClient() {
	// ponytail: keyed by project id, matching the real DocumentService (one
	// file per project on disk). The previous shim kept a single global
	// `currentDoc` that `get(projectId)` ignored entirely — after a reload,
	// NewEditorShell's auto-load effect would call `listProjects()` (which
	// *did* remember every created project), pick the most recent one, then
	// `get()` that id and get back whatever `currentDoc` happened to be
	// (often null, if `save()` hadn't fired yet), throwing "Failed to load
	// project" on every reload. Same root cause broke addAsset/removeAsset:
	// they ignored `projectId` and read/returned the same possibly-null
	// `currentDoc`, which crashed downstream Zod parsing.
	type ShimDocument = {
		project: {
			id: string;
			title: string;
			createdAt: string;
			updatedAt: string;
			primaryAssetId?: string;
		};
		assets: Array<{ id: string; kind: "video"; label: string; originalPath: string }>;
		[key: string]: unknown;
	};
	const projectsStorageKey = "browser-shim-projects-v2";
	let documentsByProject: Record<string, ShimDocument> = {};
	let projectOrder: string[] = [];
	(() => {
		try {
			const raw = localStorage.getItem(projectsStorageKey);
			if (!raw) return;
			const parsed = JSON.parse(raw) as {
				documents: Record<string, ShimDocument>;
				order: string[];
			};
			documentsByProject = parsed.documents ?? {};
			projectOrder = parsed.order ?? [];
		} catch {
			// ponytail: corrupt/unavailable localStorage — start fresh rather
			// than crash the whole app on load.
		}
	})();
	const saveProjectsState = () => {
		try {
			localStorage.setItem(
				projectsStorageKey,
				JSON.stringify({ documents: documentsByProject, order: projectOrder }),
			);
		} catch {
			// ponytail: localStorage may be full or unavailable; silently skip
		}
	};
	const listProjectSummaries = () =>
		projectOrder
			.map((id) => documentsByProject[id])
			.filter((doc): doc is ShimDocument => Boolean(doc))
			.map((doc) => ({
				id: doc.project.id,
				title: doc.project.title,
				updatedAt: doc.project.updatedAt,
				assetCount: doc.assets.length,
			}));

	// ponytail: stateful LLM config/credentials so the "connect a provider"
	// flow is actually testable in browser-mode preview — the real backend
	// persists this in safeStorage; here it's localStorage, faked but sticky
	// across reloads so the UX round-trips the same way.
	type ShimLlmConfig = {
		provider: string;
		model: string;
		baseUrl?: string;
		reasoningEffort?: string;
		allowAgentEdits?: boolean;
	};
	const credentialsByProvider = new Map<string, { apiKey: string }>();
	let activeConfig: ShimLlmConfig | null = null;
	const llmStorageKey = "browser-shim-llm";
	(() => {
		try {
			const raw = localStorage.getItem(llmStorageKey);
			if (!raw) return;
			const parsed = JSON.parse(raw) as {
				config: ShimLlmConfig | null;
				credentials: Record<string, { apiKey: string }>;
			};
			activeConfig = parsed.config ?? null;
			for (const [id, cred] of Object.entries(parsed.credentials ?? {})) {
				credentialsByProvider.set(id, cred);
			}
		} catch {
			// ponytail: same as saveToStorage
		}
	})();
	const saveLlmState = () => {
		try {
			localStorage.setItem(
				llmStorageKey,
				JSON.stringify({
					config: activeConfig,
					credentials: Object.fromEntries(credentialsByProvider),
				}),
			);
		} catch {
			// ponytail: same as saveToStorage
		}
	};
	const buildLlmSnapshot = () => ({
		config: activeConfig,
		connectedProviders: [...credentialsByProvider.keys()],
		availableProviders: PROVIDER_DEFINITIONS.map((d) => ({
			id: d.id,
			label: d.label,
			authKind: d.authKind,
		})),
		credentialSummary: PROVIDER_DEFINITIONS.map((def) => ({
			providerId: def.id,
			connected: credentialsByProvider.has(def.id),
			authKind: def.authKind,
			credentialKind: credentialsByProvider.has(def.id) ? "api-key" : null,
		})),
	});

	// ponytail: chat sessions per project, persisted to localStorage so a
	// reload doesn't blank the active conversation. Matches the real chat
	// service's on-disk behavior (the renderer treats these the same).
	type ShimSession = {
		id: string;
		projectId: string;
		title: string;
		createdAt: string;
		messages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string }>;
	};
	const chatStorageKey = "browser-shim-chat-v1";
	const sessionsByProject = new Map<string, Map<string, ShimSession>>();
	(() => {
		try {
			const raw = localStorage.getItem(chatStorageKey);
			if (!raw) return;
			const parsed = JSON.parse(raw) as Record<string, Record<string, ShimSession>>;
			for (const [projectId, sessions] of Object.entries(parsed)) {
				sessionsByProject.set(projectId, new Map(Object.entries(sessions)));
			}
		} catch {
			// ponytail: corrupt/unavailable localStorage — start fresh.
		}
	})();
	const persistChat = () => {
		try {
			const out: Record<string, Record<string, ShimSession>> = {};
			for (const [projectId, sessions] of sessionsByProject) {
				out[projectId] = Object.fromEntries(sessions);
			}
			localStorage.setItem(chatStorageKey, JSON.stringify(out));
		} catch {
			// ponytail: localStorage may be full or unavailable; silently skip
		}
	};
	const getSessions = (projectId: string): Map<string, ShimSession> => {
		let m = sessionsByProject.get(projectId);
		if (!m) {
			m = new Map();
			sessionsByProject.set(projectId, m);
		}
		return m;
	};
	const summarize = (s: ShimSession) => ({
		id: s.id,
		projectId: s.projectId,
		title: s.title,
		createdAt: s.createdAt,
		messageCount: s.messages.length,
	});

	return {
		aiEdition: {
			listProjects: () => Promise.resolve(listProjectSummaries()),
			get: (projectId: string) => {
				const doc = documentsByProject[projectId];
				return Promise.resolve(
					doc ? { success: true, document: doc } : { success: false, error: "Project not found" },
				);
			},
			create: (title?: string) => {
				const doc: ShimDocument = {
					schemaVersion: 3,
					project: {
						id: `proj_${Math.random().toString(36).slice(2, 10)}`,
						title: title || "Untitled Project",
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
					assets: [],
					transcript: null,
					transcripts: [],
					timeline: {
						clips: [],
						gaps: [],
						trimRanges: [],
						muteRanges: [],
						speedRanges: [],
						captionRanges: [],
					},
					annotations: [],
					zoomRanges: [],
					legacyEditor: null,
					agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
					preview: { strategy: "seek", revision: 0 },
					export: { preset: "final-balanced", lastJobId: null },
					history: { revisions: [] },
				};
				documentsByProject[doc.project.id] = doc;
				projectOrder.unshift(doc.project.id);
				saveProjectsState();
				return Promise.resolve({ success: true, document: doc });
			},
			save: (doc: ShimDocument) => {
				const id = doc?.project?.id;
				if (!id) return Promise.resolve({ success: false, error: "Document has no project id" });
				documentsByProject[id] = doc;
				if (!projectOrder.includes(id)) projectOrder.unshift(id);
				saveProjectsState();
				return Promise.resolve({ success: true, document: doc });
			},
			delete: (projectId: string) => {
				delete documentsByProject[projectId];
				projectOrder = projectOrder.filter((id) => id !== projectId);
				saveProjectsState();
				return Promise.resolve({ success: true });
			},
			addAsset: (projectId: string, path: string, label?: string) => {
				const doc = documentsByProject[projectId];
				if (!doc) return Promise.resolve({ assetId: "", document: null });
				const assetId = `asset_${Math.random().toString(36).slice(2, 10)}`;
				const asset = {
					id: assetId,
					kind: "video" as const,
					label: label || path.split(/[\\/]/).pop() || "Recording",
					originalPath: path,
				};
				const next: ShimDocument = {
					...doc,
					assets: [...doc.assets, asset],
					project: { ...doc.project, primaryAssetId: doc.project.primaryAssetId ?? assetId },
				};
				documentsByProject[projectId] = next;
				saveProjectsState();
				return Promise.resolve({ assetId, document: next });
			},
			removeAsset: (projectId: string, assetId: string) => {
				const doc = documentsByProject[projectId];
				if (!doc) return Promise.resolve({ assetId, document: null });
				const next: ShimDocument = { ...doc, assets: doc.assets.filter((a) => a.id !== assetId) };
				documentsByProject[projectId] = next;
				saveProjectsState();
				return Promise.resolve({ assetId, document: next });
			},
			llmGetSnapshot: () => Promise.resolve(buildLlmSnapshot()),
			llmSetConfig: (config: ShimLlmConfig) => {
				activeConfig = config;
				saveLlmState();
				return Promise.resolve({ success: true });
			},
			llmSetApiKey: (providerId: string, apiKey: string) => {
				if (apiKey.trim()) credentialsByProvider.set(providerId, { apiKey: apiKey.trim() });
				else credentialsByProvider.delete(providerId);
				saveLlmState();
				return Promise.resolve({ success: true });
			},
			llmRemoveApiKey: (providerId: string) => {
				credentialsByProvider.delete(providerId);
				if (activeConfig?.provider === providerId) activeConfig = null;
				saveLlmState();
				return Promise.resolve({ success: true });
			},
			llmDisconnect: (providerId: string) => {
				credentialsByProvider.delete(providerId);
				if (activeConfig?.provider === providerId) activeConfig = null;
				saveLlmState();
				return Promise.resolve({ success: true, snapshot: buildLlmSnapshot() });
			},
			// ponytail: OAuth/PAT device flows need a real network round-trip to
			// the provider — nothing meaningful to fake here. Reject with a clear
			// message instead of silently returning undefined (which crashed
			// callers expecting a challenge object).
			llmBeginDeviceAuth: () =>
				Promise.reject(new Error("Device login isn't available in the browser preview.")),
			llmCompleteDeviceAuth: () =>
				Promise.reject(new Error("Device login isn't available in the browser preview.")),
			llmListProviderModels: (providerId: string) =>
				Promise.resolve({
					models: [`${providerId}-demo-model-1`, `${providerId}-demo-model-2`],
				}),
			chatRun: (projectId: string, sessionId: string, message?: string) => {
				const sessions = getSessions(projectId);
				let s = sessions.get(sessionId);
				if (!s) {
					s = {
						id: sessionId,
						projectId,
						title: "Conversation 1",
						createdAt: new Date().toISOString(),
						messages: [],
					};
					sessions.set(sessionId, s);
				}
				// ponytail: actually persist the exchange into the session. Without
				// this, the useEffect that refetches history on activeSessionId
				// change (chatSelectSession) would clobber the caller's optimistic
				// `setMessages` with an empty list — same class of bug the real
				// chat-service avoids by persisting before returning.
				if (message) {
					s.messages.push({
						id: `msg_${Date.now()}_u`,
						role: "user",
						content: message,
						createdAt: new Date().toISOString(),
					});
				}
				const assistantMessage = {
					id: `msg_${Date.now()}_a`,
					role: "assistant" as const,
					content:
						"[browser-shim] AI features need real LLM deps. Configure a provider in Settings, install the LangChain packages, then chat will work for real.",
					createdAt: new Date().toISOString(),
				};
				s.messages.push(assistantMessage);
				persistChat();
				return Promise.resolve({ success: true, assistantMessage });
			},
			chatUndoLastBatch: () =>
				Promise.resolve({
					success: false,
					error: "[browser-shim] No agent tool batches to undo in browser mode.",
				}),
			chatRunDefault: (projectId: string, message?: string) => {
				// ponytail: legacy single-session consumers — pick the most
				// recent session or auto-create one.
				const sessions = getSessions(projectId);
				let s = [...sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
				if (!s) {
					s = {
						id: `sess_${Date.now()}`,
						projectId,
						title: "Conversation 1",
						createdAt: new Date().toISOString(),
						messages: [],
					};
					sessions.set(s.id, s);
				}
				if (message) {
					s.messages.push({
						id: `msg_${Date.now()}_u`,
						role: "user",
						content: message,
						createdAt: new Date().toISOString(),
					});
				}
				const assistantMessage = {
					id: `msg_${Date.now()}_a`,
					role: "assistant" as const,
					content:
						"[browser-shim] AI features need real LLM deps. Configure a provider in Settings, install the LangChain packages, then chat will work for real.",
					createdAt: new Date().toISOString(),
				};
				s.messages.push(assistantMessage);
				persistChat();
				return Promise.resolve({ success: true, assistantMessage });
			},
			chatHistory: (projectId: string) => {
				const m = sessionsByProject.get(projectId);
				if (!m || m.size === 0) return Promise.resolve([]);
				const arr = Array.from(m.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
				return Promise.resolve([...arr[0].messages]);
			},
			chatClear: (projectId: string) => {
				const m = sessionsByProject.get(projectId);
				if (m) for (const s of m.values()) s.messages = [];
				persistChat();
				return Promise.resolve({ success: true });
			},
			chatListSessions: (projectId: string) => {
				const m = sessionsByProject.get(projectId);
				if (!m) return Promise.resolve([]);
				return Promise.resolve(Array.from(m.values()).map(summarize));
			},
			chatCreateSession: (projectId: string, title?: string) => {
				const sessions = getSessions(projectId);
				const id = `sess_${Date.now()}`;
				const s: ShimSession = {
					id,
					projectId,
					title: title?.trim() || `Conversation ${sessions.size + 1}`,
					createdAt: new Date().toISOString(),
					messages: [],
				};
				sessions.set(id, s);
				persistChat();
				return Promise.resolve(summarize(s));
			},
			chatSelectSession: (projectId: string, sessionId: string) => {
				const s = sessionsByProject.get(projectId)?.get(sessionId);
				return Promise.resolve(s ? { ...s, messages: [...s.messages] } : null);
			},
			chatRenameSession: (projectId: string, sessionId: string, title: string) => {
				const s = sessionsByProject.get(projectId)?.get(sessionId);
				if (!s) return Promise.resolve(null);
				const trimmed = title.trim();
				if (trimmed) s.title = trimmed;
				persistChat();
				return Promise.resolve(summarize(s));
			},
			chatDeleteSession: (projectId: string, sessionId: string) => {
				const m = sessionsByProject.get(projectId);
				if (!m?.has(sessionId)) return Promise.resolve({ success: false });
				m.delete(sessionId);
				persistChat();
				return Promise.resolve({ success: true });
			},
			chatBudget: (projectId: string, sessionId: string) => {
				const s = sessionsByProject.get(projectId)?.get(sessionId);
				if (!s) return Promise.resolve(null);
				const chars = s.messages.reduce((acc, m) => acc + m.content.length, 0);
				const used = Math.ceil(chars / 4);
				return Promise.resolve({ usedTokens: used, budgetTokens: 80_000, ratio: used / 80_000 });
			},
			chatCompact: (projectId: string, sessionId: string) => {
				// ponytail: browser shim is a no-op compaction — it just hand-summarizes
				// instead of round-tripping an LLM call. Returns a placeholder session
				// so renderers can validate the wiring.
				const s = sessionsByProject.get(projectId)?.get(sessionId);
				if (!s) return Promise.resolve(null);
				return Promise.resolve({
					session: s,
					summaryMessageId: null,
					summary: "(browser shim compaction is a no-op)",
				});
			},
		},
		project: {
			getCurrentContext: () =>
				Promise.resolve({ currentProjectPath: null, currentVideoPath: null }),
			loadProjectFile: () => Promise.resolve({ success: false, canceled: true }),
		},
	};
}

export function installBrowserShims(): void {
	if (typeof window === "undefined") return;
	if (!isBrowserMode()) return;
	if (!(window as unknown as { electronAPI?: unknown }).electronAPI) {
		(window as unknown as { electronAPI: unknown }).electronAPI = createShimElectronAPI();
	}
	// ponytail: replace the nativeBridgeClient on the window object. Components
	// import it from "@/native/client" at module load, so we patch the exported
	// object's methods to return shim responses. This keeps the import unchanged.
	const shim = createShimBridgeClient();
	const realKeys = Object.keys(realClient) as Array<keyof typeof realClient>;
	for (const domain of realKeys) {
		const realDomain = realClient[domain];
		const shimDomain = (shim as unknown as Record<string, unknown>)[domain as string];
		if (typeof realDomain === "object" && realDomain && shimDomain) {
			for (const action of Object.keys(realDomain) as Array<keyof typeof realDomain>) {
				const shimAction = (shimDomain as Record<string, unknown>)[action as string];
				if (typeof shimAction === "function") {
					(realDomain as Record<string, unknown>)[action as string] = shimAction;
				}
			}
		}
	}
	console.info("[openscreen] browser-mode shims active (no Electron)");
}

export { isBrowserMode };
