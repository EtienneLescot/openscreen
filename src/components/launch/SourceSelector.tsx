import { useCallback, useEffect, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import styles from "./SourceSelector.module.css";

interface DesktopSource {
	id: string;
	name: string;
	thumbnail: string | null;
	display_id: string;
	appIcon: string | null;
}

export function SourceSelector() {
	const t = useScopedT("launch");
	const tc = useScopedT("common");
	const [sources, setSources] = useState<DesktopSource[]>([]);
	const [selectedSource, setSelectedSource] = useState<DesktopSource | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadFailed, setLoadFailed] = useState(false);

	const fetchSources = useCallback(async () => {
		setLoading(true);
		setLoadFailed(false);
		try {
			const rawSources = await window.electronAPI.getSources({
				types: ["screen", "window"],
				thumbnailSize: { width: 320, height: 180 },
				fetchWindowIcons: true,
			});
			setSources(
				rawSources.map((source) => ({
					id: source.id,
					name:
						source.id.startsWith("window:") && source.name.includes(" — ")
							? source.name.split(" — ")[1] || source.name
							: source.name,
					thumbnail: source.thumbnail,
					display_id: source.display_id,
					appIcon: source.appIcon,
				})),
			);
			setSelectedSource((current) =>
				current && rawSources.some((source) => source.id === current.id) ? current : null,
			);
		} catch (error) {
			console.error("Error loading sources:", error);
			setSources([]);
			setSelectedSource(null);
			setLoadFailed(true);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchSources();
	}, [fetchSources]);

	const screenSources = sources.filter((s) => s.id.startsWith("screen:"));
	const windowSources = sources.filter((s) => s.id.startsWith("window:"));
	const hasNoSources = !loading && sources.length === 0;

	const handleSourceSelect = (source: DesktopSource) => setSelectedSource(source);
	const handleShare = async () => {
		if (selectedSource) await window.electronAPI.selectSource(selectedSource);
	};

	if (loading) {
		return (
			<div
				className={`h-full flex items-center justify-center ${styles.glassContainer}`}
				style={{ minHeight: "100vh" }}
			>
				<div className="text-center">
					<div className="animate-spin duration-500 rounded-[50%] h-6 w-6 border-2 border-b-transparent border-[#10b981] mx-auto mb-2" />
					<p className="text-xs text-[#828c99]">{t("sourceSelector.loading")}</p>
				</div>
			</div>
		);
	}

	if (hasNoSources) {
		return (
			<div
				className={`h-full flex items-center justify-center ${styles.glassContainer}`}
				style={{ minHeight: "100vh" }}
			>
				<div className="max-w-[320px] px-6 text-center">
					<h2 className="text-sm font-semibold text-[#ffffff]">{t("sourceSelector.emptyTitle")}</h2>
					<p className="mt-2 text-xs leading-5 text-[#828c99]">
						{loadFailed
							? t("sourceSelector.loadFailedDescription")
							: t("sourceSelector.emptyDescription")}
					</p>
					<Button
						onClick={() => void fetchSources()}
						className="mt-4 h-8 rounded-[9px] bg-[#10b981] px-5 text-[11px] font-semibold text-[#08090d] transition-transform duration-150 hover:bg-[#10b981]/85 active:scale-95"
					>
						{tc("actions.reload")}
					</Button>
				</div>
			</div>
		);
	}

	const renderSourceCard = (source: DesktopSource) => {
		const isSelected = selectedSource?.id === source.id;
		const sourceKind = source.id.startsWith("screen:") ? "screen" : "window";
		return (
			<button
				key={source.id}
				type="button"
				data-testid="source-selector-card"
				data-source-kind={sourceKind}
				className={`${styles.sourceCard} ${isSelected ? styles.selected : ""} flex flex-col text-left`}
				onClick={() => handleSourceSelect(source)}
			>
				<div className={styles.thumb}>
					<img
						src={source.thumbnail || ""}
						alt={source.name}
						className="w-full h-full object-cover"
					/>
				</div>
				<div className="flex items-center gap-[7px] px-[11px] py-[9px]">
					{source.appIcon ? (
						<img src={source.appIcon} alt="" className={styles.icon} />
					) : (
						<span className={styles.iconFallback}>
							<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
								<circle cx="12" cy="12" r="10" />
							</svg>
						</span>
					)}
					<div className={`${styles.name} truncate`}>{source.name}</div>
				</div>
			</button>
		);
	};

	return (
		<div className={`h-screen flex flex-col ${styles.glassContainer}`}>
			<Tabs
				defaultValue={screenSources.length === 0 ? "windows" : "screens"}
				className="flex-1 flex flex-col min-h-0"
			>
				<TabsList className="flex items-center gap-1.5 h-auto p-3.5 rounded-none bg-transparent border-b border-[#191d24] flex-shrink-0">
					<TabsTrigger
						value="screens"
						className="flex-1 h-10 rounded-[11px] text-[13.5px] font-medium text-[#828c99] border border-transparent transition-all data-[state=active]:bg-[#232830] data-[state=active]:border-[#333a45] data-[state=active]:text-[#ffffff] data-[state=active]:font-semibold data-[state=active]:shadow-none"
					>
						{t("sourceSelector.screens", { count: String(screenSources.length) })}
					</TabsTrigger>
					<TabsTrigger
						value="windows"
						className="flex-1 h-10 rounded-[11px] text-[13.5px] font-medium text-[#828c99] border border-transparent transition-all data-[state=active]:bg-[#232830] data-[state=active]:border-[#333a45] data-[state=active]:text-[#ffffff] data-[state=active]:font-semibold data-[state=active]:shadow-none"
					>
						{t("sourceSelector.windows", { count: String(windowSources.length) })}
					</TabsTrigger>
				</TabsList>
				<div className="flex-1 min-h-0 px-[18px] pt-[18px] pb-1.5">
					<TabsContent value="screens" className="h-full mt-0">
						<div
							className={`grid h-full auto-rows-min grid-cols-2 gap-3.5 overflow-y-auto pr-1.5 ${styles.sourceGridScroll}`}
						>
							{screenSources.map(renderSourceCard)}
						</div>
					</TabsContent>
					<TabsContent value="windows" className="h-full mt-0">
						<div
							className={`grid h-full auto-rows-min grid-cols-2 gap-3.5 overflow-y-auto pr-1.5 ${styles.sourceGridScroll}`}
						>
							{windowSources.map(renderSourceCard)}
						</div>
					</TabsContent>
				</div>
			</Tabs>
			<div className="flex justify-end gap-2.5 border-t border-[#191d24] px-[18px] py-4">
				<Button
					data-testid="source-selector-cancel-button"
					variant="ghost"
					onClick={() => window.close()}
					className="h-9 rounded-[9px] border border-[#333a45] px-4 text-[13px] font-medium text-[#f5f7fa] transition-colors duration-150 hover:bg-[#1a1e25] hover:text-[#f5f7fa]"
				>
					{tc("actions.cancel")}
				</Button>
				<Button
					data-testid="source-selector-share-button"
					onClick={handleShare}
					disabled={!selectedSource}
					className="h-9 rounded-[9px] bg-[#10b981] px-5 text-[13px] font-semibold text-[#08090d] transition-transform duration-150 hover:bg-[#10b981]/85 active:scale-95 disabled:bg-[#232830] disabled:border disabled:border-[#242932] disabled:text-[#565f6b] disabled:opacity-100"
				>
					{tc("actions.share")}
				</Button>
			</div>
		</div>
	);
}
