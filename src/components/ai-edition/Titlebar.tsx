import {
	ChevronDown,
	Download,
	FileVideo,
	FolderOpen,
	FolderPlus,
	Languages,
	Moon,
	PanelLeft,
	PanelRight,
	Rows3,
	Save,
	Settings,
	Sun,
	Video,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";
import { useTheme } from "@/hooks/useTheme";
import type { Locale } from "@/i18n/config";
import styles from "./NewEditorShell.module.css";

interface ProjectSummary {
	id: string;
	title: string;
	updatedAt: string;
}

export interface TitlebarActions {
	openProject: () => void;
	newProject: () => void;
	save: () => void;
	saveAs: () => void;
	newRecording: () => void;
	recorder: () => void;
	export: () => void;
	toggleLeft: () => void;
	toggleRight: () => void;
	toggleBottom: () => void;
	openSettings: () => void;
	renameProject: (title: string) => void;
}

interface TitlebarProps {
	project: ProjectSummary | null;
	dirty: boolean;
	lastSavedAt: Date | null;
	canExport: boolean;
	leftCollapsed: boolean;
	rightCollapsed: boolean;
	bottomCollapsed: boolean;
	actions: TitlebarActions;
}

function timeAgo(d: Date | null): string {
	if (!d) return "Not saved yet";
	const delta = Date.now() - d.getTime();
	if (delta < 5_000) return "just now";
	if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
	return d.toLocaleDateString();
}

export function Titlebar({
	project,
	dirty,
	lastSavedAt,
	canExport,
	leftCollapsed,
	rightCollapsed,
	bottomCollapsed,
	actions,
}: TitlebarProps) {
	const { theme, toggle: toggleTheme } = useTheme();
	const [, setTick] = useState(0);

	useEffect(() => {
		if (dirty || !lastSavedAt) return;
		const timer = setInterval(() => {
			setTick((t) => t + 1);
		}, 10_000);
		return () => clearInterval(timer);
	}, [dirty, lastSavedAt]);

	const openShortcuts = () => window.dispatchEvent(new CustomEvent("openscreen:open-shortcuts"));
	return (
		<header className={styles.titlebar}>
			<span className={styles.lights} aria-hidden>
				<span className={styles.r} />
				<span className={styles.y} />
				<span className={styles.g} />
			</span>
			<span className={styles.brand}>
				<span className={styles.brandMark} aria-hidden>
					O
				</span>
				OpenScreen
			</span>
			<span className={styles.sep} aria-hidden />
			<ProjectNameField project={project} onRename={actions.renameProject} />
			<span className={styles.saved}>
				{dirty ? (
					<>
						<span className={styles.dot} aria-hidden style={{ background: "var(--warn)" }} />
						Unsaved changes
					</>
				) : (
					<>
						<span className={styles.dot} aria-hidden />
						Saved · {timeAgo(lastSavedAt)}
					</>
				)}
			</span>
			<span className={styles.projActions}>
				<IconButton title="Open project" ariaLabel="Open project" onClick={actions.openProject}>
					<FolderOpen size={16} />
				</IconButton>
				<IconButton title="New project" ariaLabel="New project" onClick={actions.newProject}>
					<FolderPlus size={16} />
				</IconButton>
				<SaveDropdown
					disabled={!project}
					dirty={dirty}
					onSave={actions.save}
					onSaveAs={actions.saveAs}
				/>
			</span>
			<LangButton />
			<button
				type="button"
				className={styles.recorderBtn}
				title="New recording"
				aria-label="New recording"
				onClick={actions.newRecording}
			>
				<Video size={16} />
				<span>New recording</span>
			</button>
			<button
				type="button"
				className={styles.recorderBtn}
				style={{ background: "transparent", borderColor: "var(--border)", color: "var(--fg-2)" }}
				title="Return to recorder"
				aria-label="Return to recorder"
				onClick={actions.recorder}
			>
				Return to recorder
			</button>
			<span className={styles.right}>
				<IconButton
					title="Export"
					ariaLabel="Export"
					onClick={actions.export}
					disabled={!canExport}
				>
					<Download size={16} />
				</IconButton>
				<IconButton
					title="Toggle left panel"
					ariaLabel="Toggle left panel"
					ariaPressed={!leftCollapsed}
					onClick={actions.toggleLeft}
				>
					<PanelLeft size={16} />
				</IconButton>
				<IconButton
					title="Toggle timeline"
					ariaLabel="Toggle timeline"
					ariaPressed={!bottomCollapsed}
					onClick={actions.toggleBottom}
				>
					<Rows3 size={16} />
				</IconButton>
				<IconButton
					title="Toggle right panel"
					ariaLabel="Toggle right panel"
					ariaPressed={!rightCollapsed}
					onClick={actions.toggleRight}
				>
					<PanelRight size={16} />
				</IconButton>
				<IconButton
					title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
					ariaLabel={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
					ariaPressed={theme === "dark"}
					onClick={toggleTheme}
				>
					{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
				</IconButton>
				<IconButton title="Shortcuts (?)" ariaLabel="Shortcuts" onClick={openShortcuts}>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="12" cy="12" r="10" />
						<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
						<line x1="12" y1="17" x2="12.01" y2="17" />
					</svg>
				</IconButton>
				<IconButton title="Settings" ariaLabel="Settings" onClick={actions.openSettings}>
					<Settings size={16} />
				</IconButton>
			</span>
		</header>
	);
}

function SaveDropdown({
	disabled,
	dirty,
	onSave,
	onSaveAs,
}: {
	disabled: boolean;
	dirty: boolean;
	onSave: () => void;
	onSaveAs: () => void;
}) {
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
		<div ref={ref} style={{ position: "relative" }}>
			<button
				type="button"
				className={styles.iconBtn}
				title="Save project"
				aria-label="Save project"
				aria-pressed={open}
				disabled={disabled}
				onClick={() => setOpen((v) => !v)}
			>
				<Save size={16} />
				{dirty ? (
					<span
						aria-hidden
						style={{
							position: "absolute",
							top: 4,
							right: 4,
							width: 6,
							height: 6,
							borderRadius: "50%",
							background: "var(--warn)",
						}}
					/>
				) : null}
			</button>
			{open ? (
				<div
					role="menu"
					style={{
						position: "absolute",
						top: "calc(100% + 4px)",
						left: 0,
						minWidth: 180,
						background: "var(--surface)",
						border: "1px solid var(--border)",
						borderRadius: "var(--r-md)",
						boxShadow: "var(--elev-pop)",
						padding: 4,
						zIndex: 60,
					}}
				>
					<MenuItem
						icon={<Save size={14} />}
						label="Save"
						hint="⌘S"
						onClick={() => {
							setOpen(false);
							onSave();
						}}
					/>
					<MenuItem
						icon={<FileVideo size={14} />}
						label="Save as…"
						hint="⌘⇧S"
						onClick={() => {
							setOpen(false);
							onSaveAs();
						}}
					/>
				</div>
			) : null}
		</div>
	);
}

function MenuItem({
	icon,
	label,
	hint,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	hint?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				width: "100%",
				padding: "6px 10px",
				border: 0,
				background: "transparent",
				color: "var(--fg-2)",
				borderRadius: "var(--r-sm)",
				cursor: "pointer",
				font: "500 12px var(--font-body)",
			}}
			onClick={onClick}
		>
			{icon}
			<span style={{ flex: 1, textAlign: "left" }}>{label}</span>
			{hint ? (
				<span
					style={{
						font: "500 10px/1 var(--font-mono)",
						color: "var(--meta)",
						letterSpacing: "0.04em",
					}}
				>
					{hint}
				</span>
			) : null}
		</button>
	);
}

function IconButton({
	children,
	title,
	ariaLabel,
	ariaPressed,
	onClick,
	disabled,
}: {
	children: ReactNode;
	title: string;
	ariaLabel?: string;
	ariaPressed?: boolean;
	onClick?: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			className={styles.iconBtn}
			title={title}
			aria-label={ariaLabel ?? title}
			aria-pressed={ariaPressed}
			onClick={onClick}
			disabled={disabled}
		>
			{children}
		</button>
	);
}

function LangButton() {
	const { locale, setLocale } = useI18n();
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
		<div ref={ref} style={{ position: "relative" }}>
			<button
				type="button"
				className={styles.langSel}
				onClick={() => setOpen((v) => !v)}
				aria-label="Change language"
				aria-pressed={open}
			>
				<Languages size={16} style={{ color: "var(--fg)" }} />
				<span style={{ fontSize: 13, fontWeight: 500 }}>{locale.toUpperCase()}</span>
				<ChevronDown size={10} style={{ color: "var(--muted)" }} />
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
					{LANGS.map((l) => (
						<button
							key={l.code}
							type="button"
							style={{
								display: "block",
								width: "100%",
								textAlign: "left",
								padding: "6px 10px",
								border: 0,
								background: l.code === locale ? "var(--accent-wash)" : "transparent",
								color: l.code === locale ? "var(--accent)" : "var(--fg-2)",
								borderRadius: "var(--r-sm)",
								cursor: "pointer",
								font: "500 12px var(--font-body)",
							}}
							onClick={() => {
								setLocale(l.code as Locale);
								setOpen(false);
							}}
						>
							{l.label}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

function ProjectNameField({
	project,
	onRename,
}: {
	project: ProjectSummary | null;
	onRename: (title: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(project?.title ?? "");
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (editing) {
			setDraft(project?.title ?? "");
			inputRef.current?.select();
		}
	}, [editing, project?.title]);

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next && next !== project?.title) onRename(next);
	};

	return (
		<span className={styles.project}>
			{editing ? (
				<input
					ref={inputRef}
					className={styles.projectInput}
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
				/>
			) : (
				<button
					type="button"
					className={styles.projectName}
					title="Rename project"
					aria-label="Rename project"
					disabled={!project}
					onClick={() => setEditing(true)}
				>
					{project?.title ?? "No project"}
				</button>
			)}
		</span>
	);
}

const LANGS = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
	{ code: "es", label: "Español" },
	{ code: "de", label: "Deutsch" },
	{ code: "it", label: "Italiano" },
	{ code: "ja-JP", label: "日本語" },
	{ code: "ko-KR", label: "한국어" },
	{ code: "pt-BR", label: "Português (BR)" },
	{ code: "ru", label: "Русский" },
	{ code: "tr", label: "Türkçe" },
	{ code: "vi", label: "Tiếng Việt" },
	{ code: "zh-CN", label: "简体中文" },
	{ code: "zh-TW", label: "繁體中文" },
];
