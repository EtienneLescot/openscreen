// Browser-mode shim: when running in a plain browser (no Electron shell), provide
// stubs for window.electronAPI + nativeBridgeClient so the renderer renders.
// The dev server at http://localhost:5173 can be opened in Chrome/Firefox for
// rapid iteration without the Electron window overhead.

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

function createShimElectronAPI() {
	return {
		assetBaseUrl: "",
		openVideoFilePicker: () => Promise.resolve({ success: false, canceled: true }),
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
	const storageKey = "browser-shim-document";
	const loadFromStorage = (): unknown | null => {
		try {
			const raw = localStorage.getItem(storageKey);
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	};
	const saveToStorage = (doc: unknown) => {
		try {
			localStorage.setItem(storageKey, JSON.stringify(doc));
		} catch {
			// ponytail: localStorage may be full or unavailable; silently skip
		}
	};
	const list: Array<{ id: string; title: string; updatedAt: string; assetCount: number }> = (() => {
		try {
			const raw = localStorage.getItem("browser-shim-projects");
			return raw ? JSON.parse(raw) : [];
		} catch {
			return [];
		}
	})();
	const saveList = () => {
		try {
			localStorage.setItem("browser-shim-projects", JSON.stringify(list));
		} catch {
			// ponytail: same as saveToStorage
		}
	};
	let currentDoc: unknown = loadFromStorage();

	// ponytail: in-memory chat sessions per project for browser shim. The
	// renderer treats these the same as the main-process sessions.
	type ShimSession = {
		id: string;
		projectId: string;
		title: string;
		createdAt: string;
		messages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string }>;
	};
	const sessionsByProject = new Map<string, Map<string, ShimSession>>();
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
			listProjects: () => Promise.resolve(list),
			get: () => Promise.resolve({ success: true, document: currentDoc }),
			create: (title?: string) => {
				const doc = {
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
						skipRanges: [],
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
				list.unshift({
					id: doc.project.id,
					title: doc.project.title,
					updatedAt: doc.project.updatedAt,
					assetCount: 0,
				});
				saveList();
				return Promise.resolve({ success: true, document: doc });
			},
			save: (doc: unknown) => {
				currentDoc = doc;
				saveToStorage(doc);
				return Promise.resolve({ success: true, document: doc });
			},
			delete: () => Promise.resolve({ success: true }),
			addAsset: () =>
				Promise.resolve({ success: true, assetId: "asset_shim", document: currentDoc }),
			removeAsset: () => Promise.resolve({ success: true, assetId: "", document: currentDoc }),
			llmGetSnapshot: () =>
				Promise.resolve({
					config: null,
					connectedProviders: [],
					availableProviders: [
						{ id: "anthropic", label: "Claude", authKind: "api-key" },
						{ id: "openai", label: "OpenAI", authKind: "api-key" },
					],
				}),
			llmSetConfig: () => Promise.resolve({ success: true }),
			llmSetApiKey: () => Promise.resolve({ success: true }),
			llmRemoveApiKey: () => Promise.resolve({ success: true }),
			chatRun: (projectId: string, sessionId: string) => {
				const sessions = getSessions(projectId);
				let s = sessions.get(sessionId);
				if (!s) {
					const id = `sess_${Date.now()}`;
					s = {
						id,
						projectId,
						title: "Conversation 1",
						createdAt: new Date().toISOString(),
						messages: [],
					};
					sessions.set(id, s);
				}
				return Promise.resolve({
					success: true,
					assistantMessage: {
						id: `msg_${Date.now()}`,
						role: "assistant",
						content:
							"[browser-shim] AI features need real LLM deps. Configure a provider in Settings, install the LangChain packages, then chat will work for real.",
						createdAt: new Date().toISOString(),
					},
				});
			},
			chatUndoLastBatch: () =>
				Promise.resolve({
					success: false,
					error: "[browser-shim] No agent tool batches to undo in browser mode.",
				}),
			chatRunDefault: (projectId: string) => {
				// ponytail: legacy single-session consumers — pick the most
				// recent session or auto-create one.
				const sessions = getSessions(projectId);
				if (sessions.size === 0) {
					const id = `sess_${Date.now()}`;
					sessions.set(id, {
						id,
						projectId,
						title: "Conversation 1",
						createdAt: new Date().toISOString(),
						messages: [],
					});
				}
				return Promise.resolve({
					success: true,
					assistantMessage: {
						id: `msg_${Date.now()}`,
						role: "assistant",
						content:
							"[browser-shim] AI features need real LLM deps. Configure a provider in Settings, install the LangChain packages, then chat will work for real.",
						createdAt: new Date().toISOString(),
					},
				});
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
				return Promise.resolve(summarize(s));
			},
			chatDeleteSession: (projectId: string, sessionId: string) => {
				const m = sessionsByProject.get(projectId);
				if (!m?.has(sessionId)) return Promise.resolve({ success: false });
				m.delete(sessionId);
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
