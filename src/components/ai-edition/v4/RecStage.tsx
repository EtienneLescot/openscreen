import {
	Camera,
	CameraOff,
	ChevronDown,
	MicOff,
	Mic as MicOn,
	MonitorSmartphone,
	MousePointer2,
	Volume2,
	VolumeX,
} from "lucide-react";
import { useState } from "react";
import styles from "./EditorShellV4.module.css";

type Menu = "source" | "mic" | "camera" | null;

const SCREEN_TARGETS = ["Entire Screen", "Display 2"];
const WINDOW_TARGETS = ["OpenScreen Studio", "Figma", "Terminal", "Google Chrome"];
const MIC_DEVICES = ["MacBook Pro Microphone", "AirPods Pro", "Blue Yeti X"];
const CAMERA_DEVICES = ["FaceTime HD Camera", "Logitech Brio 4K"];

/**
 * Rec-mode stage. The real capture pipeline lives in the standalone recorder
 * HUD window (`electronAPI.startNewRecording`); this stage presents the v4
 * source/mic/camera/cursor configuration bar and hands off to the HUD when the
 * user hits record.
 */
export function RecStage({ onStartRecording }: { onStartRecording: () => void }) {
	const [menu, setMenu] = useState<Menu>(null);
	const [sourceTab, setSourceTab] = useState<"screen" | "window">("screen");
	const [screenTarget, setScreenTarget] = useState(SCREEN_TARGETS[0]);
	const [windowTarget, setWindowTarget] = useState(WINDOW_TARGETS[0]);
	const [speakerOn, setSpeakerOn] = useState(false);
	const [micDevice, setMicDevice] = useState<string | null>(null);
	const [cameraDevice, setCameraDevice] = useState<string | null>(null);
	const [cursorOn, setCursorOn] = useState(true);

	const sourceLabel = sourceTab === "screen" ? screenTarget : windowTarget;
	const toggle = (m: Menu) => setMenu((cur) => (cur === m ? null : m));

	return (
		<div className={styles.recStage}>
			<div className={styles.recFrame}>
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
					<div className={styles.recBar}>
						{/* source */}
						<div style={{ position: "relative" }}>
							<button
								type="button"
								className={styles.recBarBtn}
								title="Recording source"
								aria-label="Recording source"
								onClick={() => toggle("source")}
							>
								<MonitorSmartphone size={15} />
								<span>{sourceLabel}</span>
								<ChevronDown size={10} style={{ opacity: 0.6 }} />
							</button>
							{menu === "source" ? (
								<div className={styles.recMenu} style={{ left: 0, width: 220 }}>
									<div
										style={{
											display: "flex",
											gap: 2,
											padding: 2,
											background: "var(--surface-3)",
											borderRadius: 8,
											marginBottom: 6,
										}}
									>
										{(["screen", "window"] as const).map((tab) => (
											<button
												key={tab}
												type="button"
												onClick={() => setSourceTab(tab)}
												style={{
													flex: 1,
													padding: "6px 8px",
													borderRadius: 6,
													border: 0,
													fontSize: 11.5,
													fontWeight: 600,
													cursor: "pointer",
													textTransform: "capitalize",
													background: sourceTab === tab ? "var(--surface-1)" : "transparent",
													color: sourceTab === tab ? "var(--fg-emphasis)" : "var(--muted)",
												}}
											>
												{tab}
											</button>
										))}
									</div>
									{(sourceTab === "screen" ? SCREEN_TARGETS : WINDOW_TARGETS).map((name) => {
										const active =
											sourceTab === "screen" ? name === screenTarget : name === windowTarget;
										return (
											<button
												key={name}
												type="button"
												className={`${styles.recMenuRow}${active ? ` ${styles.active}` : ""}`}
												onClick={() => {
													if (sourceTab === "screen") setScreenTarget(name);
													else setWindowTarget(name);
													setMenu(null);
												}}
											>
												<MonitorSmartphone size={14} />
												{name}
											</button>
										);
									})}
								</div>
							) : null}
						</div>

						<span className={styles.recBarSep} aria-hidden />

						{/* speaker / system audio */}
						<button
							type="button"
							className={`${styles.recIconBtn}${speakerOn ? ` ${styles.on}` : ""}`}
							title="Toggle system audio"
							aria-label="Toggle system audio"
							aria-pressed={speakerOn}
							onClick={() => setSpeakerOn((v) => !v)}
						>
							{speakerOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
						</button>

						{/* mic */}
						<div style={{ position: "relative" }}>
							<button
								type="button"
								className={`${styles.recIconBtn}${micDevice ? ` ${styles.on}` : ""}`}
								title="Microphone"
								aria-label="Microphone"
								onClick={() => toggle("mic")}
							>
								{micDevice ? <MicOn size={15} /> : <MicOff size={15} />}
							</button>
							{menu === "mic" ? (
								<div
									className={styles.recMenu}
									style={{ left: "50%", transform: "translateX(-50%)", width: 210 }}
								>
									<button
										type="button"
										className={`${styles.recMenuRow}${!micDevice ? ` ${styles.active}` : ""}`}
										onClick={() => {
											setMicDevice(null);
											setMenu(null);
										}}
									>
										<MicOff size={14} />
										No microphone
									</button>
									{MIC_DEVICES.map((name) => (
										<button
											key={name}
											type="button"
											className={`${styles.recMenuRow}${micDevice === name ? ` ${styles.active}` : ""}`}
											onClick={() => {
												setMicDevice(name);
												setMenu(null);
											}}
										>
											<MicOn size={14} />
											{name}
										</button>
									))}
								</div>
							) : null}
						</div>

						{/* camera */}
						<div style={{ position: "relative" }}>
							<button
								type="button"
								className={`${styles.recIconBtn}${cameraDevice ? ` ${styles.on}` : ""}`}
								title="Camera"
								aria-label="Camera"
								onClick={() => toggle("camera")}
							>
								{cameraDevice ? <Camera size={15} /> : <CameraOff size={15} />}
							</button>
							{menu === "camera" ? (
								<div
									className={styles.recMenu}
									style={{ left: "50%", transform: "translateX(-50%)", width: 210 }}
								>
									<button
										type="button"
										className={`${styles.recMenuRow}${!cameraDevice ? ` ${styles.active}` : ""}`}
										onClick={() => {
											setCameraDevice(null);
											setMenu(null);
										}}
									>
										<CameraOff size={14} />
										No camera
									</button>
									{CAMERA_DEVICES.map((name) => (
										<button
											key={name}
											type="button"
											className={`${styles.recMenuRow}${
												cameraDevice === name ? ` ${styles.active}` : ""
											}`}
											onClick={() => {
												setCameraDevice(name);
												setMenu(null);
											}}
										>
											<Camera size={14} />
											{name}
										</button>
									))}
								</div>
							) : null}
						</div>

						{/* cursor capture */}
						<button
							type="button"
							className={`${styles.recIconBtn}${cursorOn ? ` ${styles.on}` : ""}`}
							title="Toggle cursor capture"
							aria-label="Toggle cursor capture"
							aria-pressed={cursorOn}
							onClick={() => setCursorOn((v) => !v)}
						>
							<MousePointer2 size={15} />
						</button>
					</div>
				</div>
			</div>

			<div className={styles.bigRecWrap}>
				<button type="button" className={styles.bigRecBtn} onClick={onStartRecording}>
					<span className={styles.bigRecDot} aria-hidden />
					Start recording
				</button>
			</div>
		</div>
	);
}
