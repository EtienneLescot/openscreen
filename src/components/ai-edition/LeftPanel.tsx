import { ArrowLeft, Check, Film, Loader2, MessageSquare, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { AI_FEATURES_ENABLED } from "@/components/video-editor/featureFlags";
import { type AxcutAsset, ensureDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { nativeBridgeClient } from "@/native/client";
import type { AiEditionLlmConfig, AiEditionToolCallSummary } from "@/native/contracts";
import {
	PROVIDER_DEFINITIONS,
	REASONING_EFFORT_OPTIONS,
	type ReasoningEffort,
} from "../../../electron/ai-edition/provider-registry";
import { computeBudget } from "./chatBudget";
import { ChatHistoryModal, SourceTranscriptModal } from "./Modals";
import styles from "./NewEditorShell.module.css";
import { ProviderSettings } from "./ProviderSettings";

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
	none: "None",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
};

export type LeftTab = "chat" | "media";

const THUMB_PALETTE = ["thumbRed", "thumbGreen", "thumbAmber", "thumbCyan"] as const;

function formatTimecode(sec: number | undefined): string {
	if (!sec || !Number.isFinite(sec)) return "0:00:00.0";
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = (sec % 60).toFixed(1);
	return `${h}:${m.toString().padStart(2, "0")}:${s.padStart(3, "0")}`;
}

function formatSize(bytes: number | undefined): string {
	if (!bytes || !Number.isFinite(bytes)) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

function MediaList({
	assets,
	onOpenTranscript,
	transcriptReadyIds,
	assetStatuses,
}: {
	assets: AxcutAsset[];
	onOpenTranscript?: (asset: AxcutAsset) => void;
	transcriptReadyIds?: Set<string>;
	assetStatuses?: Record<string, "pending" | "running" | "failed">;
}) {
	if (assets.length === 0) {
		return (
			<p
				style={{
					font: "400 12px var(--font-body)",
					color: "var(--muted)",
					padding: "16px var(--sp-4)",
					textAlign: "center",
					lineHeight: 1.5,
				}}
			>
				No media in this project yet. Import a video below.
			</p>
		);
	}
	return (
		<ul className={styles.mediaList}>
			{assets.map((asset, i) => {
				const label = asset.label || basename(asset.originalPath);
				const tc = formatTimecode(asset.durationSec);
				const size = formatSize(asset.sizeBytes);
				const palette = THUMB_PALETTE[i % THUMB_PALETTE.length];
				const isReady = transcriptReadyIds?.has(asset.id);
				const status = isReady ? "complete" : (assetStatuses?.[asset.id] ?? "idle");

				return (
					<li
						className={styles.mediaCard}
						key={asset.id}
						title={asset.originalPath}
						draggable
						onDragStart={(e) => {
							e.dataTransfer.setData("application/x-axcut-asset", asset.id);
							e.dataTransfer.effectAllowed = "copy";
						}}
					>
						<button
							type="button"
							style={{
								display: "flex",
								flexDirection: "column",
								border: 0,
								background: "none",
								padding: 0,
								cursor: "pointer",
								font: "inherit",
								textAlign: "left",
								width: "100%",
							}}
							onClick={() => onOpenTranscript?.(asset)}
						>
							<div className={`${styles.thumb} ${styles[palette]}`} aria-hidden>
								<Film size={22} />
							</div>
							<div className={styles.mediaMeta}>
								<div className={styles.name}>{label}</div>
								<div className={styles.row}>
									<span
										style={{
											width: 8,
											height: 8,
											borderRadius: "50%",
											background:
												status === "complete"
													? "var(--success)"
													: status === "running"
														? "var(--accent)"
														: status === "pending"
															? "#f59e0b"
															: status === "failed"
																? "var(--danger)"
																: "var(--dim)",
											boxShadow:
												status === "complete"
													? "0 0 0 3px var(--success-soft)"
													: status === "running"
														? "0 0 0 3px rgba(16, 185, 129, 0.2)"
														: status === "pending"
															? "0 0 0 3px rgba(245, 158, 11, 0.2)"
															: status === "failed"
																? "0 0 0 3px rgba(239, 68, 68, 0.2)"
																: "none",
											flexShrink: 0,
										}}
										aria-label={
											status === "complete"
												? "Transcript ready"
												: status === "running"
													? "Transcribing"
													: status === "pending"
														? "Pending transcription"
														: status === "failed"
															? "Transcription failed"
															: "No transcript"
										}
									/>
									<span className={styles.timecode}>{tc}</span>
									<span className={styles.size}>{size}</span>
								</div>
							</div>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

export function MediaPane({
	assetStatuses,
	onRegenerateAsset,
}: {
	assetStatuses?: Record<string, "pending" | "running" | "failed">;
	onRegenerateAsset?: (assetId: string, language: string) => Promise<void>;
}) {
	const projectId = useProjectStore((s) => s.projectId);
	const document = useProjectStore((s) => s.document);
	const addAsset = useProjectStore((s) => s.addAsset);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [srcTranscriptAsset, setSrcTranscriptAsset] = useState<AxcutAsset | null>(null);

	const handleImport = async () => {
		if (!projectId) {
			toast.error("Open a project first");
			return;
		}
		const picker = await window.electronAPI?.openVideoFilePicker();
		if (!picker?.success || !picker.path) return;
		setBusy(true);
		try {
			await addAsset(picker.path);
			toast.success(`Added ${basename(picker.path)}`);
		} catch (err) {
			toast.error("Could not add asset", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	const filtered = (document?.assets ?? []).filter((a) => {
		if (!query) return true;
		const text = `${a.label} ${a.originalPath}`.toLowerCase();
		return text.includes(query.toLowerCase());
	});

	return (
		<aside className={styles.panel}>
			<header className={styles.panelHead}>
				<h2>Media</h2>
			</header>
			<div style={{ padding: "10px var(--sp-3) 8px" }}>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "6px 10px",
						background: "var(--surface-warm)",
						border: "1px solid var(--border-soft)",
						borderRadius: "var(--r-md)",
						color: "var(--meta)",
					}}
				>
					<Search size={14} />
					<input
						type="text"
						placeholder="Search…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						style={{
							flex: 1,
							border: 0,
							background: "transparent",
							outline: "none",
							font: "13px var(--font-body)",
							color: "var(--fg)",
						}}
					/>
					{query ? (
						<button
							type="button"
							onClick={() => setQuery("")}
							aria-label="Clear search"
							style={{
								background: "transparent",
								border: 0,
								color: "var(--meta)",
								cursor: "pointer",
							}}
						>
							<X size={12} />
						</button>
					) : null}
				</div>
			</div>
			<div className={styles.panelBody} style={{ padding: "4px var(--sp-3) 8px" }}>
				<MediaList
					assets={filtered}
					onOpenTranscript={setSrcTranscriptAsset}
					transcriptReadyIds={new Set(document?.transcripts?.map((t) => t.assetId) ?? [])}
					assetStatuses={assetStatuses}
				/>
			</div>
			<button
				type="button"
				className={styles.importBtn}
				onClick={handleImport}
				disabled={!projectId || busy}
			>
				<Plus size={14} />
				Import media
			</button>
			{document?.transcript ? (
				<div
					style={{
						margin: "0 var(--sp-3) 8px",
						padding: "6px 10px",
						borderRadius: 999,
						background: "var(--success-soft)",
						color: "var(--success)",
						font: "500 11px/1 var(--font-mono)",
						letterSpacing: "0.04em",
						display: "inline-flex",
						alignItems: "center",
						gap: 6,
					}}
				>
					<span
						style={{
							width: 6,
							height: 6,
							borderRadius: "50%",
							background: "var(--success)",
						}}
					/>
					TRANSCRIPT READY
				</div>
			) : null}
			<SourceTranscriptModal
				open={srcTranscriptAsset !== null}
				onClose={() => setSrcTranscriptAsset(null)}
				assetLabel={srcTranscriptAsset?.label ?? ""}
				assetPath={srcTranscriptAsset?.originalPath ?? ""}
				tcFormatted={formatTimecode(srcTranscriptAsset?.durationSec)}
				transcript={
					srcTranscriptAsset && document?.transcripts
						? (document.transcripts.find((t) => t.assetId === srcTranscriptAsset.id) ?? null)
						: null
				}
				isTranscribing={assetStatuses?.[srcTranscriptAsset?.id ?? ""] === "running"}
				isFailed={assetStatuses?.[srcTranscriptAsset?.id ?? ""] === "failed"}
				onRegenerate={(language) => {
					if (!srcTranscriptAsset || !onRegenerateAsset) return Promise.resolve();
					return onRegenerateAsset(srcTranscriptAsset.id, language);
				}}
			/>
		</aside>
	);
}

export function LeftPanel({
	active,
	assetStatuses,
	onRegenerateAsset,
}: {
	active: LeftTab;
	assetStatuses?: Record<string, "pending" | "running" | "failed">;
	onRegenerateAsset?: (assetId: string, language: string) => Promise<void>;
}) {
	return active === "chat" && AI_FEATURES_ENABLED ? (
		<ChatStripPanel />
	) : (
		<MediaPane assetStatuses={assetStatuses} onRegenerateAsset={onRegenerateAsset} />
	);
}

interface ChatDisplayMessage {
	role: string;
	content: string;
	time?: string;
	toolCalls?: AiEditionToolCallSummary[];
}

// Quick-access model picker anchored to the composer's model pill — mirrors
// axcut's LlmPopover in "models"/"providers" mode (a lightweight popover, not
// the full AI-settings modal). "Provider settings…" in the providers screen
// is the escape hatch into that full modal (same one the header gear opens),
// matching axcut's `openProviderSettings` from its popover's providers screen.
function ModelQuickPopover({
	anchorRect,
	llmConfig,
	connectedProviders,
	onClose,
	onConfigChange,
	onOpenFullSettings,
}: {
	anchorRect: { left: number; bottom: number; maxHeight: number };
	llmConfig: AiEditionLlmConfig;
	connectedProviders: string[];
	onClose: () => void;
	onConfigChange: () => void;
	onOpenFullSettings: () => void;
}) {
	const [screen, setScreen] = useState<"models" | "providers">("models");
	const [browseProviderId, setBrowseProviderId] = useState(llmConfig.provider);
	const [models, setModels] = useState<string[]>([]);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState(false);

	const browseDef = PROVIDER_DEFINITIONS.find((d) => d.id === browseProviderId);

	useEffect(() => {
		if (screen !== "models" || !browseProviderId) return;
		let cancelled = false;
		setModelsLoading(true);
		setModelsError(null);
		void nativeBridgeClient.aiEdition
			.llmListProviderModels(browseProviderId)
			.then((result) => {
				if (cancelled) return;
				setModels(result.models);
				setModelsError(result.error ?? null);
			})
			.catch((err) => {
				if (cancelled) return;
				setModels([]);
				setModelsError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setModelsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [screen, browseProviderId]);

	const selectModel = async (nextModel: string) => {
		setBusy(true);
		try {
			const result = await nativeBridgeClient.aiEdition.llmSetConfig({
				...llmConfig,
				provider: browseProviderId,
				model: nextModel,
			});
			if (result.success) {
				onConfigChange();
				onClose();
			} else {
				setModelsError(result.error ?? "Could not select model");
			}
		} finally {
			setBusy(false);
		}
	};

	const filteredModels = search.trim()
		? models.filter((candidate) => candidate.toLowerCase().includes(search.trim().toLowerCase()))
		: models;

	return createPortal(
		<div
			role="dialog"
			aria-modal="true"
			style={{ position: "fixed", inset: 0, zIndex: 999 }}
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<section
				style={{
					position: "fixed",
					left: anchorRect.left,
					bottom: anchorRect.bottom,
					width: 320,
					maxHeight: anchorRect.maxHeight,
					display: "flex",
					flexDirection: "column",
					background: "var(--surface)",
					border: "1px solid var(--border)",
					borderRadius: "var(--r-md)",
					boxShadow: "var(--elev-pop)",
					zIndex: 1000,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "10px 12px",
						borderBottom: "1px solid var(--border-soft)",
					}}
				>
					<button
						type="button"
						onClick={() => setScreen(screen === "models" ? "providers" : "models")}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 6,
							background: "transparent",
							border: "none",
							color: "var(--fg-2)",
							cursor: "pointer",
							fontSize: 12.5,
							padding: 0,
						}}
					>
						<ArrowLeft size={14} />
						{screen === "models" ? "Change provider" : "Back"}
					</button>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						style={{
							background: "transparent",
							border: "none",
							color: "var(--muted)",
							cursor: "pointer",
							padding: 0,
						}}
					>
						<X size={14} />
					</button>
				</div>
				<div style={{ overflowY: "auto", padding: 10, minHeight: 0, flex: 1 }}>
					{screen === "models" ? (
						<>
							<div style={{ marginBottom: 8 }}>
								<div style={{ fontWeight: 600, fontSize: 13 }}>
									{browseDef?.label ?? browseProviderId}
								</div>
								<div style={{ fontSize: 11.5, color: "var(--muted)" }}>
									Current model:{" "}
									{browseProviderId === llmConfig.provider
										? llmConfig.model
										: (browseDef?.defaultModel ?? "Not selected")}
								</div>
							</div>
							<input
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder={modelsLoading ? "Loading models…" : "Search models…"}
								disabled={modelsLoading || !models.length}
								style={{
									width: "100%",
									padding: "6px 8px",
									marginBottom: 8,
									borderRadius: "var(--r-sm)",
									border: "1px solid var(--border)",
									background: "var(--bg)",
									color: "var(--fg)",
								}}
							/>
							{!models.length ? (
								<div style={{ fontSize: 12, color: "var(--muted)", padding: "8px 0" }}>
									{modelsLoading
										? "Loading models…"
										: modelsError
											? `Couldn't fetch live models (${modelsError}); open provider settings to type a model id manually.`
											: "No models available from this provider."}
								</div>
							) : (
								<div>
									{filteredModels.map((candidate) => (
										<button
											key={candidate}
											type="button"
											disabled={busy}
											onClick={() => void selectModel(candidate)}
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												width: "100%",
												padding: "7px 8px",
												border: "none",
												borderRadius: "var(--r-sm)",
												background:
													candidate === llmConfig.model && browseProviderId === llmConfig.provider
														? "var(--surface-3)"
														: "transparent",
												color: "var(--fg)",
												cursor: "pointer",
												fontSize: 12.5,
												marginBottom: 2,
											}}
										>
											{candidate}
											{candidate === llmConfig.model && browseProviderId === llmConfig.provider ? (
												<Check size={12} />
											) : null}
										</button>
									))}
									{filteredModels.length === 0 ? (
										<div style={{ fontSize: 12, color: "var(--muted)" }}>
											No models match this search.
										</div>
									) : null}
								</div>
							)}
						</>
					) : (
						<>
							{connectedProviders.map((providerId) => {
								const def = PROVIDER_DEFINITIONS.find((d) => d.id === providerId);
								if (!def) return null;
								return (
									<button
										key={providerId}
										type="button"
										onClick={() => {
											setBrowseProviderId(providerId);
											setScreen("models");
										}}
										style={{
											display: "flex",
											flexDirection: "column",
											alignItems: "flex-start",
											width: "100%",
											padding: "8px 10px",
											border: "none",
											borderRadius: "var(--r-sm)",
											background:
												providerId === browseProviderId ? "var(--surface-3)" : "transparent",
											color: "var(--fg)",
											cursor: "pointer",
											marginBottom: 4,
										}}
									>
										<strong style={{ fontSize: 12.5 }}>{def.label}</strong>
										<span style={{ fontSize: 11, color: "var(--muted)" }}>
											{providerId === llmConfig.provider ? llmConfig.model : def.defaultModel}
										</span>
									</button>
								);
							})}
							{connectedProviders.length === 0 ? (
								<div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
									No connected providers yet.
								</div>
							) : null}
							<button
								type="button"
								onClick={() => {
									onClose();
									onOpenFullSettings();
								}}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									width: "100%",
									padding: "8px 10px",
									border: "1px solid var(--border-soft)",
									borderRadius: "var(--r-sm)",
									background: "transparent",
									color: "var(--fg-2)",
									cursor: "pointer",
									marginTop: 6,
								}}
							>
								Provider settings…
							</button>
						</>
					)}
				</div>
			</section>
		</div>,
		document.body,
	);
}

function ChatStripPanel() {
	const projectId = useProjectStore((s) => s.projectId);
	const [messages, setMessages] = useState<ChatDisplayMessage[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [llmConfig, setLlmConfig] = useState<AiEditionLlmConfig | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [chatsOpen, setChatsOpen] = useState(false);
	const [sessions, setSessions] = useState<
		Array<{ id: string; title: string; messageCount: number; createdAt: string }>
	>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [reasoningOpen, setReasoningOpen] = useState(false);
	const reasoningButtonRef = useRef<HTMLButtonElement | null>(null);
	const [reasoningMenuRect, setReasoningMenuRect] = useState<{
		left: number;
		bottom: number;
	} | null>(null);
	const [reasoningBusy, setReasoningBusy] = useState(false);
	const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
	const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
	const modelButtonRef = useRef<HTMLButtonElement | null>(null);
	const [modelPopoverRect, setModelPopoverRect] = useState<{
		left: number;
		bottom: number;
		maxHeight: number;
	} | null>(null);

	const refreshLlm = useCallback(async () => {
		try {
			const snap = await nativeBridgeClient.aiEdition.llmGetSnapshot();
			setLlmConfig(snap.config);
			setConnectedProviders(snap.connectedProviders);
		} catch {
			// ponytail: silent
		}
	}, []);

	const refreshSessions = useCallback(
		async (pid: string, preferFirst = false) => {
			try {
				const list = await nativeBridgeClient.aiEdition.chatListSessions(pid);
				setSessions(list);
				if (list.length === 0) {
					setActiveSessionId(null);
					setMessages([]);
					return;
				}
				if (preferFirst || !list.some((s) => s.id === activeSessionId)) {
					setActiveSessionId(list[0].id);
				}
			} catch {
				// ponytail: silent — shim mode or missing project
			}
		},
		[activeSessionId],
	);

	useEffect(() => {
		void refreshLlm();
	}, [refreshLlm]);

	useEffect(() => {
		if (!projectId) {
			setSessions([]);
			setActiveSessionId(null);
			setMessages([]);
			return;
		}
		void refreshSessions(projectId, true);
	}, [projectId, refreshSessions]);

	useEffect(() => {
		if (!projectId || !activeSessionId) {
			setMessages([]);
			return;
		}
		void (async () => {
			try {
				const session = await nativeBridgeClient.aiEdition.chatSelectSession(
					projectId,
					activeSessionId,
				);
				if (session) {
					setMessages(
						session.messages.map((m) => ({
							role: m.role,
							content: m.content,
							time: m.createdAt,
							toolCalls: m.toolCalls,
						})),
					);
				} else {
					setMessages([]);
				}
			} catch {
				// ponytail: silent — shim mode
			}
		})();
	}, [projectId, activeSessionId]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
	});

	// Apply a document returned by the agent (tool batch or undo). setDocument
	// pushes the previous doc to the local undo stack (Cmd+Z also works), then
	// saveDocument persists it to disk.
	const applyAgentDocument = useCallback(async (doc: unknown) => {
		const parsed = ensureDocument(doc);
		const store = useProjectStore.getState();
		store.setDocument(parsed);
		await store.saveDocument(parsed);
	}, []);

	const send = async () => {
		if (!projectId || !input.trim() || busy) return;
		const text = input.trim();
		setInput("");
		setBusy(true);
		try {
			// Mirror axcut's `getOrCreateSession`: the composer works with zero
			// setup, so the first message on a project with no sessions yet
			// silently starts one instead of no-op'ing.
			let sessionId = activeSessionId;
			if (!sessionId) {
				const created = await nativeBridgeClient.aiEdition.chatCreateSession(projectId);
				sessionId = created.id;
				setSessions((prev) => [...prev, created]);
				setActiveSessionId(created.id);
			}
			// Send the current document snapshot so the agent can run edit tools
			// against it (P1). Falls back to text-only chat when no doc is open.
			const documentSnapshot = useProjectStore.getState().document ?? undefined;
			const result = await nativeBridgeClient.aiEdition.chatRun(
				projectId,
				sessionId,
				text,
				documentSnapshot,
			);
			setMessages((prev) => [
				...prev,
				{ role: "user", content: text, time: new Date().toLocaleTimeString() },
			]);
			const assistant = result.assistantMessage;
			if (result.success && assistant) {
				if (result.document) {
					try {
						await applyAgentDocument(result.document);
					} catch (err) {
						toast.error("Could not apply the agent's edits", {
							description: err instanceof Error ? err.message : String(err),
						});
					}
				}
				setMessages((prev) => [
					...prev,
					{
						role: "assistant",
						content: assistant.content,
						time: new Date().toLocaleTimeString(),
						toolCalls: assistant.toolCalls,
					},
				]);
				void refreshSessions(projectId);
			} else {
				toast.error(result.error ?? "Chat failed");
			}
		} catch (err) {
			toast.error("Chat failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	// P1.8 — one click reverts the last tool batch by re-applying the
	// pre-batch checkpoint held by the chat service.
	const undoLastBatch = useCallback(async () => {
		if (!projectId || !activeSessionId) return;
		try {
			const result = await nativeBridgeClient.aiEdition.chatUndoLastBatch(
				projectId,
				activeSessionId,
			);
			if (result.success && result.document) {
				await applyAgentDocument(result.document);
				toast.success("Reverted the agent's last edits");
			} else {
				toast.error(result.error ?? "Nothing to undo");
			}
		} catch (err) {
			toast.error("Undo failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [projectId, activeSessionId, applyAgentDocument]);

	const modelLabel = llmConfig
		? `${llmConfig.provider} / ${llmConfig.model}`
		: "Configure AI Model";
	const providerSupportsReasoning = Boolean(
		llmConfig &&
			PROVIDER_DEFINITIONS.find((d) => d.id === llmConfig.provider)?.supportsReasoningEffort,
	);
	const currentReasoningEffort: ReasoningEffort =
		(llmConfig?.reasoningEffort as ReasoningEffort | undefined) ?? "medium";
	const reasoningLabel = providerSupportsReasoning
		? REASONING_EFFORT_LABELS[currentReasoningEffort]
		: null;

	const selectReasoningEffort = useCallback(
		async (effort: ReasoningEffort) => {
			if (!llmConfig) return;
			setReasoningBusy(true);
			try {
				const result = await nativeBridgeClient.aiEdition.llmSetConfig({
					...llmConfig,
					reasoningEffort: effort,
				});
				if (result.success) {
					setLlmConfig({ ...llmConfig, reasoningEffort: effort });
					setReasoningOpen(false);
				} else {
					toast.error(result.error ?? "Could not update reasoning effort");
				}
			} catch (err) {
				toast.error("Could not update reasoning effort", {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setReasoningBusy(false);
			}
		},
		[llmConfig],
	);

	const toggleReasoningOpen = useCallback(() => {
		setReasoningOpen((wasOpen) => {
			if (!wasOpen) {
				const rect = reasoningButtonRef.current?.getBoundingClientRect();
				if (rect) {
					setReasoningMenuRect({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
				}
			}
			return !wasOpen;
		});
	}, []);

	const toggleModelPopoverOpen = useCallback(() => {
		// Mirrors axcut's providerButtonRef handler: with no provider configured
		// yet there's nothing to quick-pick a model from, so go straight to the
		// full settings modal (the "providers" screen) instead of toggling a
		// popover that would render empty.
		if (!llmConfig) {
			setSettingsOpen(true);
			return;
		}
		setModelPopoverOpen((wasOpen) => {
			if (!wasOpen) {
				const rect = modelButtonRef.current?.getBoundingClientRect();
				if (rect) {
					// The popover opens upward from the pill and can hold a long,
					// scrollable model list — cap its height to the space actually
					// available above the button so it never overflows off the top
					// of the window (only "bottom" is set; nothing clamps "top").
					setModelPopoverRect({
						left: rect.left,
						bottom: window.innerHeight - rect.top + 4,
						maxHeight: Math.max(160, rect.top - 12),
					});
				}
			}
			return !wasOpen;
		});
	}, [llmConfig]);

	// Real context usage — feeds the badge in the chat strip and gates the
	// auto-compact heuristic on the main side. Recomputed on every messages
	// change so the % tracks the live history.
	const budget = computeBudget(messages);

	const compactNow = useCallback(async () => {
		if (!projectId || !activeSessionId) return;
		try {
			const result = await nativeBridgeClient.aiEdition.chatCompact(projectId, activeSessionId);
			if (!result) {
				toast.info("Not enough history to compact yet.");
				return;
			}
			setMessages(
				result.session.messages.map((m) => ({
					role: m.role,
					content: m.content,
					time: m.createdAt,
					toolCalls: m.toolCalls,
				})),
			);
			toast.success("Compacted earlier context");
		} catch (err) {
			toast.error("Compact failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [projectId, activeSessionId]);

	const newChat = useCallback(async () => {
		if (!projectId) return;
		try {
			const created = await nativeBridgeClient.aiEdition.chatCreateSession(projectId);
			setSessions((prev) => [...prev, created]);
			setActiveSessionId(created.id);
			setMessages([]);
		} catch (err) {
			toast.error("Could not create conversation", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [projectId]);

	const selectSession = useCallback((id: string) => {
		setActiveSessionId(id);
	}, []);

	const handleDelete = useCallback(
		async (id: string) => {
			if (!projectId) return;
			try {
				const res = await nativeBridgeClient.aiEdition.chatDeleteSession(projectId, id);
				if (!res.success) return;
				setSessions((prev) => prev.filter((s) => s.id !== id));
				if (activeSessionId === id) {
					setActiveSessionId(null);
					setMessages([]);
				}
			} catch (err) {
				toast.error("Could not delete conversation", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[projectId, activeSessionId],
	);

	const handleRename = useCallback(
		async (id: string, title: string) => {
			if (!projectId) return;
			const trimmed = title.trim();
			if (!trimmed) return;
			try {
				const updated = await nativeBridgeClient.aiEdition.chatRenameSession(
					projectId,
					id,
					trimmed,
				);
				if (updated) {
					setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
				}
			} catch (err) {
				toast.error("Could not rename conversation", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[projectId],
	);

	return (
		<aside className={styles.panel}>
			<div className={styles.chatStrip}>
				<div className={styles.chatStripRow}>
					<span
						className={styles.ctxPill}
						title={`${budget.usedTokens} / ${budget.budgetTokens} estimated tokens`}
					>
						<span className={styles.d} aria-hidden />
						{Math.min(100, Math.round(budget.ratio * 100))}% context
					</span>
					<span className={styles.stripActions}>
						<button
							type="button"
							title="Compact"
							aria-label="Compact"
							onClick={() => void compactNow()}
						>
							<svg
								width={14}
								height={14}
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M 6 6 L 12 10 L 18 6" />
								<path d="M 4 12 L 20 12" />
								<path d="M 6 18 L 12 14 L 18 18" />
							</svg>
						</button>
						<button
							type="button"
							title="AI settings"
							aria-label="AI settings"
							onClick={() => setSettingsOpen(true)}
						>
							<svg
								width={14}
								height={14}
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<circle cx="12" cy="12" r="3" />
								<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
							</svg>
						</button>
					</span>
					<span className={styles.stripActions}>
						<button
							type="button"
							title="History"
							aria-label="History"
							onClick={() => setChatsOpen(true)}
						>
							<svg
								width={14}
								height={14}
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
								<path d="M3 3v5h5" />
								<path d="M12 7v5l4 2" />
							</svg>
						</button>
						<button
							type="button"
							title="New conversation"
							aria-label="New conversation"
							onClick={newChat}
						>
							<svg
								width={14}
								height={14}
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
								<path d="M12 7v6" />
								<path d="M9 10h6" />
							</svg>
						</button>
					</span>
				</div>
				<div className={styles.chatHint}>Describe the edit you want…</div>
			</div>

			{activeSessionId ? (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
						padding: "6px var(--sp-3)",
						borderTop: "1px solid var(--border-soft)",
						background: "var(--surface-warm)",
					}}
				>
					<span
						style={{
							font: "500 12px/1.3 var(--font-body)",
							color: "var(--fg-2)",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							flex: 1,
							cursor: "text",
						}}
						title="Click to rename"
						onClick={() => {
							const current = sessions.find((s) => s.id === activeSessionId);
							if (!current) return;
							const next = window.prompt("Rename conversation", current.title);
							if (next !== null) void handleRename(activeSessionId, next);
						}}
					>
						{sessions.find((s) => s.id === activeSessionId)?.title ?? "Conversation"}
					</span>
					<button
						type="button"
						title="Rename conversation"
						aria-label="Rename conversation"
						onClick={() => {
							const current = sessions.find((s) => s.id === activeSessionId);
							if (!current) return;
							const next = window.prompt("Rename conversation", current.title);
							if (next !== null) void handleRename(activeSessionId, next);
						}}
						style={{
							background: "transparent",
							border: 0,
							color: "var(--meta)",
							cursor: "pointer",
							padding: 2,
						}}
					>
						<svg
							width={12}
							height={12}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M12 20h9" />
							<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
						</svg>
					</button>
					<button
						type="button"
						title="Delete conversation"
						aria-label="Delete conversation"
						onClick={() => {
							const current = sessions.find((s) => s.id === activeSessionId);
							if (!current) return;
							if (window.confirm(`Delete "${current.title}"?`)) {
								void handleDelete(activeSessionId);
							}
						}}
						style={{
							background: "transparent",
							border: 0,
							color: "var(--meta)",
							cursor: "pointer",
							padding: 2,
						}}
					>
						<svg
							width={12}
							height={12}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polyline points="3 6 5 6 21 6" />
							<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
							<path d="M10 11v6" />
							<path d="M14 11v6" />
							<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
						</svg>
					</button>
				</div>
			) : null}

			<div className={styles.panelBody} ref={scrollRef}>
				{messages.length === 0 ? (
					<p
						style={{
							font: "400 12px var(--font-body)",
							color: "var(--muted)",
							padding: "24px var(--sp-4)",
							textAlign: "center",
							lineHeight: 1.5,
						}}
					>
						No messages yet. Ask the agent to cut silences, tighten pauses, or add captions.
					</p>
				) : (
					<>
						{messages.map((m, i) => (
							<div className={styles.msg} key={i}>
								<div className={styles.msgHead}>
									<span className={styles.msgAuthor}>
										{m.role === "user" ? "You" : "OpenScreen"}
									</span>
									{m.time ? (
										<span
											className="right"
											style={{ font: "500 10px/1 var(--font-mono)", color: "var(--muted)" }}
										>
											{m.time}
										</span>
									) : null}
								</div>
								<div className={styles.msgBubble}>{m.content}</div>
								{m.toolCalls?.length ? (
									<div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
										{m.toolCalls.map((call, j) => (
											<div
												key={j}
												style={{
													font: "500 10px/1.5 var(--font-mono)",
													color: "var(--success)",
												}}
											>
												applied: {call.summary}
											</div>
										))}
										{i === messages.length - 1 ? (
											<button
												type="button"
												onClick={() => void undoLastBatch()}
												style={{
													alignSelf: "flex-start",
													marginTop: 2,
													padding: "3px 8px",
													background: "transparent",
													border: "1px solid var(--border-soft)",
													borderRadius: "var(--r-md)",
													color: "var(--fg-2)",
													font: "500 10px var(--font-body)",
													cursor: "pointer",
												}}
											>
												Undo these edits
											</button>
										) : null}
									</div>
								) : null}
							</div>
						))}
						{busy ? (
							<div className={styles.msg} aria-live="polite">
								<div className={styles.msgHead}>
									<span className={styles.msgAuthor}>OpenScreen</span>
								</div>
								<div
									className={styles.msgBubble}
									style={{ color: "var(--muted)", fontStyle: "italic" }}
								>
									<Loader2
										size={12}
										className="animate-spin"
										style={{ marginRight: 6, verticalAlign: "middle" }}
									/>
									Thinking…
								</div>
							</div>
						) : null}
					</>
				)}
			</div>

			<div className={styles.chatInput}>
				<textarea
					placeholder="Describe the edit you want."
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
				/>
				<div className="actions">
					<button
						ref={modelButtonRef}
						type="button"
						className={styles.modelPicker}
						aria-label="Model"
						aria-haspopup="menu"
						aria-expanded={modelPopoverOpen}
						onClick={toggleModelPopoverOpen}
					>
						<svg
							width={12}
							height={12}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="3" y1="6" x2="21" y2="6" />
							<line x1="3" y1="12" x2="21" y2="12" />
							<line x1="3" y1="18" x2="21" y2="18" />
						</svg>
						<span>{modelLabel}</span>
					</button>
					{reasoningLabel ? (
						<button
							ref={reasoningButtonRef}
							type="button"
							className={styles.modelPicker}
							aria-label="Reasoning effort"
							aria-haspopup="menu"
							aria-expanded={reasoningOpen}
							onClick={toggleReasoningOpen}
						>
							<span className="chip">
								<span className="d" />
								Reasoning {reasoningLabel}
							</span>
						</button>
					) : null}
					{reasoningOpen && reasoningMenuRect
						? createPortal(
								<div
									role="menu"
									style={{
										position: "fixed",
										left: reasoningMenuRect.left,
										bottom: reasoningMenuRect.bottom,
										minWidth: 160,
										background: "var(--surface)",
										border: "1px solid var(--border)",
										borderRadius: "var(--r-md)",
										boxShadow: "var(--elev-pop)",
										padding: 4,
										zIndex: 1000,
									}}
								>
									{REASONING_EFFORT_OPTIONS.map((option) => (
										<button
											type="button"
											key={option}
											role="menuitem"
											disabled={reasoningBusy}
											onClick={() => void selectReasoningEffort(option)}
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												gap: 8,
												width: "100%",
												padding: "6px 10px",
												border: "none",
												background:
													option === currentReasoningEffort ? "var(--surface-3)" : "transparent",
												color: "var(--fg)",
												borderRadius: "var(--r-sm)",
												cursor: "pointer",
												fontSize: 12.5,
											}}
										>
											{REASONING_EFFORT_LABELS[option]}
											{option === currentReasoningEffort ? <Check size={12} /> : null}
										</button>
									))}
								</div>,
								document.body,
							)
						: null}
					{modelPopoverOpen && modelPopoverRect && llmConfig ? (
						<ModelQuickPopover
							anchorRect={modelPopoverRect}
							llmConfig={llmConfig}
							connectedProviders={connectedProviders}
							onClose={() => setModelPopoverOpen(false)}
							onConfigChange={() => void refreshLlm()}
							onOpenFullSettings={() => setSettingsOpen(true)}
						/>
					) : null}
					<button
						type="button"
						className={styles.sendBtn}
						title="Send (Enter)"
						aria-label="Send"
						onClick={send}
						disabled={busy || !input.trim()}
					>
						<svg
							width={14}
							height={14}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="22" y1="2" x2="11" y2="13" />
							<polygon points="22 2 15 22 11 13 2 9 22 2" />
						</svg>
					</button>
				</div>
			</div>
			<ProviderSettings
				open={settingsOpen}
				onClose={() => {
					setSettingsOpen(false);
					void refreshLlm();
				}}
			/>
			<ChatHistoryModal
				open={chatsOpen}
				onClose={() => setChatsOpen(false)}
				sessions={sessions}
				activeSessionId={activeSessionId}
				onSelect={selectSession}
				onNew={newChat}
			/>
		</aside>
	);
}

const RAIL_BUTTONS: Array<{ id: LeftTab; label: string; icon: React.ElementType }> = [
	...(AI_FEATURES_ENABLED ? [{ id: "chat" as LeftTab, label: "Chat", icon: MessageSquare }] : []),
	{ id: "media", label: "Media", icon: Film },
];

export function LeftRail({
	active,
	onChange,
}: {
	active: LeftTab;
	onChange: (id: LeftTab) => void;
}) {
	return (
		<aside className={`${styles.rail} ${styles.leftRail}`} aria-label="Left tools">
			{RAIL_BUTTONS.map(({ id, label, icon: Icon }) => (
				<button
					type="button"
					key={id}
					title={label}
					aria-label={label}
					aria-pressed={active === id}
					onClick={() => onChange(id)}
				>
					<Icon size={18} />
				</button>
			))}
		</aside>
	);
}
