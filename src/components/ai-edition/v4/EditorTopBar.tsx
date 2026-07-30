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

	// ponytail: the left side panel only renders in "edit" mode (see
	// NewEditorShell body), so its toggle is meaningless in Media/Rec —
	// hide the button (and its separator) there to keep the topbar honest.
	const showChatToggle = mode === "edit";
	return (
		<header className={styles.topbar}>
			{/* Fixed-width slot: the toggle is Edit-only, and .topbarLead holds its
			    space in the other modes so nothing to the right moves. */}
			<span className={styles.topbarLead}>
				{showChatToggle ? (
					<>
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
					</>
				) : null}
			</span>
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
			{/* Both states are always rendered, stacked in one grid cell, so the slot
			    keeps the width of the longer label and the bar doesn't twitch every
			    time the document goes dirty. The inactive one is visibility:hidden,
			    which also takes it out of the accessibility tree. */}
			<span className={styles.saved}>
				<span className={styles.savedState} data-on={!dirty}>
					<span className={styles.dot} aria-hidden />
					{t("topbar.saved")}
				</span>
				<span className={styles.savedState} data-on={dirty}>
					<span
						className={styles.dot}
						aria-hidden
						style={{ background: "var(--warn)", boxShadow: "0 0 0 3px var(--warn-soft)" }}
					/>
					{t("topbar.unsaved")}
				</span>
			</span>

			<div className={styles.modeSwitch} role="tablist" aria-label={t("topbar.editorMode")}>
				{MODES.map((m) => (
					<button
						key={m.id}
						type="button"
						role="tab"
						aria-selected={mode === m.id}
						// Feeds the hidden bold copy that reserves the selected width — see
						// .modeSwitch button::before.
						data-label={t(m.labelKey)}
						onClick={() => onModeChange(m.id)}
					>
						<span className={styles.modeLabel}>{t(m.labelKey)}</span>
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

	const startEditing = () => {
		setDraft(title ?? "");
		setEditing(true);
	};

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next) onRename(next);
	};

	if (editing) {
		return (
			<input
				className={styles.projectNameInput}
				autoFocus
				value={draft}
				onFocus={(e) => e.currentTarget.select()}
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
			/>
		);
	}

	return (
		<button
			type="button"
			className={`${styles.ghostBtn} ${styles.projectNameBtn}`}
			aria-label={t("topbar.renameProject")}
			// The label is truncated to keep the slot fixed, so the full name has to
			// stay reachable on hover.
			title={title ?? undefined}
			disabled={!title}
			onClick={startEditing}
		>
			<span className={styles.projectNameLabel}>{title ?? t("topbar.noProject")}</span>
		</button>
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
				{/* Fixed-width, centred: the short labels run from "EN" to "PT-BR" to
				    the CJK "简中", and letting the button size to them moved everything
				    to its right on each language change. */}
				<span className={styles.langShort}>{getLocaleShort(locale)}</span>
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
