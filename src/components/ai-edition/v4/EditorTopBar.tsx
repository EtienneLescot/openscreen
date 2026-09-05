import {
	ChevronDown,
	Download,
	FolderOpen,
	FolderPlus,
	Info,
	Keyboard,
	Languages,
	Moon,
	PanelLeft,
	RefreshCw,
	Save,
	Sparkles,
	Sun,
} from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
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
	openProviderSettings: () => void;
	showAbout: () => void;
	checkForUpdates: () => void;
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
			<AppMenu actions={actions} />
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
			<span className={styles.saved} title={dirty ? t("topbar.unsaved") : t("topbar.saved")}>
				<span className={styles.savedState} data-on={!dirty}>
					<span className={styles.dot} aria-hidden />
					<span className={styles.savedLabel}>{t("topbar.saved")}</span>
				</span>
				<span className={styles.savedState} data-on={dirty}>
					<span
						className={styles.dot}
						aria-hidden
						style={{ background: "var(--warn)", boxShadow: "0 0 0 3px var(--warn-soft)" }}
					/>
					<span className={styles.savedLabel}>{t("topbar.unsaved")}</span>
				</span>
			</span>

			<div className={styles.modeSwitch} role="tablist" aria-label={t("topbar.editorMode")}>
				{MODES.map((m) => (
					<button
						key={m.id}
						type="button"
						role="tab"
						aria-selected={mode === m.id}
						title={t(m.labelKey)}
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
				className={styles.exportBtn}
				title={t("topbar.export")}
				aria-label={t("topbar.export")}
				onClick={actions.export}
				disabled={!canExport}
			>
				<Download size={15} />
				<span className={styles.exportLabel}>{t("topbar.export")}</span>
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

/** The brand doubles as the application menu.
 *
 *  Windows and Linux have no visible menu bar to put About and the update check in: this bar
 *  IS the titlebar (createEditorWindow passes titleBarStyle:"hidden"), and the native menu is
 *  behind setAutoHideMenuBar(true) — so those two items were reachable only from the tray, or
 *  by holding Alt, which is to say not reachable. Hanging them off the wordmark is what Figma,
 *  Linear and Slack do under the same constraint.
 *
 *  It costs the bar no width, which is the reason it is the wordmark and not a new button:
 *  .modeSwitch is the only flex-shrink:1 element in the topbar, so any control added here is
 *  paid for out of the mode labels, in the most verbose of 13 locales, at the 800px minimum
 *  window width.
 *
 *  No row invents a label. Each one reuses the key of the thing it opens: `common.actions.*`
 *  for the rows electron/main.ts also builds native menu items from (About, Check for
 *  Updates), and the dialog's own title key for the rows that open a dialog (`shortcuts.title`,
 *  `editor.providerSettings.title`). That is what stops this menu from drifting away from the
 *  native menu on one side and from what its rows actually open on the other — and it is why
 *  this component adds no translation work. */
/** Shared by the mount seed and the per-open refresh below. A rejection — no preload, browser
 *  mode — resolves to "no", which hides the item rather than shipping a button whose click the
 *  main process would refuse without saying so. */
async function readUpdateVeto(cancelled: () => boolean, apply: (allowed: boolean) => void) {
	try {
		const allowed = await window.electronAPI?.canCheckForUpdatesNow?.();
		if (!cancelled()) apply(allowed === true);
	} catch {
		if (!cancelled()) apply(false);
	}
}

function AppMenu({ actions }: { actions: TopBarActions }) {
	const tCommon = useScopedT("common");
	const tEditor = useScopedT("editor");
	const tShortcuts = useScopedT("shortcuts");
	const [open, setOpen] = useState(false);
	const [version, setVersion] = useState<string | null>(null);
	const [canUpdate, setCanUpdate] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	// At mount: the version, which never changes while the process lives, and a first read of
	// the update veto so the item does not pop in a frame late on the first open and shove the
	// row under the pointer.
	useEffect(() => {
		let cancelled = false;
		window.electronAPI
			?.getAppInfo?.()
			.then((info) => {
				if (!cancelled) setVersion(info.version);
			})
			.catch(() => {
				// Leaves the version off the About row. The row itself still works, and the tray
				// and native menu still reach the same box, so there is nothing to report.
			});
		void readUpdateVeto(() => cancelled, setCanUpdate);
		return () => {
			cancelled = true;
		};
	}, []);

	// And again on every open, unlike the version: this answer includes the transient veto —
	// no update check mid-take — so the seed above goes stale the moment a recording starts.
	// A cached "yes" would offer a check that the main process then silently refuses.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void readUpdateVeto(() => cancelled, setCanUpdate);
		return () => {
			cancelled = true;
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onDocMouseDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDocMouseDown);
		return () => document.removeEventListener("mousedown", onDocMouseDown);
	}, [open]);

	// Focus the first item as the menu appears, so it is operable from the keyboard without a
	// Tab through the whole bar first.
	useEffect(() => {
		if (!open) return;
		menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
	}, [open]);

	const close = (restoreFocus: boolean) => {
		setOpen(false);
		// Escape and Tab-out hand focus back to the trigger; a click does not, because the
		// pointer user did not come from there and a focus ring appearing under the cursor
		// reads as a bug.
		if (restoreFocus) triggerRef.current?.focus();
	};

	const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			close(true);
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const items = Array.from(
			menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
		);
		if (items.length === 0) return;
		const at = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = e.key === "ArrowDown" ? at + 1 : at - 1;
		// Wraps both ways; `at` is -1 when focus escaped the list, and ArrowDown then lands on 0.
		items[(next + items.length) % items.length]?.focus();
	};

	const run = (action: () => void) => () => {
		close(false);
		action();
	};

	return (
		<div ref={ref} className={styles.appMenuAnchor}>
			<button
				ref={triggerRef}
				type="button"
				className={`${styles.brand} ${styles.brandBtn}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label="OpenScreen"
				title="OpenScreen"
				onClick={() => setOpen((v) => !v)}
			>
				{/* Decorative: the wordmark beside it already names the app — and, being the
				    button's only text, is also its accessible name. */}
				<img src={logoMark} alt="" draggable={false} />
				<span className={styles.name}>OpenScreen</span>
				<ChevronDown size={13} className={styles.brandChevron} aria-hidden />
			</button>
			{open ? (
				<div ref={menuRef} className={styles.appMenu} role="menu" onKeyDown={onMenuKeyDown}>
					<button
						type="button"
						role="menuitem"
						className={styles.appMenuRow}
						onClick={run(actions.openSettings)}
					>
						<Keyboard size={15} />
						{tShortcuts("title")}
					</button>
					{/* Settings surfaces together, above the separator. Both rows are labelled with the
					    title of the dialog they open, so neither can drift from it — and unlike the AI
					    panel's own entry points, this one is reachable in Media and Rec too, which is
					    the whole reason the dialog's open state was lifted out of LeftPanel (#420). */}
					<button
						type="button"
						role="menuitem"
						className={styles.appMenuRow}
						onClick={run(actions.openProviderSettings)}
					>
						<Sparkles size={15} />
						{tEditor("providerSettings.title")}
					</button>
					<div className={styles.appMenuSep} aria-hidden />
					{/* Only the PERMANENT half of the veto is applied here. A Store/Flathub/Snap/Nix
					    copy never offers the check at all; the transient half — not during a take —
					    stays with the main process, which re-checks it on the IPC, because this
					    window is not the one that knows a recording is running. */}
					{canUpdate ? (
						<button
							type="button"
							role="menuitem"
							className={styles.appMenuRow}
							onClick={run(actions.checkForUpdates)}
						>
							<RefreshCw size={15} />
							{tCommon("actions.checkForUpdates")}
						</button>
					) : null}
					<button
						type="button"
						role="menuitem"
						className={styles.appMenuRow}
						onClick={run(actions.showAbout)}
					>
						<Info size={15} />
						{tCommon("actions.about")}
						{version ? <span className={styles.appMenuVersion}>{version}</span> : null}
					</button>
				</div>
			) : null}
		</div>
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
		<div ref={ref} className={styles.langAnchor}>
			<button
				type="button"
				className={`${styles.iconBtn} ${styles.langBtn}`}
				onClick={() => setOpen((v) => !v)}
				aria-label={t("topbar.changeLanguage")}
				aria-pressed={open}
			>
				<Languages size={15} className={styles.langIcon} />
				{/* Fixed-width, centred: the short labels run from "EN" to "PT-BR" to
				    the CJK "简中", and letting the button size to them moved everything
				    to its right on each language change. */}
				<span className={styles.langShort}>{getLocaleShort(locale)}</span>
				<ChevronDown size={9} className={styles.langChevron} />
			</button>
			{open ? (
				<div className={styles.langMenu}>
					{getAvailableLocales().map((code) => (
						<button
							key={code}
							type="button"
							className={styles.langMenuItem}
							data-active={code === locale}
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
