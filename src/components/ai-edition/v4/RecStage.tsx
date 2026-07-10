import {
	AppWindow,
	Camera,
	CameraOff,
	ChevronDown,
	Loader2,
	MicOff,
	Mic as MicOn,
	Minus,
	MonitorSmartphone,
	MousePointer2,
	Volume2,
	VolumeX,
	X,
} from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useCameraDevices } from "@/hooks/useCameraDevices";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import styles from "./EditorShellV4.module.css";

type Menu = "system" | "mic" | "camera" | null;
type Orientation = "horizontal" | "vertical";

interface RecordingPrefsState {
	micEnabled: boolean;
	micDeviceId: string | null;
	camEnabled: boolean;
	camDeviceId: string | null;
	systemAudioEnabled: boolean;
	cursorCaptureMode: "editable-overlay" | "system";
}

const DEFAULT_PREFS: RecordingPrefsState = {
	micEnabled: false,
	micDeviceId: null,
	camEnabled: false,
	camDeviceId: null,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
};

/**
 * Rec-mode stage. The real capture pipeline lives in the standalone recorder
 * HUD window (`electronAPI.startNewRecording`); this stage presents a real
 * source/mic/camera/cursor configuration bar — ported from the "OpenScreen
 * Recording Widget" design — and hands off to the HUD when the user hits
 * record. Device lists, source selection, and capture-preference state are
 * all read from the same single sources of truth the rest of the app uses
 * (useMicrophoneDevices/useCameraDevices for enumeration, the main-process
 * selected-source + recording-prefs IPC for cross-window selection) — this
 * component holds no invented state of its own for any of that.
 */
export function RecStage({
	onStartRecording,
	onClose,
}: {
	onStartRecording: () => void;
	/** "Close" on the widget has nothing to close (no separate OS window in
	 * this embedded context) — the closest real equivalent is leaving Rec
	 * mode. Optional so the component still works if a caller doesn't wire it. */
	onClose?: () => void;
}) {
	const [menu, setMenu] = useState<Menu>(null);
	const toggleMenu = (m: Menu) => setMenu((cur) => (cur === m ? null : m));

	const [orientation, setOrientation] = useState<Orientation>("horizontal");
	const isVertical = orientation === "vertical";
	const [collapsed, setCollapsed] = useState(false);

	// Drag-to-reposition the toolbar within the frame — position is null
	// (CSS-centered default) until the user first drags, then becomes an
	// explicit, clamped {x,y} offset from the frame's own top-left.
	const frameRef = useRef<HTMLDivElement | null>(null);
	const barRef = useRef<HTMLDivElement | null>(null);
	const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
	const startDrag = useCallback((e: ReactPointerEvent) => {
		e.preventDefault();
		const frame = frameRef.current;
		const bar = barRef.current;
		if (!frame || !bar) return;
		const frameRect = frame.getBoundingClientRect();
		const barRect = bar.getBoundingClientRect();
		const startX = e.clientX;
		const startY = e.clientY;
		const startLeft = barRect.left - frameRect.left;
		const startTop = barRect.top - frameRect.top;
		const move = (ev: PointerEvent) => {
			const x = Math.min(
				frameRect.width - barRect.width,
				Math.max(0, startLeft + (ev.clientX - startX)),
			);
			const y = Math.min(
				frameRect.height - barRect.height,
				Math.max(0, startTop + (ev.clientY - startY)),
			);
			setDragPos({ x, y });
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}, []);

	const [prefs, setPrefsState] = useState<RecordingPrefsState>(DEFAULT_PREFS);
	useEffect(() => {
		let cancelled = false;
		void window.electronAPI?.getRecordingPrefs?.().then((p) => {
			if (!cancelled && p) setPrefsState(p as RecordingPrefsState);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const updatePrefs = useCallback((patch: Partial<RecordingPrefsState>) => {
		setPrefsState((prev) => {
			const next = { ...prev, ...patch };
			void window.electronAPI?.setRecordingPrefs?.(patch);
			return next;
		});
	}, []);

	const micDevices = useMicrophoneDevices(true);
	const camDevices = useCameraDevices(true);

	// Seed the device hooks' local "selected" state from the persisted prefs
	// once devices are enumerated, so the dropdown reflects the last real
	// choice instead of the hook's own "first device" default.
	useEffect(() => {
		if (prefs.micDeviceId && micDevices.devices.some((d) => d.deviceId === prefs.micDeviceId)) {
			micDevices.setSelectedDeviceId(prefs.micDeviceId);
		}
	}, [prefs.micDeviceId, micDevices.devices, micDevices.setSelectedDeviceId]);
	useEffect(() => {
		if (prefs.camDeviceId && camDevices.devices.some((d) => d.deviceId === prefs.camDeviceId)) {
			camDevices.setSelectedDeviceId(prefs.camDeviceId);
		}
	}, [prefs.camDeviceId, camDevices.devices, camDevices.setSelectedDeviceId]);

	// ── capture source (screen/window) ──────────────────────────────
	const [source, setSource] = useState<ProcessedDesktopSource | null>(null);
	useEffect(() => {
		void window.electronAPI?.getSelectedSource?.().then((s) => setSource(s ?? null));
	}, []);
	const [sourceModalOpen, setSourceModalOpen] = useState(false);
	const [sourceTab, setSourceTab] = useState<"screen" | "window">("screen");
	const [sources, setSources] = useState<ProcessedDesktopSource[]>([]);
	const [loadingSources, setLoadingSources] = useState(false);
	const openSourceModal = useCallback(async () => {
		setMenu(null);
		setSourceModalOpen(true);
		setLoadingSources(true);
		try {
			const list = await window.electronAPI?.getSources?.({
				types: ["screen", "window"],
				thumbnailSize: { width: 320, height: 180 },
				fetchWindowIcons: true,
			});
			setSources(list ?? []);
		} finally {
			setLoadingSources(false);
		}
	}, []);
	const chooseSource = useCallback(async (candidate: ProcessedDesktopSource) => {
		const result = await window.electronAPI?.selectSource?.(candidate);
		setSource(result ?? candidate);
		setSourceModalOpen(false);
	}, []);
	const screenSources = sources.filter((s) => s.id.startsWith("screen:"));
	const windowSources = sources.filter((s) => s.id.startsWith("window:"));
	const visibleSources = sourceTab === "screen" ? screenSources : windowSources;

	const cursorHighlight = prefs.cursorCaptureMode === "editable-overlay";

	// Popovers open beside the bar in vertical mode (there's no room below a
	// column layout) and above it in horizontal mode — mirrors the design's
	// V-conditional menu positioning.
	const menuStyle = (horizontalPos: React.CSSProperties, width: number): React.CSSProperties =>
		isVertical
			? { top: 0, bottom: "auto", left: "calc(100% + 8px)", width }
			: { ...horizontalPos, width };

	if (collapsed) {
		return (
			<div className={styles.recStage}>
				<div className={styles.recFrame} ref={frameRef}>
					<span
						aria-hidden
						style={{
							width: 88,
							height: 88,
							borderRadius: "50%",
							background: "linear-gradient(180deg,#c2c6cc 0%,#676d78 100%)",
						}}
					/>
					<div className={styles.recBadge}>
						<span className={styles.recDot} aria-hidden />
						<span>Ready to record</span>
					</div>
					<div className={styles.recBarWrap}>
						<button
							type="button"
							className={styles.recIconBtn}
							title="Expand recording widget"
							aria-label="Expand recording widget"
							onClick={() => setCollapsed(false)}
							style={{
								background: "rgba(20, 22, 27, 0.72)",
								border: "1px solid rgba(255,255,255,0.12)",
							}}
						>
							<span className={styles.recDot} aria-hidden />
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className={styles.recStage}>
			<div className={styles.recFrame} ref={frameRef}>
				<span
					aria-hidden
					style={{
						width: 88,
						height: 88,
						borderRadius: "50%",
						background: "linear-gradient(180deg,#c2c6cc 0%,#676d78 100%)",
					}}
				/>
				<div className={styles.recBadge}>
					<span className={styles.recDot} aria-hidden />
					<span>Ready to record</span>
				</div>

				<div
					className={styles.recBarWrap}
					style={
						dragPos ? { left: dragPos.x, top: dragPos.y, right: "auto", bottom: "auto" } : undefined
					}
				>
					<div
						ref={barRef}
						className={styles.recBar}
						style={isVertical ? { flexDirection: "column" } : undefined}
					>
						{/* drag handle */}
						<span
							title="Drag to move"
							aria-hidden="true"
							onPointerDown={startDrag}
							className={styles.recDragHandle}
							style={
								isVertical
									? { gridTemplateColumns: "repeat(3, 3.5px)" }
									: { gridTemplateColumns: "repeat(2, 3.5px)" }
							}
						>
							{Array.from({ length: 6 }).map((_, i) => (
								<span key={i} className={styles.recDragDot} />
							))}
						</span>

						<span className={styles.recBarSep} aria-hidden />

						{/* orientation toggle */}
						<button
							type="button"
							className={styles.recIconBtn}
							title={isVertical ? "Switch to horizontal layout" : "Switch to vertical layout"}
							aria-label={isVertical ? "Switch to horizontal layout" : "Switch to vertical layout"}
							aria-pressed={isVertical}
							onClick={() => setOrientation(isVertical ? "horizontal" : "vertical")}
						>
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								{isVertical ? (
									<>
										<rect x="3" y="7" width="18" height="10" rx="3" />
										<path d="M12 7v10" />
									</>
								) : (
									<>
										<rect x="7" y="3" width="10" height="18" rx="3" />
										<path d="M7 12h10" />
									</>
								)}
							</svg>
						</button>

						<span className={styles.recBarSep} aria-hidden />

						{/* source */}
						<div style={{ position: "relative" }}>
							<button
								type="button"
								className={styles.recBarBtn}
								title="Recording source"
								aria-label="Recording source"
								onClick={() => void openSourceModal()}
							>
								<MonitorSmartphone size={15} />
								{isVertical ? null : <span>{source?.name ?? "Entire Screen"}</span>}
								{isVertical ? null : <ChevronDown size={10} style={{ opacity: 0.6 }} />}
							</button>
						</div>

						<span className={styles.recBarSep} aria-hidden />

						{/* system audio */}
						<div style={{ position: "relative" }}>
							<button
								type="button"
								className={`${styles.recIconBtn}${prefs.systemAudioEnabled ? ` ${styles.on}` : ""}`}
								title="System audio"
								aria-label="System audio"
								aria-pressed={prefs.systemAudioEnabled}
								onClick={() => toggleMenu("system")}
							>
								{prefs.systemAudioEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
							</button>
							{menu === "system" ? (
								<div className={styles.recMenu} style={menuStyle({ left: 0 }, 200)}>
									<button
										type="button"
										className={`${styles.recMenuRow}${prefs.systemAudioEnabled ? ` ${styles.active}` : ""}`}
										onClick={() => {
											updatePrefs({ systemAudioEnabled: !prefs.systemAudioEnabled });
											setMenu(null);
										}}
									>
										{prefs.systemAudioEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
										{prefs.systemAudioEnabled ? "Mute system audio" : "Capture system audio"}
									</button>
								</div>
							) : null}
						</div>

						{/* mic */}
						<div style={{ position: "relative" }}>
							<button
								type="button"
								className={`${styles.recIconBtn}${prefs.micEnabled ? ` ${styles.on}` : ""}`}
								title="Microphone"
								aria-label="Microphone"
								aria-pressed={prefs.micEnabled}
								onClick={() => toggleMenu("mic")}
							>
								{prefs.micEnabled ? <MicOn size={15} /> : <MicOff size={15} />}
							</button>
							{menu === "mic" ? (
								<div
									className={styles.recMenu}
									style={menuStyle({ left: "50%", transform: "translateX(-50%)" }, 220)}
								>
									<button
										type="button"
										className={`${styles.recMenuRow}${!prefs.micEnabled ? ` ${styles.active}` : ""}`}
										onClick={() => {
											updatePrefs({ micEnabled: false });
											setMenu(null);
										}}
									>
										<MicOff size={14} />
										No microphone
									</button>
									{micDevices.isLoading ? (
										<div
											className={styles.recMenuRow}
											style={{ color: "var(--muted)", cursor: "default" }}
										>
											<Loader2 size={14} className="animate-spin" />
											Loading microphones…
										</div>
									) : (
										micDevices.devices.map((d) => (
											<button
												key={d.deviceId}
												type="button"
												className={`${styles.recMenuRow}${
													prefs.micEnabled && prefs.micDeviceId === d.deviceId
														? ` ${styles.active}`
														: ""
												}`}
												onClick={() => {
													micDevices.setSelectedDeviceId(d.deviceId);
													updatePrefs({ micEnabled: true, micDeviceId: d.deviceId });
													setMenu(null);
												}}
											>
												<MicOn size={14} />
												{d.label}
											</button>
										))
									)}
								</div>
							) : null}
						</div>

						{/* camera */}
						<div style={{ position: "relative" }}>
							<button
								type="button"
								className={`${styles.recIconBtn}${prefs.camEnabled ? ` ${styles.on}` : ""}`}
								title="Camera"
								aria-label="Camera"
								aria-pressed={prefs.camEnabled}
								onClick={() => toggleMenu("camera")}
							>
								{prefs.camEnabled ? <Camera size={15} /> : <CameraOff size={15} />}
							</button>
							{menu === "camera" ? (
								<div
									className={styles.recMenu}
									style={menuStyle({ left: "50%", transform: "translateX(-50%)" }, 220)}
								>
									<button
										type="button"
										className={`${styles.recMenuRow}${!prefs.camEnabled ? ` ${styles.active}` : ""}`}
										onClick={() => {
											updatePrefs({ camEnabled: false });
											setMenu(null);
										}}
									>
										<CameraOff size={14} />
										No camera
									</button>
									{camDevices.isLoading ? (
										<div
											className={styles.recMenuRow}
											style={{ color: "var(--muted)", cursor: "default" }}
										>
											<Loader2 size={14} className="animate-spin" />
											Loading cameras…
										</div>
									) : (
										camDevices.devices.map((d) => (
											<button
												key={d.deviceId}
												type="button"
												className={`${styles.recMenuRow}${
													prefs.camEnabled && prefs.camDeviceId === d.deviceId
														? ` ${styles.active}`
														: ""
												}`}
												onClick={() => {
													camDevices.setSelectedDeviceId(d.deviceId);
													updatePrefs({ camEnabled: true, camDeviceId: d.deviceId });
													setMenu(null);
												}}
											>
												<Camera size={14} />
												{d.label}
											</button>
										))
									)}
								</div>
							) : null}
						</div>

						{/* cursor highlight */}
						<button
							type="button"
							className={`${styles.recIconBtn}${cursorHighlight ? ` ${styles.on}` : ""}`}
							title={cursorHighlight ? "Hide cursor highlight" : "Show cursor highlight"}
							aria-label="Toggle cursor highlight"
							aria-pressed={cursorHighlight}
							onClick={() =>
								updatePrefs({
									cursorCaptureMode: cursorHighlight ? "system" : "editable-overlay",
								})
							}
						>
							<MousePointer2 size={15} />
						</button>

						<span className={styles.recBarSep} aria-hidden />

						{/* switch to the real floating recording widget — moved here from
						    the topbar's old generic "New recording" camera-icon shortcut. */}
						<button
							type="button"
							className={styles.recIconBtn}
							title="Switch to recording widget"
							aria-label="Switch to recording widget"
							onClick={onStartRecording}
						>
							<AppWindow size={15} />
						</button>

						<span className={styles.recBarSep} aria-hidden />

						{/* minimize / close */}
						<button
							type="button"
							className={styles.recIconBtn}
							title="Minimize"
							aria-label="Minimize"
							onClick={() => setCollapsed(true)}
						>
							<Minus size={14} />
						</button>
						{onClose ? (
							<button
								type="button"
								className={styles.recIconBtn}
								title="Close"
								aria-label="Close"
								onClick={onClose}
							>
								<X size={14} />
							</button>
						) : null}
					</div>
				</div>
			</div>

			{menu ? (
				<div style={{ position: "fixed", inset: 0, zIndex: 20 }} onClick={() => setMenu(null)} />
			) : null}

			{sourceModalOpen ? (
				<SourceModal
					loading={loadingSources}
					tab={sourceTab}
					onTabChange={setSourceTab}
					screenCount={screenSources.length}
					windowCount={windowSources.length}
					sources={visibleSources}
					selectedId={source?.id ?? null}
					onSelect={(s) => void chooseSource(s)}
					onClose={() => setSourceModalOpen(false)}
				/>
			) : null}

			<div className={styles.bigRecWrap}>
				<button type="button" className={styles.bigRecBtn} onClick={onStartRecording}>
					<span className={styles.bigRecDot} aria-hidden />
					Start recording
				</button>
			</div>
		</div>
	);
}

function SourceModal({
	loading,
	tab,
	onTabChange,
	screenCount,
	windowCount,
	sources,
	selectedId,
	onSelect,
	onClose,
}: {
	loading: boolean;
	tab: "screen" | "window";
	onTabChange: (tab: "screen" | "window") => void;
	screenCount: number;
	windowCount: number;
	sources: ProcessedDesktopSource[];
	selectedId: string | null;
	onSelect: (source: ProcessedDesktopSource) => void;
	onClose: () => void;
}) {
	return (
		<div className={styles.sourceModalOverlay} onClick={onClose}>
			<div className={styles.sourceModalCard} onClick={(e) => e.stopPropagation()}>
				<div className={styles.sourceModalTabs}>
					<button
						type="button"
						className={`${styles.sourceModalTab}${tab === "screen" ? ` ${styles.active}` : ""}`}
						onClick={() => onTabChange("screen")}
					>
						Screens ({screenCount})
					</button>
					<button
						type="button"
						className={`${styles.sourceModalTab}${tab === "window" ? ` ${styles.active}` : ""}`}
						onClick={() => onTabChange("window")}
					>
						Windows ({windowCount})
					</button>
				</div>
				<div className={styles.sourceGrid}>
					{loading ? (
						<div className={styles.sourceModalEmpty}>
							<Loader2 size={20} className="animate-spin" />
							Loading sources…
						</div>
					) : sources.length === 0 ? (
						<div className={styles.sourceModalEmpty}>No {tab}s found</div>
					) : (
						sources.map((s) => (
							<button
								key={s.id}
								type="button"
								className={`${styles.sourceCard}${s.id === selectedId ? ` ${styles.active}` : ""}`}
								onClick={() => onSelect(s)}
							>
								<div className={styles.sourceCardThumb}>
									{s.thumbnail ? <img src={s.thumbnail} alt="" /> : <MonitorSmartphone size={22} />}
								</div>
								<span className={styles.sourceCardName}>{s.name}</span>
							</button>
						))
					)}
				</div>
				<div className={styles.sourceModalFooter}>
					<button type="button" className={styles.sourceModalCancelBtn} onClick={onClose}>
						Cancel
					</button>
				</div>
			</div>
		</div>
	);
}
