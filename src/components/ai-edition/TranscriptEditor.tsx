import { useCallback, useMemo, useState } from "react";
import type { AxcutClip, AxcutTranscript } from "@/lib/ai-edition/schema";
import { formatSeconds, keptWordIdSet } from "@/lib/ai-edition/timeline/virtual-preview";
import styles from "./TranscriptEditor.module.css";

// ponytail: simplified port of axcut's TranscriptEditor. Click a word to
// select, shift-click another word to select a range, press "Cut" to drop
// that range from the timeline. Kept words = default, skipped = red.

interface TranscriptEditorProps {
	transcript: AxcutTranscript;
	clips: AxcutClip[];
	currentTimeSec: number;
	onSeek: (timeSec: number) => void;
	onDropWordRange: (startSec: number, endSec: number) => void;
}

export function TranscriptEditor({
	transcript,
	clips,
	currentTimeSec,
	onSeek,
	onDropWordRange,
}: TranscriptEditorProps) {
	const [anchorWordId, setAnchorWordId] = useState<string | null>(null);
	const [focusWordId, setFocusWordId] = useState<string | null>(null);
	const keptIds = useMemo(() => keptWordIdSet(clips), [clips]);

	const handleWordClick = useCallback(
		(event: React.MouseEvent, wordId: string, startSec: number) => {
			if (event.shiftKey && anchorWordId) {
				setFocusWordId(wordId);
			} else {
				setAnchorWordId(wordId);
				setFocusWordId(wordId);
				onSeek(startSec);
			}
		},
		[anchorWordId, onSeek],
	);

	const selectedRange = useMemo(() => {
		if (!anchorWordId || !focusWordId) return null;
		const startIndex = transcript.words.findIndex((w) => w.id === anchorWordId);
		const endIndex = transcript.words.findIndex((w) => w.id === focusWordId);
		if (startIndex < 0 || endIndex < 0) return null;
		const [from, to] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
		const selected = transcript.words.slice(from, to + 1);
		if (selected.length === 0) return null;
		return {
			startSec: Math.min(...selected.map((w) => w.startSec)),
			endSec: Math.max(...selected.map((w) => w.endSec)),
			text: selected.map((w) => w.text).join(" "),
		};
	}, [anchorWordId, focusWordId, transcript.words]);

	const handleCut = useCallback(() => {
		if (selectedRange) {
			onDropWordRange(selectedRange.startSec, selectedRange.endSec);
			setAnchorWordId(null);
			setFocusWordId(null);
		}
	}, [onDropWordRange, selectedRange]);

	return (
		<div className={styles.container}>
			<div className={styles.header}>
				<h3 className={styles.heading}>Transcript</h3>
				{selectedRange && (
					<button type="button" className={styles.cutButton} onClick={handleCut}>
						Cut {formatSeconds(selectedRange.startSec)}–{formatSeconds(selectedRange.endSec)}
					</button>
				)}
			</div>
			<div className={styles.textArea}>
				{transcript.words.map((word) => {
					const isKept = keptIds.has(word.id);
					const isSelected =
						anchorWordId && focusWordId
							? isInRange(word.id, anchorWordId, focusWordId, transcript.words)
							: false;
					const isCurrent = currentTimeSec >= word.startSec && currentTimeSec <= word.endSec;
					return (
						<span
							key={word.id}
							className={[
								styles.word,
								!isKept ? styles.skipped : "",
								isSelected ? styles.selected : "",
								isCurrent ? styles.current : "",
							]
								.filter(Boolean)
								.join(" ")}
							onClick={(e) => handleWordClick(e, word.id, word.startSec)}
						>
							{word.text}
						</span>
					);
				})}
			</div>
		</div>
	);
}

function isInRange(
	wordId: string,
	anchorId: string,
	focusId: string,
	words: { id: string }[],
): boolean {
	const start = words.findIndex((w) => w.id === anchorId);
	const end = words.findIndex((w) => w.id === focusId);
	if (start < 0 || end < 0) return false;
	const [from, to] = start <= end ? [start, end] : [end, start];
	const index = words.findIndex((w) => w.id === wordId);
	return index >= from && index <= to;
}
