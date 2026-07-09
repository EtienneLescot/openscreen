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
	Video,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";
import { useTheme } from "@/hooks/useTheme";
import type { Locale } from "@/i18n/config";
import styles from "./EditorShellV4.module.css";

export type EditorMode = "media" | "edit" | "rec";

export interface TopBarActions {
	openProject: () => void;
	newProject: () => void;
	save: () => void;
	newRecording: () => void;
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

const LANGS: Array<{ code: string; label: string }> = [
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

const MODES: Array<{ id: EditorMode; label: string }> = [
	{ id: "media", label: "Media" },
	{ id: "edit", label: "Edit" },
	{ id: "rec", label: "Rec" },
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

	return (
		<header className={styles.topbar}>
			<button
				type="button"
				className={`${styles.iconBtn}${chatOpen ? ` ${styles.on}` : ""}`}
				title="Toggle chat panel"
				aria-label="Toggle chat panel"
				aria-pressed={chatOpen}
				onClick={actions.toggleChat}
			>
				<PanelLeft size={17} />
			</button>
			<span className={styles.sep} aria-hidden />
			<span className={styles.brand}>
				<span className={styles.mark} aria-hidden>
					O
				</span>
				<span className={styles.name}>OpenScreen</span>
			</span>
			<span className={styles.sep} aria-hidden />
			<ProjectNameField title={projectTitle} onRename={actions.renameProject} />
			<span className={styles.sep} aria-hidden />
			<button
				type="button"
				className={styles.iconBtn}
				title="Open project"
				aria-label="Open project"
				onClick={actions.openProject}
			>
				<FolderOpen size={16} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title="New project"
				aria-label="New project"
				onClick={actions.newProject}
			>
				<FolderPlus size={16} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title="Save project"
				aria-label="Save project"
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
						Unsaved
					</>
				) : (
					<>
						<span className={styles.dot} aria-hidden />
						Saved
					</>
				)}
			</span>

			<div className={styles.modeSwitch} role="tablist" aria-label="Editor mode">
				{MODES.map((m) => (
					<button
						key={m.id}
						type="button"
						role="tab"
						aria-selected={mode === m.id}
						onClick={() => onModeChange(m.id)}
					>
						{m.label}
					</button>
				))}
			</div>

			<button
				type="button"
				className={styles.iconBtn}
				title="New recording"
				aria-label="New recording"
				onClick={actions.newRecording}
			>
				<Video size={16} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
				aria-label="Toggle theme"
				onClick={toggleTheme}
			>
				{theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title="Settings"
				aria-label="Settings"
				onClick={actions.openSettings}
			>
				<Settings size={16} />
			</button>
			<button
				type="button"
				className={styles.exportBtn}
				title="Export"
				aria-label="Export"
				onClick={actions.export}
				disabled={!canExport}
			>
				<Download size={15} />
				Export
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
		<button
			type="button"
			className={styles.ghostBtn}
			title="Rename project"
			aria-label="Rename project"
			disabled={!title}
			onClick={() => setEditing(true)}
		>
			<span>{title ?? "No project"}</span>
			<ChevronDown size={11} style={{ color: "var(--muted)" }} />
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
		<div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
			<button
				type="button"
				className={styles.iconBtn}
				style={{ width: "auto", padding: "0 8px", gap: 6, display: "inline-flex" }}
				onClick={() => setOpen((v) => !v)}
				aria-label="Change language"
				aria-pressed={open}
			>
				<Languages size={15} />
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600 }}>
					{locale.toUpperCase()}
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
