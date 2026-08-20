// Provider Settings popover/modal for the new editor's chat strip.
//
// UI: 3 screens stacked in the modal, navigated by URL-less state
// (mirroring axcut apps/web/src/App.tsx _p modal):
//  1. **list**         — grid of provider cards, each showing label, default
//                       model, and a CONNECTED / API KEY pill.
//  2. **connect-form** — single form per provider: model + optional baseUrl +
//                       optional reasoning effort + api-key field +
//                       Save/Disconnect buttons.
//
// Every provider is API-key based since 1.8.0 dropped the ChatGPT and Copilot
// OAuth providers (see provider-registry.ts); the device-challenge screen went
// with them. Credentials live in the safeStorage blob (LlmConfigStore) — the
// renderer never sees raw keys, only `kind`.
//
// `ProviderSettingsDialog` at the bottom is the only mount, and the only caller of the
// `open` / `onClose` component above it. Internal state is local-only.

import { AlertCircle, Check, Loader2, Unplug, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useEditorDialogActions, useEditorDialogSection } from "@/contexts/EditorDialogsContext";
import { useScopedT } from "@/contexts/I18nContext";
import { nativeBridgeClient } from "@/native/client";
import type { AiEditionLlmConfig, AiEditionLlmSnapshot } from "@/native/contracts";
import {
	getReasoningEffortLabel,
	getReasoningEffortOptions,
	PROVIDER_DEFINITIONS,
	type ProviderDefinition,
} from "../../../electron/ai-edition/provider-registry";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

type Mode = "list" | "form";

interface ProviderSettingsProps {
	open: boolean;
	onClose: () => void;
}

function ProviderSettings({ open, onClose }: ProviderSettingsProps) {
	const te = useScopedT("editor");
	const [snapshot, setSnapshot] = useState<AiEditionLlmSnapshot | null>(null);
	const [mode, setMode] = useState<Mode>("list");
	const [active, setActive] = useState<ProviderDefinition | null>(null);
	const [config, setConfig] = useState<AiEditionLlmConfig | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refreshSnapshot = useCallback(async (): Promise<AiEditionLlmSnapshot> => {
		try {
			const snap = await nativeBridgeClient.aiEdition.llmGetSnapshot();
			setSnapshot(snap);
			if (snap.config) setConfig(snap.config);
			return snap;
		} catch (err) {
			toast.error(te("providerSettings.loadFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	}, [te]);

	useEffect(() => {
		if (!open) return;
		void refreshSnapshot();
	}, [open, refreshSnapshot]);

	useEffect(() => {
		if (!open) {
			setMode("list");
			setActive(null);
			setApiKey("");
			setError(null);
		}
	}, [open]);

	const goBackToList = useCallback(() => {
		if (busy) return;
		setMode("list");
		setActive(null);
		setApiKey("");
		setError(null);
	}, [busy]);

	// Escape is ours alone — see `closeOnEscape={false}` on the ModalShell below. While
	// ModalShell also handled it, both listeners fired for one keypress and its `onClose` won,
	// so Escape in the connect form left the dialog entirely (discarding a half-typed key)
	// instead of stepping back to the grid, and the branch below was dead.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !busy) {
				if (mode === "form") goBackToList();
				else onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, busy, mode, onClose, goBackToList]);

	const openForm = (def: ProviderDefinition) => {
		setActive(def);
		setApiKey("");
		setError(null);
		setConfig((prev) => {
			const existing = prev?.provider === def.id ? prev : null;
			return {
				provider: def.id,
				model: existing?.model ?? def.defaultModel,
				baseUrl: existing?.baseUrl ?? def.baseUrl,
				reasoningEffort: existing?.reasoningEffort,
				allowAgentEdits: existing?.allowAgentEdits,
			};
		});
		setMode("form");
	};

	const close = () => {
		if (busy) return;
		onClose();
		setMode("list");
		setActive(null);
		setApiKey("");
		setError(null);
	};

	const saveApiKey = async () => {
		if (!active || !config) return;
		setBusy(true);
		setError(null);
		try {
			if (apiKey.trim()) {
				await nativeBridgeClient.aiEdition.llmSetApiKey(active.id, apiKey.trim());
				setApiKey("");
			}
			await nativeBridgeClient.aiEdition.llmSetConfig(config);
			await refreshSnapshot();
			toast.success(te("providerSettings.saved", { provider: active.label }));
			setMode("list");
			setActive(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const disconnect = async () => {
		if (!active) return;
		setBusy(true);
		setError(null);
		try {
			const result = await nativeBridgeClient.aiEdition.llmDisconnect(active.id);
			// `snapshot` is not optional on the result, so a `?? refreshSnapshot()` fallback here
			// never ran — and `refreshSnapshot` is the only thing that calls `setSnapshot`. The
			// form and the grid behind it went on showing the provider as CONNECTED until the
			// dialog was closed and reopened.
			setSnapshot(result.snapshot);
			toast.success(te("providerSettings.disconnected", { provider: active.label }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<ModalShell
			open={open}
			onClose={close}
			closeOnEscape={false}
			title={te("providerSettings.title")}
			subtitle={te("providerSettings.subtitle")}
			wide
		>
			{mode === "list" ? (
				<ProviderList
					connected={new Set(snapshot?.connectedProviders ?? [])}
					activeProvider={snapshot?.config?.provider ?? null}
					onPick={openForm}
				/>
			) : active ? (
				<ProviderForm
					def={active}
					isConnected={(snapshot?.connectedProviders ?? []).includes(active.id)}
					credentialKind={
						snapshot?.credentialSummary.find((c) => c.providerId === active.id)?.credentialKind ??
						null
					}
					apiKey={apiKey}
					setApiKey={setApiKey}
					config={config}
					setConfig={setConfig}
					busy={busy}
					error={error}
					onBack={goBackToList}
					onSave={saveApiKey}
					onDisconnect={disconnect}
					listProviderModels={nativeBridgeClient.aiEdition.llmListProviderModels}
				/>
			) : null}
		</ModalShell>
	);
}

/**
 * The one mount of {@link ProviderSettings} in the editor window, bound to the context that
 * carries which editor dialog is open.
 *
 * It sits beside `ShortcutsConfigDialog` in `App.tsx` rather than inside the chat panel, so the
 * app menu can offer it in every mode (issue #420). The dialog above stays a plain
 * `open` / `onClose` component: the settings unification this is the first step of will render
 * it as a section of a larger dialog, which is not a thing that can mount itself.
 */
export function ProviderSettingsDialog() {
	const section = useEditorDialogSection();
	const { closeDialog } = useEditorDialogActions();
	return <ProviderSettings open={section === "providers"} onClose={closeDialog} />;
}

function ProviderList({
	connected,
	activeProvider,
	onPick,
}: {
	connected: Set<string>;
	activeProvider: string | null;
	onPick: (def: ProviderDefinition) => void;
}) {
	const te = useScopedT("editor");
	return (
		<div className={styles.providerGrid}>
			{PROVIDER_DEFINITIONS.map((def) => {
				const isConnected = connected.has(def.id);
				const isActive = def.id === activeProvider;
				return (
					<button
						key={def.id}
						type="button"
						className={`${styles.providerCard} ${isActive ? styles.active : ""}`}
						onClick={() => onPick(def)}
					>
						<div className={styles.head}>
							<span className={styles.label}>{def.label}</span>
							{isConnected ? (
								<span className={`${styles.statusPill} ${styles.ready}`}>
									<Check size={10} />
									{te("providerSettings.pillConnected")}
								</span>
							) : (
								<span className={`${styles.statusPill} ${styles.idle}`}>
									<KeyIcon />
									{te("providerSettings.pillApiKey")}
								</span>
							)}
						</div>
						<span className={styles.model}>{def.defaultModel || "—"}</span>
					</button>
				);
			})}
		</div>
	);
}

function KeyIcon() {
	// tiny single-stroke "••• " icon as a span, avoids pulling in another lucide dep.
	return (
		<span
			aria-hidden
			style={{
				display: "inline-block",
				fontFamily: "var(--font-mono)",
				letterSpacing: "0.1em",
				fontSize: "11px",
			}}
		>
			•••
		</span>
	);
}

function ProviderForm({
	def,
	isConnected,
	credentialKind,
	apiKey,
	setApiKey,
	config,
	setConfig,
	busy,
	error,
	onBack,
	onSave,
	onDisconnect,
	listProviderModels,
}: {
	def: ProviderDefinition;
	isConnected: boolean;
	credentialKind: string | null;
	apiKey: string;
	setApiKey: (v: string) => void;
	config: AiEditionLlmConfig | null;
	setConfig: (c: AiEditionLlmConfig | null) => void;
	busy: boolean;
	error: string | null;
	onBack: () => void;
	onSave: () => void;
	onDisconnect: () => void;
	listProviderModels: (providerId: string) => Promise<{ models: string[]; error?: string }>;
}) {
	const te = useScopedT("editor");
	const showBaseUrl = def.id === "openai-compatible" || Boolean(def.baseUrl);
	// Every provider exposes a live model list once connected: each hits its own
	// /models endpoint, or a probe call for MiniMax.
	const [modelOptions, setModelOptions] = useState<string[]>([]);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelsError, setModelsError] = useState<string | null>(null);

	useEffect(() => {
		if (!isConnected) {
			setModelOptions([]);
			setModelsError(null);
			return;
		}
		let cancelled = false;
		setModelsLoading(true);
		setModelsError(null);
		void listProviderModels(def.id)
			.then((result) => {
				if (cancelled) return;
				setModelOptions(result.models);
				setModelsError(result.error ?? null);
			})
			.catch((err) => {
				if (cancelled) return;
				setModelOptions([]);
				setModelsError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setModelsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [def.id, isConnected, listProviderModels]);

	const modelSelectable = modelOptions.length > 0;

	return (
		<div className={styles.providerForm}>
			<div className={styles.title}>
				<button
					type="button"
					className={styles.backBtn}
					onClick={onBack}
					disabled={busy}
					title={te("providerSettings.back")}
					aria-label={te("providerSettings.back")}
				>
					<X size={14} />
					{te("providerSettings.back")}
				</button>
				<h3>{def.label}</h3>
				{isConnected ? (
					<span className={`${styles.statusPill} ${styles.ready}`}>
						<Check size={10} />
						{te("providerSettings.pillConnected")}{" "}
						{credentialKind && credentialKind !== "api-key" ? `· ${credentialKind}` : ""}
					</span>
				) : (
					<span className={`${styles.statusPill} ${styles.idle}`}>
						{te("providerSettings.notConnected")}
					</span>
				)}
			</div>

			<Field
				label={te("providerSettings.modelLabel")}
				hint={
					modelSelectable
						? te("providerSettings.modelHintLive")
						: modelsError
							? te("providerSettings.modelHintError", { error: modelsError })
							: isConnected
								? te("providerSettings.modelHintLoading")
								: undefined
				}
			>
				{modelSelectable ? (
					<select
						value={config?.model ?? def.defaultModel}
						onChange={(e) =>
							setConfig({
								...(config ?? { provider: def.id, model: def.defaultModel }),
								model: e.target.value,
							})
						}
						disabled={busy}
					>
						{!modelOptions.includes(config?.model ?? def.defaultModel) ? (
							<option value={config?.model ?? def.defaultModel}>
								{te("providerSettings.modelSavedOption", {
									model: config?.model ?? def.defaultModel,
								})}
							</option>
						) : null}
						{modelOptions.map((modelSlug) => (
							<option key={modelSlug} value={modelSlug}>
								{modelSlug}
							</option>
						))}
					</select>
				) : (
					<input
						type="text"
						value={config?.model ?? def.defaultModel}
						placeholder={def.defaultModel}
						onChange={(e) =>
							setConfig({
								...(config ?? { provider: def.id, model: def.defaultModel }),
								model: e.target.value,
							})
						}
						disabled={busy}
					/>
				)}
				{modelsLoading ? (
					<span
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: 4,
							marginTop: 4,
							font: "500 10px var(--font-mono)",
							color: "var(--muted)",
							letterSpacing: "0.04em",
							textTransform: "uppercase",
						}}
					>
						<Loader2 size={10} className="animate-spin" />
						{te("providerSettings.loadingModels")}
					</span>
				) : null}
			</Field>

			{showBaseUrl ? (
				<Field
					label={te("providerSettings.baseUrlLabel")}
					hint={te("providerSettings.baseUrlHint")}
				>
					<input
						type="text"
						value={config?.baseUrl ?? def.baseUrl ?? ""}
						placeholder={def.baseUrl ?? "https://…"}
						onChange={(e) =>
							setConfig({
								...(config ?? { provider: def.id, model: def.defaultModel }),
								baseUrl: e.target.value || undefined,
							})
						}
						disabled={busy}
					/>
				</Field>
			) : null}

			{def.supportsReasoningEffort ? (
				<Field label={te("providerSettings.reasoningEffortLabel")}>
					<select
						value={config?.reasoningEffort ?? "none"}
						onChange={(e) =>
							setConfig({
								...(config ?? { provider: def.id, model: def.defaultModel }),
								reasoningEffort: e.target.value,
							})
						}
						disabled={busy}
					>
						{getReasoningEffortOptions(def.id).map((r) => (
							<option key={r} value={r}>
								{getReasoningEffortLabel(def.id, r)}
							</option>
						))}
					</select>
				</Field>
			) : null}

			<Field
				label={te("providerSettings.apiKeyLabel")}
				hint={isConnected ? te("providerSettings.apiKeyHintStored") : undefined}
			>
				<input
					type="password"
					value={apiKey}
					placeholder={isConnected ? "••••••" : "sk-…"}
					onChange={(e) => setApiKey(e.target.value)}
					disabled={busy}
				/>
			</Field>

			<Field
				label={te("providerSettings.projectEditsLabel")}
				hint={te("providerSettings.projectEditsHint")}
			>
				<label
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						font: "500 12px var(--font-body)",
						color: "var(--fg-2)",
						cursor: "pointer",
					}}
				>
					<input
						type="checkbox"
						checked={config?.allowAgentEdits !== false}
						disabled={busy}
						onChange={(e) =>
							setConfig({
								...(config ?? { provider: def.id, model: def.defaultModel }),
								allowAgentEdits: e.target.checked,
							})
						}
					/>
					{te("providerSettings.allowAgentEdits")}
				</label>
			</Field>

			{error ? (
				<p className={styles.errorRow}>
					<AlertCircle size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />
					{error}
				</p>
			) : null}

			<div className={styles.actions}>
				<div className={styles.actionsLeft}>
					{isConnected ? (
						<button
							type="button"
							className={`${styles.btn} ${styles.dangerBtn}`}
							onClick={onDisconnect}
							disabled={busy}
						>
							<Unplug size={14} />
							{te("providerSettings.disconnect")}
						</button>
					) : null}
				</div>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={onBack}
					disabled={busy}
				>
					{te("providerSettings.cancel")}
				</button>
				{isConnected ? (
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={onSave}
						disabled={busy || !config}
					>
						{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
						{te("providerSettings.save")}
					</button>
				) : (
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={onSave}
						disabled={busy || !apiKey.trim() || !config}
					>
						{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
						{apiKey.trim() ? te("providerSettings.saveAndUse") : te("providerSettings.save")}
					</button>
				)}
			</div>
		</div>
	);
}

function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={styles.field}>
			<label>
				{label}
				{hint ? (
					<span
						style={{
							display: "block",
							font: "500 10px/1.2 var(--font-mono)",
							color: "var(--muted)",
							letterSpacing: "0.04em",
							textTransform: "uppercase",
							marginTop: 2,
						}}
					>
						{hint}
					</span>
				) : null}
			</label>
			{children}
		</div>
	);
}
