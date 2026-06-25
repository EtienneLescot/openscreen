import { Film, FolderOpen, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { nativeBridgeClient } from "@/native/client";
import type { AiEditionProjectSummary } from "@/native/contracts";

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

function formatRelative(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const delta = Date.now() - then;
	if (delta < 60_000) return "just now";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
	return new Date(iso).toLocaleDateString();
}

const TOOLBAR_BTN =
	"flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-all duration-150 text-[11px] font-medium disabled:opacity-40 disabled:pointer-events-none";

export function ProjectPanel() {
	const projectId = useProjectStore((s) => s.projectId);
	const document = useProjectStore((s) => s.document);
	const createProject = useProjectStore((s) => s.createProject);
	const loadProject = useProjectStore((s) => s.loadProject);
	const addAsset = useProjectStore((s) => s.addAsset);
	const removeAsset = useProjectStore((s) => s.removeAsset);

	const [summaries, setSummaries] = useState<AiEditionProjectSummary[]>([]);
	const [newTitle, setNewTitle] = useState("");
	const [busy, setBusy] = useState(false);

	const refreshList = useCallback(async () => {
		try {
			const next = await nativeBridgeClient.aiEdition.listProjects();
			setSummaries(next);
		} catch {
			// ponytail: silent — the panel still works for the active project
		}
	}, []);

	useEffect(() => {
		void refreshList();
	}, [refreshList]);

	const handleCreate = useCallback(async () => {
		setBusy(true);
		try {
			await createProject(newTitle || "Untitled Project");
			setNewTitle("");
			await refreshList();
		} catch (err) {
			toast.error("Could not create project", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	}, [createProject, newTitle, refreshList]);

	const handleSelect = useCallback(
		async (id: string) => {
			setBusy(true);
			try {
				await loadProject(id);
			} finally {
				setBusy(false);
			}
		},
		[loadProject],
	);

	const handleAddAsset = useCallback(async () => {
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
	}, [addAsset, projectId]);

	const handleRemoveAsset = useCallback(
		async (assetId: string, label: string) => {
			if (!confirm(`Remove asset "${label}"?`)) return;
			try {
				await removeAsset(assetId);
			} catch (err) {
				toast.error("Could not remove asset", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[removeAsset],
	);

	return (
		<aside className="w-full h-full flex flex-col overflow-hidden">
			<header className="px-4 py-3 border-b border-white/[0.06]">
				<h2 className="text-[10px] font-semibold tracking-[0.1em] uppercase text-white/40">
					Projects
				</h2>
			</header>

			<div className="px-3 py-2 border-b border-white/[0.06]">
				<div className="flex items-center gap-1.5">
					<input
						placeholder="New project title"
						value={newTitle}
						onChange={(e) => setNewTitle(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleCreate();
						}}
						className="flex-1 px-2.5 py-1.5 rounded-md bg-white/[0.04] border border-white/[0.06] text-[12px] text-white/85 placeholder:text-white/30 outline-none focus:border-[#34B27B]/50 focus:bg-white/[0.06]"
					/>
					<button
						type="button"
						className="flex items-center justify-center w-7 h-7 rounded-md bg-[#34B27B] hover:bg-[#2d9e6c] active:bg-[#27885c] text-white transition-colors disabled:opacity-40"
						onClick={handleCreate}
						disabled={busy}
						title="Create project"
					>
						<Plus size={14} />
					</button>
				</div>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 custom-scrollbar">
				{summaries.length === 0 && (
					<p className="text-[11px] text-white/35 px-2 py-3 text-center leading-relaxed">
						No projects yet — create one above.
					</p>
				)}
				{summaries.map((summary) => {
					const isActive = summary.id === projectId;
					return (
						<button
							type="button"
							key={summary.id}
							className={`w-full text-left px-2.5 py-2 rounded-lg mb-1 transition-colors ${isActive ? "bg-white/[0.08] ring-1 ring-[#34B27B]/30" : "hover:bg-white/[0.04]"}`}
							onClick={() => void handleSelect(summary.id)}
						>
							<div className="flex items-center gap-2 mb-1">
								<FolderOpen size={12} className={isActive ? "text-[#34B27B]" : "text-white/40"} />
								<span className="text-[12px] font-medium text-white/90 truncate">
									{summary.title}
								</span>
							</div>
							<div className="flex items-center justify-between pl-5 text-[10px] text-white/40">
								<span>
									{summary.assetCount} asset{summary.assetCount === 1 ? "" : "s"}
								</span>
								<span>{formatRelative(summary.updatedAt)}</span>
							</div>
						</button>
					);
				})}
			</div>

			<div className="border-t border-white/[0.06]">
				<header className="px-4 py-3 flex items-center justify-between">
					<h2 className="text-[10px] font-semibold tracking-[0.1em] uppercase text-white/40">
						Assets
					</h2>
					<button
						type="button"
						className={TOOLBAR_BTN}
						onClick={handleAddAsset}
						disabled={!projectId || busy}
						title="Add video asset"
					>
						<Film size={12} />
						Add
					</button>
				</header>
				<div className="px-2 pb-3 max-h-48 overflow-y-auto custom-scrollbar">
					{!document && (
						<p className="text-[11px] text-white/35 px-2 py-2 text-center leading-relaxed">
							Open a project to see its assets.
						</p>
					)}
					{document && document.assets.length === 0 && (
						<p className="text-[11px] text-white/35 px-2 py-2 text-center leading-relaxed">
							No assets yet.
						</p>
					)}
					{document?.assets.map((asset) => (
						<div
							key={asset.id}
							className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.04] group"
						>
							<Film size={12} className="text-white/40 shrink-0" />
							<div className="flex-1 min-w-0">
								<div className="text-[11px] font-medium text-white/85 truncate">{asset.label}</div>
								<div className="text-[10px] text-white/35 truncate">{asset.originalPath}</div>
							</div>
							<button
								type="button"
								className="flex items-center justify-center w-6 h-6 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-white/[0.06] transition-all"
								onClick={() => void handleRemoveAsset(asset.id, asset.label)}
								title={`Remove ${asset.label}`}
							>
								<Trash2 size={12} />
							</button>
						</div>
					))}
				</div>
			</div>
		</aside>
	);
}
