import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { NotesToolbar } from "./NotesToolbar";
import {
	clampNotesFontSize,
	clampTeleprompterSpeed,
	getMaxScrollTop,
	getNextTeleprompterScrollTop,
	getTeleprompterFrame,
	isAtTeleprompterEnd,
	loadInitialNotesContent,
	loadNotesTeleprompterSettings,
	NOTES_FONT_SIZE_STEP,
	resolveTeleprompterPosition,
	saveNotesContent,
	saveNotesTeleprompterSettings,
	TELEPROMPTER_SPEED_STEP,
} from "./notesTeleprompter";
import "./NotesWindow.css";

export function NotesWindow() {
	const [settings, setSettings] = useState(loadNotesTeleprompterSettings);
	const [isPlaying, setIsPlaying] = useState(false);
	const [initialContent] = useState(loadInitialNotesContent);

	// Whether the note body currently rejects edits. Playback locks it because typing makes
	// ProseMirror scroll the caret back into view, which fights the teleprompter. Mirroring
	// locks it because caret placement and selection are horizontally reversed on screen, so
	// the mirrored note is presentation-only. The teleprompter controls themselves stay live
	// in both states; turning the lock's last reason off restores editing.
	const editingLocked = isPlaying || settings.mirrored;

	const editor = useEditor({
		extensions: [StarterKit],
		content: initialContent,
		autofocus: "end",
		// A restored mirror must lock the note from the very first paint — an effect runs
		// only after the first commit, which would leave one editable frame.
		editable: !editingLocked,
		editorProps: {
			attributes: {
				class: "tiptap",
			},
		},
		onUpdate: ({ editor: nextEditor }) => {
			saveNotesContent(nextEditor.getHTML());
		},
	});

	// Writing back the settings that were just loaded would create the storage key before the
	// user has touched a single control. Keying off the identity of the initial state rather
	// than a "has run once" flag keeps that true under StrictMode's double-invoked effects.
	const loadedSettingsRef = useRef(settings);
	useEffect(() => {
		if (settings === loadedSettingsRef.current) {
			return;
		}

		saveNotesTeleprompterSettings(settings);
	}, [settings]);

	// `emitUpdate: false` — the content did not change, so there is nothing to persist.
	useEffect(() => {
		editor?.setEditable(!editingLocked, false);
	}, [editor, editingLocked]);

	useEffect(() => {
		if (!isPlaying || !editor) {
			return;
		}

		const scrollElement = editor.view.dom;

		// Starting from the bottom — the end of a previous run, or a manual scroll —
		// replays from the top instead of leaving the play button looking inert.
		if (isAtTeleprompterEnd(scrollElement.scrollTop, getMaxScrollTop(scrollElement))) {
			scrollElement.scrollTop = 0;
		}

		let frameId: number | null = null;
		let previousTimestamp: number | null = null;
		let position = scrollElement.scrollTop;

		const tick = (timestamp: number) => {
			const frame = getTeleprompterFrame(previousTimestamp, timestamp);
			previousTimestamp = frame.nextTimestamp;

			if (frame.elapsedMs > 0) {
				const maximumScrollTop = getMaxScrollTop(scrollElement);
				position = getNextTeleprompterScrollTop(
					resolveTeleprompterPosition(position, scrollElement.scrollTop),
					settings.speed,
					frame.elapsedMs,
					maximumScrollTop,
				);

				if (isAtTeleprompterEnd(position, maximumScrollTop)) {
					scrollElement.scrollTop = maximumScrollTop;
					setIsPlaying(false);
					return;
				}

				scrollElement.scrollTop = position;
			}

			frameId = requestAnimationFrame(tick);
		};

		frameId = requestAnimationFrame(tick);
		return () => {
			if (frameId !== null) {
				cancelAnimationFrame(frameId);
			}
		};
	}, [editor, isPlaying, settings.speed]);

	const changeSpeed = useCallback((delta: number) => {
		setSettings((current) => ({
			...current,
			speed: clampTeleprompterSpeed(current.speed + delta),
		}));
	}, []);

	const changeFontSize = useCallback((delta: number) => {
		setSettings((current) => ({
			...current,
			fontSize: clampNotesFontSize(current.fontSize + delta),
		}));
	}, []);

	return (
		<div className="flex h-screen w-screen flex-col overflow-hidden bg-white px-6 pb-4 pt-3 gap-4">
			<div className="flex min-w-0 shrink-0 justify-center">
				<NotesToolbar
					editor={editor}
					isPlaying={isPlaying}
					formattingDisabled={editingLocked}
					speed={settings.speed}
					fontSize={settings.fontSize}
					mirrored={settings.mirrored}
					onTogglePlaying={() => setIsPlaying((current) => !current)}
					onDecreaseSpeed={() => changeSpeed(-TELEPROMPTER_SPEED_STEP)}
					onIncreaseSpeed={() => changeSpeed(TELEPROMPTER_SPEED_STEP)}
					onDecreaseFontSize={() => changeFontSize(-NOTES_FONT_SIZE_STEP)}
					onIncreaseFontSize={() => changeFontSize(NOTES_FONT_SIZE_STEP)}
					onToggleMirror={() =>
						setSettings((current) => ({ ...current, mirrored: !current.mirrored }))
					}
				/>
			</div>

			<EditorContent
				editor={editor}
				data-testid="notes-teleprompter-content"
				data-mirrored={settings.mirrored}
				className="notes-teleprompter-content min-h-0 flex-1"
				style={{ fontSize: `${settings.fontSize}px` }}
			/>
		</div>
	);
}
