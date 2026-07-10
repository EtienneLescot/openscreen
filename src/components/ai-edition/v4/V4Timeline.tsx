import {
	ChevronDown,
	Clock,
	MessageSquare,
	MousePointer2,
	Scissors,
	Sparkles,
	SplitSquareHorizontal,
	Trash2,
	ZoomIn,
} from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { ASPECT_RATIOS } from "@/utils/aspectRatioUtils";
import { EditClipModal } from "../Modals";
import type { VideoSource } from "../VirtualPreview";
import styles from "./EditorShellV4.module.css";

type TimelineApi = ReturnType<typeof useTimeline>;

const ASSET_MIME = "application/x-axcut-asset";

type ToolId = "select" | "frame" | "cut" | "comment" | "speed" | "enhance";

function fmt(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) sec = 0;
	const m = Math.floor(sec / 60);
	const s = (sec % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

// Deterministic pseudo-random waveform bar heights (0..1), seeded per clip —
// ported verbatim from the v4 design's `waveformFor`.
function waveformFor(seed: number, count: number): number[] {
	let x = seed * 9301 + 49297;
	const rand = () => {
		x = (x * 9301 + 49297) % 233280;
		return x / 233280;
	};
	const bars: number[] = [];
	let v = 0.55;
	for (let i = 0; i < count; i++) {
		v = v * 0.6 + rand() * 0.4;
		bars.push(0.3 + v * 0.7);
	}
	return bars;
}

// Map a skip's source-time range to timeline seconds through the clip that
// carries it (skips are stored in asset source-time, everything else on the
// lane is timeline-time).
function skipToTimeline(
	skip: { assetId: string; startSec: number; endSec: number },
	clips: AxcutClip[],
): { start: number; end: number } | null {
	for (const c of clips) {
		if (c.assetId !== skip.assetId) continue;
		const srcEnd = c.sourceEndSec ?? c.sourceStartSec;
		if (skip.startSec >= c.sourceStartSec && skip.startSec <= srcEnd) {
			const map = (s: number) =>
				c.timelineStartSec + (Math.min(Math.max(s, c.sourceStartSec), srcEnd) - c.sourceStartSec);
			return { start: map(skip.startSec), end: map(skip.endSec) };
		}
	}
	return null;
}

interface LanePill {
	id: string;
	kind: "annotation" | "speed" | "skip" | "zoom";
	start: number;
	end: number;
	label: string;
}

export function V4Timeline({
	tl,
	currentTimeSec,
	setCurrentTime,
	variant = "edit",
	onDropAsset,
	videoSources = [],
}: {
	tl: TimelineApi;
	currentTimeSec: number;
	setCurrentTime: (sec: number) => void;
	variant?: "edit" | "media";
	onDropAsset?: (assetId: string) => void;
	videoSources?: VideoSource[];
}) {
	const tracksRef = useRef<HTMLDivElement | null>(null);
	const navRef = useRef<HTMLDivElement | null>(null);
	const [nav, setNav] = useState({ start: 0, end: 1 });
	const [dragOver, setDragOver] = useState(false);
	const [placingSkip, setPlacingSkip] = useState(false);
	const [snapPct, setSnapPct] = useState<number | null>(null);
	const [editClipTarget, setEditClipTarget] = useState<AxcutClip | null>(null);
	const { settings, set: setSettings } = useEditorSettings();

	// Esc cancels the arm-place-skip tool (parity with the old Bottombar).
	useEffect(() => {
		if (!placingSkip) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setPlacingSkip(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [placingSkip]);
	const [aspectMenuOpen, setAspectMenuOpen] = useState(false);

	const clips = tl.clips;
	const total = useMemo(
		() =>
			Math.max(
				1,
				clips.reduce((m, c) => Math.max(m, c.timelineEndSec), 0),
			),
		[clips],
	);
	const pctOf = useCallback((sec: number) => (sec / total) * 100, [total]);
	const showLanes = variant === "edit";

	// ── region lanes ────────────────────────────────────────────────
	const annPills: LanePill[] = tl.annotationRegions.map((a) => ({
		id: a.id,
		kind: "annotation",
		start: a.startMs / 1000,
		end: a.endMs / 1000,
		label: "New annotation",
	}));
	const speedPills: LanePill[] = tl.speedRegions.map((s) => ({
		id: s.id,
		kind: "speed",
		start: s.startMs / 1000,
		end: s.endMs / 1000,
		label: `${(s as { speed?: number }).speed ?? 1.5}×`,
	}));
	const zoomPills: LanePill[] = tl.zoomRegions.map((z) => ({
		id: z.id,
		kind: "zoom",
		start: z.startMs / 1000,
		end: z.endMs / 1000,
		label: `${(((z as { depth?: number }).depth ?? 3) / 2 + 0.5).toFixed(1)}×`,
	}));
	const skipPills: LanePill[] = tl.skipRanges
		.map((sk): LanePill | null => {
			const mapped = skipToTimeline(sk, clips);
			if (!mapped) return null;
			return {
				id: sk.id,
				kind: "skip",
				start: mapped.start,
				end: mapped.end,
				label: fmt(mapped.end - mapped.start),
			};
		})
		.filter((p): p is LanePill => p !== null);

	const rulerTicks = useMemo(() => {
		const out: string[] = [];
		for (let t = 0; t <= total; t += 15) out.push(fmt(t));
		return out;
	}, [total]);

	// ── interactions ────────────────────────────────────────────────
	const seekToClientX = useCallback(
		(clientX: number) => {
			const el = tracksRef.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
			setCurrentTime(pct * total);
		},
		[setCurrentTime, total],
	);

	// Drag a lane pill to move it (mode "move", keeps duration) or resize one
	// edge (mode "l"/"r"). Zoom/speed/annotation are timeline-ms; skips map
	// back to source-seconds through their carrying clip.
	const startPillDrag = useCallback(
		(e: ReactPointerEvent, pill: LanePill, dragMode: "move" | "l" | "r") => {
			e.preventDefault();
			e.stopPropagation();
			tl.selectRegion(pill.kind, pill.id, { additive: e.shiftKey });
			const el = tracksRef.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			const startX = e.clientX;
			const dur = pill.end - pill.start;
			// Snap targets: clip boundaries + timeline ends. Within ~1% of total,
			// an edge snaps and a vertical guide is shown (Bottombar parity).
			const snapTargets = [
				0,
				total,
				...clips.map((c) => c.timelineStartSec),
				...clips.map((c) => c.timelineEndSec),
			];
			const snapThresh = total * 0.012;
			const snap = (v: number): number => {
				let best = v;
				let bestD = snapThresh;
				for (const t of snapTargets) {
					const d = Math.abs(t - v);
					if (d < bestD) {
						bestD = d;
						best = t;
					}
				}
				setSnapPct(best === v ? null : (best / total) * 100);
				return best;
			};
			const apply = (start: number, end: number) => {
				const s = Math.max(0, Math.min(end - 0.2, start));
				const en = Math.min(total, Math.max(s + 0.2, end));
				if (pill.kind === "zoom") void tl.updateZoomSpan(pill.id, s * 1000, en * 1000);
				else if (pill.kind === "speed") void tl.updateSpeedSpan(pill.id, s * 1000, en * 1000);
				else if (pill.kind === "annotation")
					void tl.updateAnnotationSpan(pill.id, s * 1000, en * 1000);
				else {
					const clip = clips.find((c) => {
						const se = c.sourceEndSec ?? c.sourceStartSec;
						return s >= c.timelineStartSec && s <= c.timelineStartSec + (se - c.sourceStartSec);
					});
					if (clip) {
						const toSrc = (t: number) => clip.sourceStartSec + (t - clip.timelineStartSec);
						void tl.updateSkipRange(pill.id, toSrc(s), toSrc(en));
					}
				}
			};
			const move = (ev: PointerEvent) => {
				const dxSec = ((ev.clientX - startX) / r.width) * total;
				if (dragMode === "move") {
					const ns = Math.max(0, Math.min(total - dur, snap(pill.start + dxSec)));
					apply(ns, ns + dur);
				} else if (dragMode === "l") {
					apply(snap(pill.start + dxSec), pill.end);
				} else {
					apply(pill.start, snap(pill.end + dxSec));
				}
			};
			const up = () => {
				setSnapPct(null);
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[tl, total, clips],
	);

	const startNavDrag = useCallback(
		(mode: "left" | "right" | "pan", e: ReactPointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const r = navRef.current?.getBoundingClientRect();
			if (!r) return;
			const startX = e.clientX;
			const s0 = nav.start;
			const e0 = nav.end;
			const move = (ev: PointerEvent) => {
				const dx = (ev.clientX - startX) / r.width;
				let start = s0;
				let end = e0;
				if (mode === "left") start = Math.min(e0 - 0.05, Math.max(0, s0 + dx));
				else if (mode === "right") end = Math.max(s0 + 0.05, Math.min(1, e0 + dx));
				else {
					const w = e0 - s0;
					start = Math.max(0, Math.min(1 - w, s0 + dx));
					end = start + w;
				}
				setNav({ start, end });
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
		[nav],
	);

	// zoom/pan: the tracks canvas is widened by 1/(navEnd-navStart) and shifted.
	const navSpan = Math.max(0.02, nav.end - nav.start);
	const canvasStyle = {
		width: `${(100 / navSpan).toFixed(3)}%`,
		transform: `translateX(${(-nav.start * (100 / navSpan)).toFixed(3)}%)`,
	} as const;

	const laneOf = (kind: LanePill["kind"]) =>
		kind === "annotation"
			? styles.laneAnnotation
			: kind === "speed"
				? styles.laneSpeed
				: kind === "skip"
					? styles.laneSkip
					: styles.laneZoom;
	const pillIcon = (kind: LanePill["kind"]) =>
		kind === "annotation" ? (
			<MessageSquare size={11} />
		) : kind === "speed" ? (
			<Clock size={11} />
		) : kind === "skip" ? (
			<Scissors size={11} />
		) : (
			<ZoomIn size={11} />
		);

	// Place a 1s skip at the clicked timeline position, mapped to its clip's
	// source-time (Bottombar's arm-place-skip tool).
	const placeSkipAtClientX = useCallback(
		(clientX: number) => {
			const el = tracksRef.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * total;
			const clip = clips.find((c) => t >= c.timelineStartSec && t <= c.timelineEndSec);
			if (!clip) return;
			const src = clip.sourceStartSec + (t - clip.timelineStartSec);
			const srcEnd = clip.sourceEndSec ?? clip.sourceStartSec;
			void tl.addSkipAt(clip.assetId, src, Math.min(srcEnd, src + 1));
			setPlacingSkip(false);
		},
		[tl, total, clips],
	);

	const tools: Array<{ id: ToolId; label: string; icon: React.ReactNode; on?: boolean }> = [
		{ id: "select", label: "Select", icon: <MousePointer2 size={15} />, on: !placingSkip },
		{
			id: "cut",
			label: "Place skip (click the timeline)",
			icon: <SplitSquareHorizontal size={15} />,
			on: placingSkip,
		},
		{ id: "comment", label: "Comment", icon: <MessageSquare size={15} /> },
		{ id: "speed", label: "Speed", icon: <Clock size={15} /> },
		{ id: "enhance", label: "Auto-enhance", icon: <Sparkles size={15} /> },
	];

	const isPillSelected = (id: string) =>
		tl.selection?.id === id || tl.multiSelection.some((m) => m.id === id);
	const renderPills = (pills: LanePill[], emptyLabel: string) => (
		<>
			{pills.length === 0 ? <span className={styles.laneEmpty}>{emptyLabel}</span> : null}
			{pills.map((p) => (
				<div
					// biome-ignore lint/a11y/useKeyWithClickEvents: pointer-driven region drag/resize
					// biome-ignore lint/a11y/noStaticElementInteractions: lane pill is a draggable region control
					key={p.id}
					role="button"
					tabIndex={0}
					className={`${styles.lanePill} ${laneOf(p.kind)}${
						isPillSelected(p.id) ? ` ${styles.lanePillSel}` : ""
					}`}
					style={{ left: `${pctOf(p.start)}%`, width: `${Math.max(1.5, pctOf(p.end - p.start))}%` }}
					onPointerDown={(e) => startPillDrag(e, p, "move")}
					title={p.label}
				>
					<span
						className={styles.lanePillHandle}
						style={{ left: 0 }}
						onPointerDown={(e) => startPillDrag(e, p, "l")}
					/>
					{pillIcon(p.kind)}
					<span className={styles.lanePillLabel}>{p.label}</span>
					<span
						className={styles.lanePillHandle}
						style={{ right: 0 }}
						onPointerDown={(e) => startPillDrag(e, p, "r")}
					/>
				</div>
			))}
		</>
	);

	return (
		<div className={styles.tl}>
			<div className={styles.tlToolbar}>
				{showLanes ? (
					<div className={styles.tlTools} role="toolbar" aria-label="Timeline tools">
						{tools.map((t) => (
							<button
								type="button"
								key={t.id}
								className={`${styles.tlToolBtn}${t.on ? ` ${styles.on}` : ""}`}
								title={t.label}
								aria-label={t.label}
								onClick={() => {
									if (t.id === "speed") void tl.addSpeed();
									if (t.id === "comment") void tl.addAnnotation();
									if (t.id === "cut") setPlacingSkip((v) => !v);
								}}
							>
								{t.icon}
							</button>
						))}
						<button
							type="button"
							className={styles.tlToolBtn}
							title="Add zoom"
							aria-label="Add zoom"
							onClick={() => void tl.addZoom()}
						>
							<ZoomIn size={15} />
						</button>
						<span className={styles.tlToolSep} aria-hidden />
						<Popover open={aspectMenuOpen} onOpenChange={setAspectMenuOpen}>
							<PopoverTrigger asChild>
								<button
									type="button"
									className={styles.tlAspect}
									title="Aspect ratio"
									aria-label="Aspect ratio"
								>
									{settings.aspectRatio}
									<ChevronDown size={10} />
								</button>
							</PopoverTrigger>
							<PopoverContent
								align="end"
								sideOffset={6}
								animated={false}
								className="w-auto border-0 bg-transparent p-0 shadow-none"
							>
								<div
									className={styles.recMenu}
									style={{ position: "relative", bottom: "auto", width: 150 }}
								>
									{ASPECT_RATIOS.map((ratio) => (
										<button
											type="button"
											key={ratio}
											className={`${styles.recMenuRow}${
												ratio === settings.aspectRatio ? ` ${styles.active}` : ""
											}`}
											onClick={() => {
												void setSettings({ aspectRatio: ratio });
												setAspectMenuOpen(false);
											}}
										>
											{ratio}
										</button>
									))}
								</div>
							</PopoverContent>
						</Popover>
					</div>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
						<span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--fg-2)" }}>
							Arrange clips
						</span>
						<span style={{ fontSize: 11.5, color: "var(--meta)" }}>
							Drag clips below to reorder or drop new ones in
						</span>
					</div>
				)}
				<div className={styles.tlHints}>
					<span className={styles.tlHint}>
						<span className={styles.tlKbd}>Scroll</span> Pan
					</span>
					<span className={styles.tlHint}>
						<span className={styles.tlKbd}>Ctrl+Scroll</span> Zoom
					</span>
				</div>
			</div>

			<div
				ref={tracksRef}
				className={styles.tlTracks}
				style={placingSkip ? { cursor: "crosshair" } : undefined}
				// biome-ignore lint/a11y/useKeyWithClickEvents: ruler scrubbing is pointer-only
				onClick={(e) => {
					if (placingSkip) placeSkipAtClientX(e.clientX);
					else seekToClientX(e.clientX);
				}}
			>
				<div className={styles.tlCanvas} style={canvasStyle}>
					<div
						aria-hidden
						className={styles.tlPlayhead}
						style={{ left: `${pctOf(currentTimeSec)}%` }}
					>
						<span className={styles.tlPlayheadDiamond} />
					</div>
					{snapPct !== null ? (
						<div aria-hidden className={styles.tlSnapGuide} style={{ left: `${snapPct}%` }} />
					) : null}

					<div className={styles.tlRuler}>
						{rulerTicks.map((t, i) => (
							<span key={`${t}-${i}`}>{t}</span>
						))}
					</div>

					{showLanes ? (
						<>
							<div className={styles.tlLane}>{renderPills(annPills, "No annotations yet")}</div>
							<div className={styles.tlLane}>{renderPills(speedPills, "Constant speed")}</div>
							<div className={styles.tlLane}>{renderPills(skipPills, "No skips")}</div>
							<div className={styles.tlLane}>{renderPills(zoomPills, "")}</div>
						</>
					) : null}

					<div
						className={`${styles.tlClips}${dragOver ? ` ${styles.tlClipsDrag}` : ""}`}
						onDragOver={(e) => {
							e.preventDefault();
							e.dataTransfer.dropEffect = "copy";
							if (!dragOver) setDragOver(true);
						}}
						onDragLeave={() => setDragOver(false)}
						onDrop={(e) => {
							e.preventDefault();
							setDragOver(false);
							const id = e.dataTransfer.getData(ASSET_MIME);
							if (id && onDropAsset) onDropAsset(id);
						}}
					>
						{clips.map((c, i) => {
							const dur = c.timelineEndSec - c.timelineStartSec;
							const bars = waveformFor(i + 1, Math.max(12, Math.round(dur * 0.6)));
							const selected = tl.clipSelection === c.id;
							return (
								// biome-ignore lint/a11y/useKeyWithClickEvents: clip selection is pointer-driven
								<div
									key={c.id}
									className={`${styles.tlClip}${selected ? ` ${styles.tlClipSel}` : ""}`}
									style={{ flex: `${dur} 0 0` }}
									onClick={(e) => {
										e.stopPropagation();
										tl.selectClip(c.id);
									}}
									onDoubleClick={(e) => {
										e.stopPropagation();
										setEditClipTarget(c);
									}}
									title="Double-click to edit in/out points"
								>
									<div aria-hidden className={styles.tlWave}>
										{bars.map((h, bi) => (
											<span
												key={bi}
												style={{
													height: `${Math.round(h * 100)}%`,
													opacity: (0.5 + h * 0.5).toFixed(2),
												}}
											/>
										))}
									</div>
									<div className={styles.tlClipLabel}>
										<span className={styles.tlClipIcon}>
											<Scissors size={9} />
										</span>
										<span className={styles.tlClipName}>
											{tl.assets.find((a) => a.id === c.assetId)?.label ?? c.assetId}
										</span>
									</div>
									{selected ? (
										<button
											type="button"
											className={styles.tlClipDelete}
											title="Delete clip"
											aria-label="Delete clip"
											onClick={(e) => {
												e.stopPropagation();
												void tl.removeClip(c.id);
											}}
										>
											<Trash2 size={13} />
										</button>
									) : null}
								</div>
							);
						})}
						{dragOver ? (
							<div aria-hidden className={styles.tlDropHint}>
								Drop to add to timeline
							</div>
						) : null}
					</div>
				</div>
			</div>

			<div ref={navRef} className={styles.tlNav}>
				<div className={styles.tlNavTrack} />
				<div
					className={styles.tlNavWindow}
					style={{
						left: `${(nav.start * 100).toFixed(2)}%`,
						width: `${((nav.end - nav.start) * 100).toFixed(2)}%`,
					}}
					onPointerDown={(e) => startNavDrag("pan", e)}
				/>
				<div
					className={styles.tlNavHandle}
					style={{ left: `calc(${(nav.start * 100).toFixed(2)}% - 6px)` }}
					onPointerDown={(e) => startNavDrag("left", e)}
				>
					<span />
				</div>
				<div
					className={styles.tlNavHandle}
					style={{ left: `calc(${(nav.end * 100).toFixed(2)}% - 6px)` }}
					onPointerDown={(e) => startNavDrag("right", e)}
				>
					<span />
				</div>
			</div>

			<EditClipModal
				open={editClipTarget !== null}
				onClose={() => setEditClipTarget(null)}
				clip={editClipTarget}
				assetMeta={
					editClipTarget
						? {
								label:
									tl.assets.find((a) => a.id === editClipTarget.assetId)?.label ??
									editClipTarget.assetId,
								durationSec: tl.assets.find((a) => a.id === editClipTarget.assetId)?.durationSec,
							}
						: null
				}
				videoSources={videoSources}
				onApply={(sStart, sEnd) => {
					if (editClipTarget) void tl.updateClipSourceRange(editClipTarget.id, sStart, sEnd);
					setEditClipTarget(null);
				}}
			/>
		</div>
	);
}
