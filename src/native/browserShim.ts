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
			chatRun: () =>
				Promise.resolve({
					success: true,
					assistantMessage: {
						id: `msg_${Date.now()}`,
						role: "assistant",
						content:
							"[browser-shim] AI features need real LLM deps. Configure a provider in Settings, install the LangChain packages, then chat will work for real.",
						createdAt: new Date().toISOString(),
					},
				}),
			chatHistory: () => Promise.resolve([]),
			chatClear: () => Promise.resolve({ success: true }),
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
