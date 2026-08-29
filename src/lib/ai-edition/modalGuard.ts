// One central answer to "is a modal on screen?", for the window-level keydown handlers that
// own the editor's shortcuts (`NewEditorShell`) and its undo/redo (`store/undo`).
//
// It asks the DOM instead of enumerating open-state flags. The flag version covered exactly
// the two dialogs whose open state had been lifted into a context for unrelated reasons (#420)
// — the AI providers dialog and the shortcuts dialog — and silently missed every modal that
// kept its `useState` where it was: Export, Open project, New project, Edit clip, the
// unsaved-changes prompt (issue #434). Each new modal was a new special case nobody would
// remember to add.
//
// Every modal in this tree already announces itself the same way: `ModalShell` and the
// hand-rolled portal in `ChatStripPanel` render `aria-modal="true"`, and `ui/dialog` passes the same
// attribute to Radix's content. So one selector answers for all of them, including the ones
// that do not exist yet.

/**
 * True while a modal owns the screen.
 *
 * For window-level event handlers, never for rendering: it reads the live DOM, so a component
 * that called it during render would not re-render when the answer changed.
 */
export function isModalOpen(): boolean {
	return document.querySelector('[aria-modal="true"]') !== null;
}
