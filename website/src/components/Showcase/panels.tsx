/**
 * The four panels, drawn.
 *
 * Every string in here is a string the application shows, and every one of them
 * is either in the fixture the editor above is driven from or in the repository
 * — the format list is the export dialog's, the capture chips are what macOS
 * reports for the take, the agent's timecodes are the ones it answered with.
 * The panels are illustrations and are labelled as such by their `role="img"`,
 * which is also why the placeholder bars and window controls are drawn rather
 * than described: with the subtree collapsed to one label, nothing in here is
 * read out twice.
 *
 * Sizes are the design's. The only thing that moved is where the two wallpapers
 * come from: both are already on the page, loaded by the composite the editor
 * scrubs, so the panels reuse those two URLs and cost no further request.
 */

import {
	Check,
	ChevronDown,
	ChevronRight,
	CircleCheck,
	Languages,
	Mic,
	Trash,
	Volume1,
} from "lucide-react";
import type { ReactNode } from "react";

import styles from "./styles.module.css";

/** macOS window controls, drawn once for every panel that has a title bar. */
function TrafficLights({ small }: { small?: boolean }) {
	const cls = small ? styles.dotSm : styles.dot;
	return (
		<>
			<span className={`${cls} ${styles.dotRed}`} />
			<span className={`${cls} ${styles.dotAmber}`} />
			<span className={`${cls} ${styles.dotGreen}`} />
		</>
	);
}

function Bar({ name }: { name: string }) {
	return (
		<div className={styles.panelBar}>
			<TrafficLights />
			<span className={styles.panelName}>{name}</span>
			<span className={styles.panelPad} />
		</div>
	);
}

function RecordPanel() {
	return (
		<div className={styles.panel}>
			<Bar name="New recording" />
			<div className={styles.recBody}>
				<div className={styles.targets}>
					<div className={`${styles.target} ${styles.targetOn}`}>
						<img
							className={styles.targetShot}
							src="/img/walkthrough/canvas-bg-1.jpg"
							alt=""
							width={1200}
							height={675}
							loading="lazy"
							decoding="async"
						/>
						<div className={`${styles.targetFoot} ${styles.targetFootOn}`}>
							<span className={styles.targetNameOn}>Display 1</span>
							<CircleCheck className={styles.targetTick} size={15} strokeWidth={2.2} />
						</div>
					</div>

					<div className={`${styles.target} ${styles.targetOff}`}>
						<div className={styles.miniWin}>
							<div className={styles.miniBar}>
								<span className={styles.miniDot} />
								<span className={styles.miniDot} />
							</div>
							<div className={styles.miniBody}>
								<span className={`${styles.miniLine} ${styles.phA}`} style={{ width: "64%" }} />
								<span className={`${styles.miniLine} ${styles.phB}`} style={{ width: "82%" }} />
							</div>
						</div>
						<div className={styles.targetFoot}>
							<span className={styles.targetNameOff}>Window — Terminal</span>
						</div>
					</div>
				</div>

				<div className={styles.chips}>
					<span className={styles.chip}>ScreenCaptureKit</span>
					<span className={styles.chip}>system audio</span>
					<span className={styles.chip}>1920 × 1080 · 60 fps</span>
				</div>

				<div className={styles.recFoot}>
					<div className={styles.toggles}>
						<span className={styles.toggle}>
							<Mic size={14} />
						</span>
						<span className={`${styles.toggle} ${styles.toggleOff}`}>
							<Volume1 size={14} />
						</span>
					</div>
					<span className={styles.recStart}>
						<span className={styles.recDot} />
						Start recording
					</span>
				</div>
			</div>
		</div>
	);
}

function ExportPanel() {
	return (
		<div className={styles.panel}>
			<Bar name="Export" />
			<div className={styles.expBody}>
				<div className={styles.expHead}>
					<span className={styles.expFile}>recording-1783066227227.mp4</span>
					<span className={styles.expContainer}>MP4</span>
				</div>

				<div className={styles.pills}>
					<span className={`${styles.pill} ${styles.pillOn}`}>H.265</span>
					<span className={styles.pill}>H.264</span>
					<span className={styles.pill}>1080p</span>
					<span className={styles.pill}>60 fps</span>
					<span className={styles.pill}>GIF</span>
				</div>

				<div>
					<div className={styles.track}>
						<span className={styles.fill} />
					</div>
					<div className={styles.trackFoot}>
						<span className={styles.frames}>frame 1 488 / 2 400</span>
						<span className={styles.pct}>62%</span>
					</div>
				</div>

				<div className={styles.expNote}>
					writing to ~/Movies — no queue, no account, no watermark
				</div>
			</div>
		</div>
	);
}

function CaptionsPanel() {
	return (
		<div className={`${styles.panel} ${styles.capPanel}`}>
			<div className={styles.capStage}>
				<img
					className={styles.capWall}
					src="/img/walkthrough/canvas-bg-2.jpg"
					alt=""
					width={1200}
					height={675}
					loading="lazy"
					decoding="async"
				/>
				<div className={styles.capWin}>
					<div className={styles.capWinBar}>
						<TrafficLights small />
					</div>
					<div className={styles.capWinBody}>
						<span className={`${styles.capWinLine} ${styles.phA}`} style={{ width: "58%" }} />
						<span className={`${styles.capWinLine} ${styles.phB}`} style={{ width: "84%" }} />
						<span className={`${styles.capWinLine} ${styles.phB}`} style={{ width: "72%" }} />
						<span className={`${styles.capWinLine} ${styles.phB}`} style={{ width: "66%" }} />
					</div>
				</div>
				{/* The burned-in line, at the size and the offset the app draws it. */}
				<div className={styles.capLine}>amber day on the validator, and it</div>
			</div>

			<div className={styles.capSide}>
				<div className={styles.capSideHead}>
					<span className={styles.capSideTitle}>Captions</span>
					<ChevronRight className={styles.capChevron} size={14} />
				</div>

				<div className={styles.capRow}>
					<span className={styles.capRowLabel}>Show captions</span>
					<span className={styles.switch}>
						<span className={styles.switchKnob} />
					</span>
				</div>

				<div className={styles.capMeta}>7 caption lines, derived live from the transcript.</div>

				<div className={styles.capGroup}>Language</div>

				<div className={styles.capSelectRow}>
					<span className={styles.capSelectLabel}>Display</span>
					<span className={styles.capSelect}>
						English
						<ChevronDown className={styles.capChevron} size={10} />
					</span>
				</div>

				<div className={styles.capActions}>
					<span className={styles.capPicker}>
						Français
						<ChevronDown className={styles.capChevron} size={10} />
					</span>
					<span className={styles.capButton}>
						<Languages size={12} />
						Translate
					</span>
				</div>

				<div className={`${styles.capButton} ${styles.capButtonWide}`}>
					<Trash size={12} />
					Delete this translation
				</div>

				<div className={styles.capFoot}>
					Translations are stored beside the transcript, never in it — the original text and its
					timings stay untouched.
				</div>
			</div>
		</div>
	);
}

function AgentPanel() {
	return (
		<div className={`${styles.panel} ${styles.agentPanel}`}>
			<div className={styles.agentHead}>
				<img
					className={styles.agentLogo}
					src="/img/logo-icon.png"
					alt=""
					width={96}
					height={96}
					loading="lazy"
					decoding="async"
				/>
				<span className={styles.agentName}>Agent</span>
				<span className={styles.agentKey}>your key</span>
			</div>

			<div className={styles.ask}>Cut the dead air — how much does it save?</div>

			<div className={styles.reply}>
				The only silences over a second are at the two ends:{" "}
				<span className={styles.tc}>0–2.19s</span> of dead lead-in before “Hi” and{" "}
				<span className={styles.tc}>35.12–40.03s</span> of dead tail after “think.” Cutting both
				takes the video about seven seconds shorter —{" "}
				<span className={styles.tcTotal}>40.0s → 33.0s</span> of playable footage. Existing zooms
				stay anchored to the same moments.
			</div>

			<div className={styles.applied}>
				<Check size={13} strokeWidth={2.4} />
				applied: added 2 trims
			</div>
		</div>
	);
}

/** Keyed by the feature id in `content.ts`. */
export const PANELS: Record<string, ReactNode> = {
	record: <RecordPanel />,
	export: <ExportPanel />,
	captions: <CaptionsPanel />,
	agent: <AgentPanel />,
};
