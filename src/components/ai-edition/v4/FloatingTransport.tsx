import { Maximize, Pause, Play, Repeat, SkipBack, SkipForward } from "lucide-react";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import styles from "./EditorShellV4.module.css";

function fmt(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) sec = 0;
	const m = Math.floor(sec / 60);
	const s = (sec % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

export function FloatingTransport({
	playing,
	loop,
	currentTimeSec,
	clips,
	onTogglePlay,
	onPrevClip,
	onNextClip,
	onToggleLoop,
	onExpand,
}: {
	playing: boolean;
	loop: boolean;
	currentTimeSec: number;
	clips: AxcutClip[];
	onTogglePlay: () => void;
	onPrevClip: () => void;
	onNextClip: () => void;
	onToggleLoop: () => void;
	onExpand: () => void;
}) {
	const total = clips.reduce((max, c) => Math.max(max, c.timelineEndSec), 0);
	return (
		<div className={styles.transportWrap}>
			<div className={styles.transport} role="toolbar" aria-label="Playback">
				<button
					type="button"
					className={styles.tbtn}
					title="Previous"
					aria-label="Previous"
					onClick={onPrevClip}
				>
					<SkipBack size={15} />
				</button>
				<button
					type="button"
					className={`${styles.tbtn} ${styles.play}`}
					title="Play / Pause"
					aria-label="Play / Pause"
					onClick={onTogglePlay}
				>
					{playing ? <Pause size={16} /> : <Play size={16} />}
				</button>
				<button
					type="button"
					className={styles.tbtn}
					title="Next"
					aria-label="Next"
					onClick={onNextClip}
				>
					<SkipForward size={15} />
				</button>
				<span className={styles.vsep} aria-hidden />
				<span className={styles.time}>
					<b>{fmt(currentTimeSec)}</b>
					<span className={styles.slash}>/</span>
					<span className={styles.total}>{fmt(total)}</span>
				</span>
				<button
					type="button"
					className={`${styles.tbtn}${loop ? ` ${styles.on}` : ""}`}
					title="Loop"
					aria-label="Loop"
					aria-pressed={loop}
					onClick={onToggleLoop}
				>
					<Repeat size={15} />
				</button>
				<button
					type="button"
					className={styles.tbtn}
					title="Fullscreen"
					aria-label="Fullscreen"
					onClick={onExpand}
				>
					<Maximize size={15} />
				</button>
			</div>
		</div>
	);
}
