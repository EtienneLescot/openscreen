// Provider Settings popover/modal for the new editor's chat strip.
//
// UI: list of provider cards (the 8 from provider-registry.ts). On select, a
// detail form opens for the picked provider: API key input, model select,
// baseUrl (for openai-compatible), reasoning effort (if supported). Save
// commits the config + key to the LLMConfigStore via the native bridge.

import { Check, KeyRound, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { nativeBridgeClient } from "@/native/client";
import type { AiEditionLlmConfig, AiEditionLlmSnapshot } from "@/native/contracts";
import {
	PROVIDER_DEFINITIONS,
	type ProviderDefinition,
	REASONING_EFFORT_OPTIONS,
} from "../../../electron/ai-edition/provider-registry";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

type Mode = "list" | "form";

interface ProviderSettingsProps {
	open: boolean;
	onClose: () => void;
}

export function ProviderSettings({ open, onClose }: ProviderSettingsProps) {
	const [snapshot, setSnapshot] = useState<AiEditionLlmSnapshot | null>(null);
	const [mode, setMode] = useState<Mode>("list");
	const [active, setActive] = useState<ProviderDefinition | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [config, setConfig] = useState<AiEditionLlmConfig | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!open) return;
		void (async () => {
			try {
				const snap = await nativeBridgeClient.aiEdition.llmGetSnapshot();
				setSnapshot(snap);
				if (snap.config) {
					setConfig(snap.config);
				}
			} catch (err) {
				toast.error("Could not load AI settings", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		})();
	}, [open]);

	const handlePick = (def: ProviderDefinition) => {
		setActive(def);
		setApiKey("");
		setConfig((prev) => {
			const base: AiEditionLlmConfig = prev ?? { provider: def.id, model: def.defaultModel };
			return {
				provider: def.id,
				model: base.provider === def.id ? base.model : def.defaultModel,
				baseUrl: base.provider === def.id ? base.baseUrl : def.baseUrl,
				reasoningEffort: base.provider === def.id ? base.reasoningEffort : undefined,
			};
		});
		setMode("form");
	};

	const handleSave = async () => {
		if (!active || !config) return;
		setBusy(true);
		try {
			if (apiKey && active.authKind === "api-key") {
				await nativeBridgeClient.aiEdition.llmSetApiKey(active.id, apiKey);
			}
			await nativeBridgeClient.aiEdition.llmSetConfig(config);
			toast.success(`${active.label} configured`);
			const snap = await nativeBridgeClient.aiEdition.llmGetSnapshot();
			setSnapshot(snap);
			setMode("list");
			setActive(null);
			setApiKey("");
		} catch (err) {
			toast.error("Save failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	const handleDisconnect = async () => {
		if (!active) return;
		setBusy(true);
		try {
			await nativeBridgeClient.aiEdition.llmRemoveApiKey(active.id);
			toast.success(`${active.label} disconnected`);
			const snap = await nativeBridgeClient.aiEdition.llmGetSnapshot();
			setSnapshot(snap);
		} catch (err) {
			toast.error("Disconnect failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	const connected = new Set(snapshot?.connectedProviders ?? []);

	return (
		<ModalShell
			open={open}
			onClose={() => {
				if (busy) return;
				onClose();
				setMode("list");
				setActive(null);
				setApiKey("");
			}}
			title="AI settings"
			subtitle="Choose a provider. Credentials are stored in the OS keychain (safeStorage)."
			wide
		>
			{mode === "list" ? (
				<ProviderList
					connected={connected}
					activeProvider={snapshot?.config?.provider ?? null}
					onPick={handlePick}
				/>
			) : active ? (
				<ProviderForm
					def={active}
					isConnected={connected.has(active.id)}
					apiKey={apiKey}
					setApiKey={setApiKey}
					config={config}
					setConfig={setConfig}
					busy={busy}
					onBack={() => {
						if (busy) return;
						setMode("list");
						setActive(null);
						setApiKey("");
					}}
					onSave={handleSave}
					onDisconnect={handleDisconnect}
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
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(2, 1fr)",
				gap: 8,
			}}
		>
			{PROVIDER_DEFINITIONS.map((def) => {
				const isConnected = connected.has(def.id);
				const isActive = def.id === activeProvider;
				return (
					<button
						key={def.id}
						type="button"
						onClick={() => onPick(def)}
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 6,
							padding: 12,
							border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
							borderRadius: 10,
							background: isActive ? "var(--accent-wash)" : "var(--surface)",
							color: "var(--fg-2)",
							cursor: "pointer",
							textAlign: "left",
							font: "500 13px/1.2 var(--font-body)",
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: 8,
							}}
						>
							<span style={{ color: "var(--fg)", fontWeight: 600 }}>{def.label}</span>
							{isConnected ? (
								<span
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: 4,
										padding: "2px 8px",
										borderRadius: 999,
										background: "var(--success-soft)",
										color: "var(--success)",
										font: "500 10px/1 var(--font-mono)",
										letterSpacing: "0.04em",
									}}
								>
									<Check size={10} />
									CONNECTED
								</span>
							) : (
								<span
									style={{
										padding: "2px 8px",
										borderRadius: 999,
										background: "var(--surface-2)",
										color: "var(--muted)",
										font: "500 10px/1 var(--font-mono)",
										letterSpacing: "0.04em",
									}}
								>
									{authLabel(def.authKind)}
								</span>
							)}
						</div>
						<span
							style={{
								font: "500 11px/1.4 var(--font-mono)",
								color: "var(--muted)",
								letterSpacing: "0.02em",
							}}
						>
							{def.defaultModel || "—"}
						</span>
					</button>
				);
			})}
		</div>
	);
}

function authLabel(kind: ProviderDefinition["authKind"]): string {
	switch (kind) {
		case "api-key":
			return "API KEY";
		case "oauth-device":
			return "OAUTH";
		case "pat":
			return "TOKEN";
	}
}

function ProviderForm({
	def,
	isConnected,
	apiKey,
	setApiKey,
	config,
	setConfig,
	busy,
	onBack,
	onSave,
	onDisconnect,
}: {
	def: ProviderDefinition;
	isConnected: boolean;
	apiKey: string;
	setApiKey: (v: string) => void;
	config: AiEditionLlmConfig | null;
	setConfig: (c: AiEditionLlmConfig | null) => void;
	busy: boolean;
	onBack: () => void;
	onSave: () => void;
	onDisconnect: () => void;
}) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}
			>
				<button
					type="button"
					className={styles.iconBtn}
					title="Back"
					aria-label="Back"
					onClick={onBack}
				>
					<X size={16} />
				</button>
				<span style={{ font: "600 14px var(--font-body)", color: "var(--fg)" }}>{def.label}</span>
				<button
					type="button"
					className={styles.iconBtn}
					title="Close"
					aria-label="Close"
					onClick={onBack}
				>
					<X size={16} />
				</button>
			</div>

			<Field label="Model">
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
				/>
			</Field>

			{def.authKind === "api-key" ? (
				<Field
					label="API key"
					hint={isConnected ? "Leave blank to keep the stored key." : undefined}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 6,
							padding: "6px 8px 6px 10px",
							border: "1px solid var(--border)",
							borderRadius: 6,
							background: "var(--surface)",
						}}
					>
						<KeyRound size={14} style={{ color: "var(--meta)" }} />
						<input
							type="password"
							value={apiKey}
							placeholder={isConnected ? "••••••" : "sk-…"}
							onChange={(e) => setApiKey(e.target.value)}
							style={{
								flex: 1,
								border: 0,
								outline: "none",
								background: "transparent",
								font: "500 12px var(--font-mono)",
								color: "var(--fg-2)",
							}}
						/>
					</div>
				</Field>
			) : (
				<Field label="Authentication" hint={authHint(def)}>
					<div
						style={{
							padding: "8px 10px",
							border: "1px solid var(--border)",
							borderRadius: 6,
							background: "var(--surface-2)",
							color: "var(--muted)",
							font: "500 12px var(--font-body)",
						}}
					>
						{authKindLabel(def.authKind)} — connect flow not implemented yet.
					</div>
				</Field>
			)}

			{(def.id === "openai-compatible" || def.baseUrl) && (
				<Field label="Base URL" hint="Leave blank to use the provider's default.">
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
					/>
				</Field>
			)}

			{def.supportsReasoningEffort ? (
				<Field label="Reasoning effort">
					<select
						value={config?.reasoningEffort ?? "none"}
						onChange={(e) =>
							setConfig({
								...(config ?? { provider: def.id, model: def.defaultModel }),
								reasoningEffort: e.target.value,
							})
						}
					>
						{REASONING_EFFORT_OPTIONS.map((r: string) => (
							<option key={r} value={r}>
								{r}
							</option>
						))}
					</select>
				</Field>
			) : null}

			<Field
				label="Project edits"
				hint="When off, the agent must ask before changing the timeline. Edits are always undoable."
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
						onChange={(e) =>
							setConfig({
								...(config ?? { provider: def.id, model: def.defaultModel }),
								allowAgentEdits: e.target.checked,
							})
						}
					/>
					Allow the agent to edit the project
				</label>
			</Field>

			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					gap: 8,
					paddingTop: 12,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				{isConnected ? (
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={onDisconnect}
						disabled={busy}
					>
						Disconnect
					</button>
				) : (
					<span />
				)}
				<div style={{ display: "flex", gap: 8 }}>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={onBack}
						disabled={busy}
					>
						Cancel
					</button>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={onSave}
						disabled={busy || !config}
					>
						{busy ? (
							<>
								<Loader2 size={14} className="animate-spin" />
								Saving…
							</>
						) : (
							"Save & use"
						)}
					</button>
				</div>
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

function authKindLabel(kind: ProviderDefinition["authKind"]): string {
	switch (kind) {
		case "oauth-device":
			return "OAuth device flow";
		case "pat":
			return "Personal access token";
		case "api-key":
			return "API key";
	}
}

function authHint(def: ProviderDefinition): string {
	if (def.envKeys.length > 0) {
		return `Set ${def.envKeys.join(" or ")} in your environment.`;
	}
	return "Connect flow coming soon.";
}
