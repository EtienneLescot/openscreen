import {
	ChevronDown,
	Download,
	FolderOpen,
	FolderPlus,
	Languages,
	Moon,
	PanelLeft,
	Save,
	Settings,
	Sun,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import logoMark from "@/assets/openscreen-mark.png";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { useTheme } from "@/hooks/useTheme";
import { getAvailableLocales, getLocaleName, getLocaleShort } from "@/i18n/loader";
import styles from "./EditorShellV4.module.css";

export type EditorMode = "media" | "edit" | "rec";

export interface TopBarActions {
	openProject: () => void;
	newProject: () => void;
	save: () => void;
	export: () => void;
	openSettings: () => void;
	renameProject: (title: string) => void;
	toggleChat: () => void;
}

interface EditorTopBarProps {
	mode: EditorMode;
	onModeChange: (mode: EditorMode) => void;
	projectTitle: string | null;
	dirty: boolean;
	canExport: boolean;
	chatOpen: boolean;
	actions: TopBarActions;
}

const MODES: Array<{ id: EditorMode; labelKey: string }> = [
	{ id: "media", labelKey: "topbar.modes.media" },
	{ id: "edit", labelKey: "topbar.modes.edit" },
	{ id: "rec", labelKey: "topbar.modes.rec" },
];

export function EditorTopBar({
	mode,
	onModeChange,
	projectTitle,
	dirty,
	canExport,
	chatOpen,
	actions,
}: EditorTopBarProps) {
	const { theme, toggle: toggleTheme } = useTheme();
	const t = useScopedT("editor");

	return (
		<header className={styles.topbar}>
			<button
				type="button"
				className={`${styles.iconBtn}${chatOpen ? ` ${styles.on}` : ""}`}
				title={t("topbar.toggleChatPanel")}
				aria-label={t("topbar.toggleChatPanel")}
				aria-pressed={chatOpen}
				onClick={actions.toggleChat}
			>
				<PanelLeft size={17} />
			</button>
			<span className={styles.sep} aria-hidden />
			<span className={styles.brand}>
				{/* Decorative: the wordmark right beside it already names the app. */}
				<img src={logoMark} alt="" draggable={false} />
				<span className={styles.name}>OpenScreen</span>
			</span>
			<span className={styles.sep} aria-hidden />
			<ProjectNameField title={projectTitle} onRename={actions.renameProject} />
			<span className={styles.sep} aria-hidden />
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.openProject")}
				aria-label={t("topbar.openProject")}
				onClick={actions.openProject}
			>
				<FolderOpen size={16} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.newProject")}
				aria-label={t("topbar.newProject")}
				onClick={actions.newProject}
			>
				<FolderPlus size={16} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.saveProject")}
				aria-label={t("topbar.saveProject")}
				onClick={actions.save}
				style={{ position: "relative" }}
			>
				<Save size={16} />
				{dirty ? (
					<span
						aria-hidden
						style={{
							position: "absolute",
							top: 5,
							right: 5,
							width: 6,
							height: 6,
							borderRadius: "50%",
							background: "var(--warn)",
						}}
					/>
				) : null}
			</button>
			<span className={styles.sep} aria-hidden />
			<LangButton />
			<span className={styles.saved}>
				{dirty ? (
					<>
						<span
							className={styles.dot}
							aria-hidden
							style={{ background: "var(--warn)", boxShadow: "0 0 0 3px var(--warn-soft)" }}
						/>
						{t("topbar.unsaved")}
					</>
				) : (
					<>
						<span className={styles.dot} aria-hidden />
						{t("topbar.saved")}
					</>
				)}
			</span>

			<div className={styles.modeSwitch} role="tablist" aria-label={t("topbar.editorMode")}>
				{MODES.map((m) => (
					<button
						key={m.id}
						type="button"
						role="tab"
						aria-selected={mode === m.id}
						onClick={() => onModeChange(m.id)}
					>
						{t(m.labelKey)}
					</button>
				))}
			</div>

			<button
				type="button"
				className={styles.iconBtn}
				title={theme === "dark" ? t("topbar.switchToLightTheme") : t("topbar.switchToDarkTheme")}
				aria-label={t("topbar.toggleTheme")}
				onClick={toggleTheme}
			>
				{theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.settings")}
				aria-label={t("topbar.settings")}
				onClick={actions.openSettings}
			>
				<Settings size={16} />
			</button>
			<button
				type="button"
				className={styles.exportBtn}
				title={t("topbar.export")}
				aria-label={t("topbar.export")}
				onClick={actions.export}
				disabled={!canExport}
			>
				<Download size={15} />
				{t("topbar.export")}
			</button>
		</header>
	);
}

function ProjectNameField({
	title,
	onRename,
}: {
	title: string | null;
	onRename: (title: string) => void;
}) {
	const t = useScopedT("editor");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title ?? "");
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (editing) {
			setDraft(title ?? "");
			inputRef.current?.select();
		}
	}, [editing, title]);

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next && next !== title) onRename(next);
	};

	if (editing) {
		return (
			<input
				ref={inputRef}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					} else if (e.key === "Escape") {
						setEditing(false);
					}
				}}
				style={{
					height: 30,
					minWidth: 160,
					padding: "0 10px",
					borderRadius: 9,
					border: "1px solid var(--accent)",
					background: "var(--surface)",
					color: "var(--fg)",
					font: "500 13px var(--font-display)",
					outline: "none",
				}}
			/>
		);
	}

	return (
		<span className={styles.ghostBtn}>
			<button
				type="button"
				title={t("topbar.renameProject")}
				aria-label={t("topbar.renameProject")}
				disabled={!title}
				onClick={() => setEditing(true)}
				style={{
					all: "unset",
					cursor: title ? "pointer" : "default",
					color: "inherit",
					font: "inherit",
				}}
			>
				{title ?? t("topbar.noProject")}
			</button>
		</span>
	);
}

function LangButton() {
	const { locale, setLocale } = useI18n();
	const t = useScopedT("editor");
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) return;
		const onDocClick = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [open]);
	return (
		<div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
			<button
				type="button"
				className={styles.iconBtn}
				style={{ width: "auto", padding: "0 8px", gap: 6, display: "inline-flex" }}
				onClick={() => setOpen((v) => !v)}
				aria-label={t("topbar.changeLanguage")}
				aria-pressed={open}
			>
				<Languages size={15} />
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600 }}>
					{getLocaleShort(locale)}
				</span>
				<ChevronDown size={9} style={{ color: "var(--muted)" }} />
			</button>
			{open ? (
				<div
					style={{
						position: "absolute",
						top: "calc(100% + 4px)",
						right: 0,
						minWidth: 160,
						background: "var(--surface)",
						border: "1px solid var(--border)",
						borderRadius: "var(--r-md)",
						boxShadow: "var(--elev-pop)",
						padding: 4,
						zIndex: 60,
					}}
				>
					{getAvailableLocales().map((code) => (
						<button
							key={code}
							type="button"
							style={{
								display: "block",
								width: "100%",
								textAlign: "left",
								padding: "6px 10px",
								border: 0,
								background: code === locale ? "var(--accent-wash)" : "transparent",
								color: code === locale ? "var(--accent)" : "var(--fg-2)",
								borderRadius: "var(--r-sm)",
								cursor: "pointer",
								font: "500 12px var(--font-body)",
							}}
							onClick={() => {
								setLocale(code);
								setOpen(false);
							}}
						>
							{getLocaleName(code)}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
