import type { Editor } from "@tiptap/react";
import {
	Bold,
	Code,
	FlipHorizontal2,
	Italic,
	List,
	ListOrdered,
	Minus,
	Pause,
	Play,
	Plus,
	Quote,
	Strikethrough,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useReducer } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import {
	MAX_NOTES_FONT_SIZE,
	MAX_TELEPROMPTER_SPEED,
	MIN_NOTES_FONT_SIZE,
	MIN_TELEPROMPTER_SPEED,
} from "./notesTeleprompter";

export type NotesToolbarProps = {
	editor: Editor | null;
	isPlaying: boolean;
	/** True while the note body rejects edits (playback or mirroring); disables formatting only. */
	formattingDisabled: boolean;
	speed: number;
	fontSize: number;
	mirrored: boolean;
	onTogglePlaying: () => void;
	onDecreaseSpeed: () => void;
	onIncreaseSpeed: () => void;
	onDecreaseFontSize: () => void;
	onIncreaseFontSize: () => void;
	onToggleMirror: () => void;
};

type ToolbarButtonProps = {
	"aria-label": string;
	tooltipContent: string;
	/** Toggle state: drives both `aria-pressed` and the pressed styling. */
	active?: boolean;
	/**
	 * Pressed styling without `aria-pressed`, for buttons that already announce their state
	 * through a label that changes with it. Announcing both would say it twice.
	 */
	highlighted?: boolean;
	disabled?: boolean;
	teleprompterControl?: boolean;
	onClick: () => void;
	children: ReactNode;
};

function ToolbarButton({
	"aria-label": ariaLabel,
	tooltipContent,
	active,
	highlighted = false,
	disabled = false,
	teleprompterControl = false,
	onClick,
	children,
}: ToolbarButtonProps) {
	return (
		<Tooltip content={tooltipContent}>
			<button
				type="button"
				aria-label={ariaLabel}
				aria-pressed={active}
				disabled={disabled}
				data-teleprompter-control={teleprompterControl ? "" : undefined}
				onClick={onClick}
				className={cn(
					"shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-md border-0 bg-transparent text-gray-700 transition-colors hover:bg-gray-200 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet-600 disabled:cursor-not-allowed disabled:opacity-35",
					(active || highlighted) && "bg-gray-900 text-white hover:bg-gray-800 hover:text-white",
				)}
			>
				{children}
			</button>
		</Tooltip>
	);
}

function useEditorRevision(editor: Editor | null): void {
	const [, bumpRevision] = useReducer((revision: number) => revision + 1, 0);

	useEffect(() => {
		if (!editor) {
			return;
		}

		const handleUpdate = () => {
			bumpRevision();
		};

		editor.on("selectionUpdate", handleUpdate);
		editor.on("transaction", handleUpdate);

		return () => {
			editor.off("selectionUpdate", handleUpdate);
			editor.off("transaction", handleUpdate);
		};
	}, [editor]);
}

export function NotesToolbar({
	editor,
	isPlaying,
	formattingDisabled,
	speed,
	fontSize,
	mirrored,
	onTogglePlaying,
	onDecreaseSpeed,
	onIncreaseSpeed,
	onDecreaseFontSize,
	onIncreaseFontSize,
	onToggleMirror,
}: NotesToolbarProps) {
	useEditorRevision(editor);
	const { locale } = useI18n();
	const t = useScopedT("launch");
	const tCommon = useScopedT("common");
	const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);

	return (
		<div className="flex w-full min-w-0 max-w-full flex-col gap-1.5 rounded-[0.625rem] border border-gray-200 bg-gray-50 p-1.5">
			<div
				data-testid="notes-formatting-controls"
				className="flex w-full min-w-0 items-center overflow-x-auto no-scrollbar"
			>
				<div className="flex min-w-max items-center gap-1">
					<div className="flex shrink-0 items-center gap-1">
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.bold")}
							tooltipContent={t("tooltips.notesToolbar.bold")}
							active={editor?.isActive("bold") ?? false}
							disabled={formattingDisabled || !editor?.can().chain().focus().toggleBold().run()}
							onClick={() => editor?.chain().focus().toggleBold().run()}
						>
							<Bold size={16} />
						</ToolbarButton>
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.italic")}
							tooltipContent={t("tooltips.notesToolbar.italic")}
							active={editor?.isActive("italic") ?? false}
							disabled={formattingDisabled || !editor?.can().chain().focus().toggleItalic().run()}
							onClick={() => editor?.chain().focus().toggleItalic().run()}
						>
							<Italic size={16} />
						</ToolbarButton>
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.strikethrough")}
							tooltipContent={t("tooltips.notesToolbar.strikethrough")}
							active={editor?.isActive("strike") ?? false}
							disabled={formattingDisabled || !editor?.can().chain().focus().toggleStrike().run()}
							onClick={() => editor?.chain().focus().toggleStrike().run()}
						>
							<Strikethrough size={16} />
						</ToolbarButton>
					</div>
					<div className="grid h-8 w-5 shrink-0 place-content-center">
						<span className="mx-0.5 h-5 w-px bg-gray-300" aria-hidden="true" />
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.bulletList")}
							tooltipContent={t("tooltips.notesToolbar.bulletList")}
							active={editor?.isActive("bulletList") ?? false}
							disabled={
								formattingDisabled || !editor?.can().chain().focus().toggleBulletList().run()
							}
							onClick={() => editor?.chain().focus().toggleBulletList().run()}
						>
							<List size={16} />
						</ToolbarButton>
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.numberedList")}
							tooltipContent={t("tooltips.notesToolbar.numberedList")}
							active={editor?.isActive("orderedList") ?? false}
							disabled={
								formattingDisabled || !editor?.can().chain().focus().toggleOrderedList().run()
							}
							onClick={() => editor?.chain().focus().toggleOrderedList().run()}
						>
							<ListOrdered size={16} />
						</ToolbarButton>
					</div>
					<div className="grid h-8 w-5 shrink-0 place-content-center">
						<span className="mx-0.5 h-5 w-px bg-gray-300" aria-hidden="true" />
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.blockquote")}
							tooltipContent={t("tooltips.notesToolbar.blockquote")}
							active={editor?.isActive("blockquote") ?? false}
							disabled={
								formattingDisabled || !editor?.can().chain().focus().toggleBlockquote().run()
							}
							onClick={() => editor?.chain().focus().toggleBlockquote().run()}
						>
							<Quote size={16} />
						</ToolbarButton>
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.codeBlock")}
							tooltipContent={t("tooltips.notesToolbar.codeBlock")}
							active={editor?.isActive("codeBlock") ?? false}
							disabled={
								formattingDisabled || !editor?.can().chain().focus().toggleCodeBlock().run()
							}
							onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
						>
							<Code size={16} />
						</ToolbarButton>
					</div>
				</div>
			</div>

			<div
				data-testid="notes-teleprompter-controls"
				className="flex w-full min-w-0 items-center overflow-x-auto no-scrollbar"
			>
				<div className="flex min-w-max items-center gap-1">
					<ToolbarButton
						aria-label={t(isPlaying ? "tooltips.notesToolbar.pause" : "tooltips.notesToolbar.play")}
						tooltipContent={t(
							isPlaying ? "tooltips.notesToolbar.pause" : "tooltips.notesToolbar.play",
						)}
						highlighted={isPlaying}
						disabled={!editor}
						teleprompterControl
						onClick={onTogglePlaying}
					>
						{isPlaying ? <Pause size={16} /> : <Play size={16} />}
					</ToolbarButton>

					<div
						role="group"
						aria-label={t("tooltips.notesToolbar.speed")}
						className="flex shrink-0 items-center gap-1"
					>
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.decreaseSpeed")}
							tooltipContent={t("tooltips.notesToolbar.decreaseSpeed")}
							disabled={speed <= MIN_TELEPROMPTER_SPEED}
							teleprompterControl
							onClick={onDecreaseSpeed}
						>
							<Minus size={16} />
						</ToolbarButton>
						<output className="min-w-14 text-center text-xs tabular-nums text-gray-700">
							{tCommon("units.pixelsPerSecond", { value: numberFormatter.format(speed) })}
						</output>
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.increaseSpeed")}
							tooltipContent={t("tooltips.notesToolbar.increaseSpeed")}
							disabled={speed >= MAX_TELEPROMPTER_SPEED}
							teleprompterControl
							onClick={onIncreaseSpeed}
						>
							<Plus size={16} />
						</ToolbarButton>
					</div>

					<div
						role="group"
						aria-label={t("tooltips.notesToolbar.fontSize")}
						className="flex shrink-0 items-center gap-1"
					>
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.decreaseFontSize")}
							tooltipContent={t("tooltips.notesToolbar.decreaseFontSize")}
							disabled={fontSize <= MIN_NOTES_FONT_SIZE}
							teleprompterControl
							onClick={onDecreaseFontSize}
						>
							<Minus size={16} />
						</ToolbarButton>
						<output className="min-w-10 text-center text-xs tabular-nums text-gray-700">
							{tCommon("units.pixels", { value: numberFormatter.format(fontSize) })}
						</output>
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.increaseFontSize")}
							tooltipContent={t("tooltips.notesToolbar.increaseFontSize")}
							disabled={fontSize >= MAX_NOTES_FONT_SIZE}
							teleprompterControl
							onClick={onIncreaseFontSize}
						>
							<Plus size={16} />
						</ToolbarButton>
					</div>

					<ToolbarButton
						aria-label={t("tooltips.notesToolbar.mirror")}
						tooltipContent={t("tooltips.notesToolbar.mirror")}
						active={mirrored}
						teleprompterControl
						onClick={onToggleMirror}
					>
						<FlipHorizontal2 size={16} />
					</ToolbarButton>
				</div>
			</div>
		</div>
	);
}
