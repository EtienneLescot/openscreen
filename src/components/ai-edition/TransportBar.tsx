import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { memo } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import styles from "./NewEditorShell.module.css";

function formatTC(sec: number): string {
	if (!sec || !Number.isFinite(sec) || sec < 0) sec = 0;
	const m = Math.floor(sec / 60);
	const s = (sec % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

interface TransportBarProps {
	playing: boolean;
	currentTimeSec: number;
	clips: AxcutClip[];
	onTogglePlay: () => void;
	onPrevClip: () => void;
	onNextClip: () => void;
	onSeek: (sec: number) => void;
}

// ponytail: lives in the timeline header now (not under the preview canvas)
// so the header row covers both timeline tools and playback in one line.
export const TransportBar = memo(function TransportBar({
	playing,
	currentTimeSec,
	clips,
	onTogglePlay,
	onPrevClip,
	onNextClip,
	onSeek,
}: TransportBarProps) {
	const te = useScopedT("editor");
	const virtualDurationSec = clips.reduce(
		(acc, c) => acc + (c.timelineEndSec - c.timelineStartSec),
		0,
	);
	// ponytail: mirrors Preview's old clamp so the CSS thumb and the native
	// range thumb stay in sync when there's no clip yet.
	const inputMax = virtualDurationSec || 1;
	const inputValue = Math.min(Math.max(currentTimeSec, 0), inputMax);
	const progress = (inputValue / inputMax) * 100;

	return (
		<div className={styles.transport} role="toolbar" aria-label={te("transport.playbackControls")}>
			<button
				type="button"
				className={`${styles.tbtn} ${styles.play}`}
				title={te("transport.playPauseTitle")}
				aria-label={te("transport.playPause")}
				data-playing={playing}
				onClick={onTogglePlay}
			>
				{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
			</button>
			<button
				type="button"
				className={styles.tbtn}
				title={te("transport.previousClip")}
				aria-label={te("transport.previousClip")}
				onClick={onPrevClip}
			>
				<SkipBack size={13} />
			</button>
			<button
				type="button"
				className={styles.tbtn}
				title={te("transport.nextClip")}
				aria-label={te("transport.nextClip")}
				onClick={onNextClip}
			>
				<SkipForward size={13} />
			</button>
			<span className={styles.time}>
				<span>{formatTC(currentTimeSec)}</span>
				<span className={styles.sep}>/</span>
				<span className={styles.total}>{formatTC(virtualDurationSec)}</span>
			</span>
			<div className={styles.scrubBar}>
				<div className={styles.scrubTrack}>
					<div className={styles.scrubProgress} style={{ width: `${progress}%` }} />
				</div>
				<input
					type="range"
					min={0}
					max={inputMax}
					step={0.01}
					value={inputValue}
					onChange={(e) => onSeek(Number(e.target.value))}
					className={styles.scrubInput}
					aria-label={te("transport.seekVideo")}
				/>
				<div
					className={styles.scrubThumb}
					style={{
						left: `${progress}%`,
					}}
				/>
			</div>
		</div>
	);
});
