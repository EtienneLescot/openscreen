// Provider Settings popover/modal for the new editor's chat strip.
//
// UI: 3 screens stacked in the modal, navigated by URL-less state
// (mirroring axcut apps/web/src/App.tsx _p modal):
//  1. **list**            — 2-col grid of provider cards (8 of them),
//                          each shows label, default model, an auth-kind
//                          pill (CONNECTED / OAUTH / TOKEN / API KEY).
//  2. **connect-form**    — single form per provider: model + optional
//                          baseUrl + optional reasoning effort + optional
//                          api-key field + Connect/Save/Disconnect buttons.
//  3. **device-challenge** — opens when an oauth-device / PAT provider
//                          finishes its begin step: the user-code block,
//                          "Open login page" link, and a copy-code button.
//                          On completion the snapshot refreshes.
//
// Credentials are stored in the same safeStorage blob (LLMConfigStore),
// including OAuth session tokens. The renderer never sees raw keys —
// only `kind` and the user code / verification URL.
//
// ponytail: existing consumers (ProviderSettings used as <ProviderSettings open onClose />)
// must keep working. Internal state is local-only.

import {
	AlertCircle,
	Check,
	Copy,
	ExternalLink,
	Loader2,
	LogIn,
	Plug,
	Unplug,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { nativeBridgeClient } from "@/native/client";
import type {
	AiEditionDeviceChallenge,
	AiEditionLlmConfig,
	AiEditionLlmSnapshot,
} from "@/native/contracts";
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
	onActiveProviderChanged?: (providerId: string | null) => void;
}

export function ProviderSettings({
	open,
	onClose,
	onActiveProviderChanged,
}: ProviderSettingsProps) {
	const te = useScopedT("editor");
	const [snapshot, setSnapshot] = useState<AiEditionLlmSnapshot | null>(null);
	const [mode, setMode] = useState<Mode>("list");
	const [active, setActive] = useState<ProviderDefinition | null>(null);
	const [config, setConfig] = useState<AiEditionLlmConfig | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [challenge, setChallenge] = useState<AiEditionDeviceChallenge | null>(null);
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
			setChallenge(null);
			setError(null);
		}
	}, [open]);

	const goBackToList = useCallback(() => {
		if (busy) return;
		setMode("list");
		setActive(null);
		setApiKey("");
		setChallenge(null);
		setError(null);
	}, [busy]);

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
		setChallenge(null);
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
		setChallenge(null);
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
			const snap = await refreshSnapshot();
			onActiveProviderChanged?.(snap?.config?.provider ?? null);
			toast.success(te("providerSettings.saved", { provider: active.label }));
			setMode("list");
			setActive(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const startDeviceFlow = async () => {
		if (!active) return;
		setBusy(true);
		setError(null);
		try {
			const challengeResult = await nativeBridgeClient.aiEdition.llmBeginDeviceAuth(
				active.id as "openai-oauth" | "copilot-proxy",
				config?.model,
			);
			setChallenge(challengeResult);
			if (active.id === "copilot-proxy") {
				// GitHub device flow accepts an optional PAT. If the user has pasted one,
				// pass it through as if they were connecting with the classic token path.
				if (apiKey.trim() && active.id === "copilot-proxy") {
					// Skipped for now — Copilot device flow uses its own token.
				}
			}
			// Auto-complete poll: kick off completion in the background, the UI shows
			// "Completing sign-in…" and the snapshot refresh when the call returns.
			void completeDeviceFlowInBackground(challengeResult);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const completeDeviceFlowInBackground = async (challengeParam: AiEditionDeviceChallenge) => {
		if (!active) return;
		setBusy(true);
		try {
			const result = await nativeBridgeClient.aiEdition.llmCompleteDeviceAuth(
				active.id as "openai-oauth" | "copilot-proxy",
				challengeParam,
				config?.model,
			);
			if (result.success) {
				const snap = await refreshSnapshot();
				onActiveProviderChanged?.(snap?.config?.provider ?? null);
				toast.success(te("providerSettings.connected", { provider: active.label }));
				setMode("list");
				setActive(null);
				setChallenge(null);
			} else {
				setError(result.error ?? te("providerSettings.deviceFlowFailed"));
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const startPatConnect = async () => {
		if (!active || !apiKey.trim() || !config) return;
		setBusy(true);
		setError(null);
		try {
			await nativeBridgeClient.aiEdition.llmSetApiKey(active.id, apiKey.trim());
			await nativeBridgeClient.aiEdition.llmSetConfig(config);
			const snap = await refreshSnapshot();
			onActiveProviderChanged?.(snap?.config?.provider ?? null);
			toast.success(te("providerSettings.connected", { provider: active.label }));
			setApiKey("");
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
			const snap = result.snapshot ?? (await refreshSnapshot());
			onActiveProviderChanged?.(snap.config?.provider ?? null);
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
					challenge={challenge}
					error={error}
					onBack={goBackToList}
					onSave={active.authKind === "api-key" ? saveApiKey : startDeviceFlow}
					onPatConnect={active.authKind === "pat" ? startPatConnect : undefined}
					onDisconnect={disconnect}
					onOpenLoginPage={(uri) =>
						typeof window !== "undefined" && window.open(uri, "_blank", "noopener,noreferrer")
					}
					listProviderModels={nativeBridgeClient.aiEdition.llmListProviderModels}
				/>
			) : null}
		</ModalShell>
	);
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
							) : authKindPillKind(def.authKind) === "auth" ? (
								<span className={`${styles.statusPill} ${styles.auth}`}>
									<LogIn size={10} />
									{te("providerSettings.pillOAuth")}
								</span>
							) : def.authKind === "pat" ? (
								<span className={`${styles.statusPill} ${styles.pat}`}>
									<Plug size={10} />
									{te("providerSettings.pillToken")}
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

function authKindPillKind(kind: ProviderDefinition["authKind"]): "auth" | "pat" | "key" {
	switch (kind) {
		case "oauth-device":
			return "auth";
		case "pat":
			return "pat";
		case "api-key":
			return "key";
	}
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
	challenge,
	error,
	onBack,
	onSave,
	onPatConnect,
	onDisconnect,
	onOpenLoginPage,
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
	challenge: AiEditionDeviceChallenge | null;
	error: string | null;
	onBack: () => void;
	onSave: () => void;
	onPatConnect?: () => void;
	onDisconnect: () => void;
	onOpenLoginPage: (uri: string) => void;
	listProviderModels: (providerId: string) => Promise<{ models: string[]; error?: string }>;
}) {
	const te = useScopedT("editor");
	const showApiKeyField = def.authKind === "api-key" || (def.authKind === "pat" && !isConnected);
	const showBaseUrl = def.id === "openai-compatible" || Boolean(def.baseUrl);
	const isCodexOrCopilot = def.authKind === "oauth-device";
	// Every provider now exposes a live model list once connected (matching
	// axcut's `screen === 'models' && activeProvider?.connected` gate) — API-key
	// providers hit their own /models endpoint (or, for MiniMax, a probe call)
	// same as OAuth/PAT providers do.
	const supportsDynamicModels = true;

	const [modelOptions, setModelOptions] = useState<string[]>([]);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelsError, setModelsError] = useState<string | null>(null);

	useEffect(() => {
		if (!supportsDynamicModels || !isConnected) {
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
	}, [def.id, isConnected, supportsDynamicModels, listProviderModels]);

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
							: supportsDynamicModels && isConnected
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

			{showApiKeyField ? (
				<Field
					label={
						def.authKind === "pat"
							? te("providerSettings.patLabel")
							: te("providerSettings.apiKeyLabel")
					}
					hint={
						isConnected
							? te("providerSettings.apiKeyHintStored")
							: def.authKind === "pat"
								? te("providerSettings.patHint")
								: undefined
					}
				>
					<input
						type="password"
						value={apiKey}
						placeholder={isConnected ? "••••••" : "sk-…"}
						onChange={(e) => setApiKey(e.target.value)}
						disabled={busy}
					/>
				</Field>
			) : null}

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

			{challenge ? (
				<DeviceChallengePanel
					challenge={challenge}
					busy={busy}
					providerLabel={def.label}
					onOpenLoginPage={onOpenLoginPage}
				/>
			) : null}
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
				) : isCodexOrCopilot ? (
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={onSave}
						disabled={busy || !config}
					>
						{busy ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
						{isConnected ? te("providerSettings.reconnect") : te("providerSettings.startLogin")}
					</button>
				) : def.authKind === "pat" && onPatConnect ? (
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={onPatConnect}
						disabled={busy || !apiKey.trim() || !config}
					>
						{busy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
						{te("providerSettings.connect")}
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

function DeviceChallengePanel({
	challenge,
	busy,
	providerLabel,
	onOpenLoginPage,
}: {
	challenge: AiEditionDeviceChallenge;
	busy: boolean;
	providerLabel: string;
	onOpenLoginPage: (uri: string) => void;
}) {
	const te = useScopedT("editor");
	const [copied, setCopied] = useState(false);

	const onCopy = async () => {
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard) {
				await navigator.clipboard.writeText(challenge.userCode);
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1400);
			}
		} catch {
			/* clipboards may be denied in some sandboxes — silently no-op */
		}
	};

	const loginUrl = challenge.verificationUriComplete ?? challenge.verificationUri;

	return (
		<div
			className={styles.authPanel}
			role="status"
			aria-live="polite"
			data-testid="device-challenge-panel"
		>
			<div>
				<strong>
					{busy
						? te("providerSettings.completingSignIn")
						: te("providerSettings.browserLoginPending")}
				</strong>
				<p>{te("providerSettings.deviceCodeInstructions", { provider: providerLabel })}</p>
			</div>
			<div className={styles.authCodeRow}>
				<code data-testid="device-user-code">{challenge.userCode}</code>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={onCopy}
					title={te("providerSettings.copyCode")}
					aria-label={te("providerSettings.copyCode")}
					disabled={busy}
				>
					{copied ? <Check size={14} /> : <Copy size={14} />}
					{copied ? te("providerSettings.copied") : te("providerSettings.copyCode")}
				</button>
			</div>
			<div>
				<a
					href={loginUrl}
					target="_blank"
					rel="noreferrer noopener"
					className={styles.linkBtn}
					onClick={(e) => {
						e.preventDefault();
						onOpenLoginPage(loginUrl);
					}}
				>
					<ExternalLink size={14} />
					{te("providerSettings.openLoginPage")}
				</a>
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
