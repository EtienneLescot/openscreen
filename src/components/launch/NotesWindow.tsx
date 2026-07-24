import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useState } from "react";
import { NotesToolbar } from "./NotesToolbar";
import {
	clampNotesFontSize,
	clampTeleprompterSpeed,
	getNextTeleprompterScrollTop,
	getTeleprompterFrame,
	loadInitialNotesContent,
	loadNotesTeleprompterSettings,
	NOTES_FONT_SIZE_STEP,
	saveNotesContent,
	saveNotesTeleprompterSettings,
	TELEPROMPTER_SPEED_STEP,
} from "./notesTeleprompter";
import "./NotesWindow.module.css";

export function NotesWindow() {
	const [settings, setSettings] = useState(loadNotesTeleprompterSettings);
	const [isPlaying, setIsPlaying] = useState(false);
	const editor = useEditor({
		extensions: [StarterKit],
		content: loadInitialNotesContent(),
		autofocus: "end",
		editorProps: {
			attributes: {
				class: "tiptap",
			},
		},
		onUpdate: ({ editor: nextEditor }) => {
			saveNotesContent(nextEditor.getHTML());
		},
	});

	useEffect(() => {
		saveNotesTeleprompterSettings(settings);
	}, [settings]);

	useEffect(() => {
		if (!isPlaying || !editor) {
			return;
		}

		const scrollElement = editor.view.dom;
		let frameId: number | null = null;
		let previousTimestamp: number | null = null;

		const tick = (timestamp: number) => {
			const frame = getTeleprompterFrame(previousTimestamp, timestamp);
			previousTimestamp = frame.nextTimestamp;

			if (frame.elapsedMs > 0) {
				const maximumScrollTop = Math.max(
					0,
					scrollElement.scrollHeight - scrollElement.clientHeight,
				);
				const nextScrollTop = getNextTeleprompterScrollTop(
					scrollElement.scrollTop,
					settings.speed,
					frame.elapsedMs,
					maximumScrollTop,
				);
				scrollElement.scrollTop = nextScrollTop;

				if (nextScrollTop >= maximumScrollTop) {
					setIsPlaying(false);
					return;
				}
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
