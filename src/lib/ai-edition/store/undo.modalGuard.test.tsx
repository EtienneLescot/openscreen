// @vitest-environment jsdom
// Undo/redo are bound on `window` here, not in `NewEditorShell` — the shell explicitly defers
// Ctrl+Z / Ctrl+Y to this listener. So the shell's modal guard never runs for them, and until
// this listener asked the same question, Ctrl+Z rewrote the document under every open modal,
// including the ones the shell already suppressed everything else for (issue #434, compounding
// with #433).

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, axcutSchemaVersion } from "../schema";
import { useProjectStore } from "./projectStore";
import { clearHistory, useUndoRedoShortcuts } from "./undo";
import { pushHistory } from "./undoStack";

function doc(title: string): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "proj_test",
			title,
			createdAt: "2026-06-25T10:00:00.000Z",
			updatedAt: "2026-06-25T10:00:00.000Z",
		},
		assets: [],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	};
}

const onAfter = vi.fn();

/** `aria-modal="true"` on a `role="dialog"` is what every modal in the editor renders — see
 *  `ModalShell` and `ui/dialog`, both pinned in `modalGuard.test.tsx`. */
function Harness({ modal }: { modal: boolean }) {
	useUndoRedoShortcuts(onAfter);
	return modal ? <div role="dialog" aria-modal="true" /> : null;
}

beforeEach(() => {
	onAfter.mockClear();
	clearHistory();
	useProjectStore.getState().clear();
	// One edit in the past, so a working Ctrl+Z has something to roll back to.
	useProjectStore.setState({ projectId: "proj_test", document: doc("after") });
	pushHistory({ projectId: "proj_test", doc: doc("before") });
});

afterEach(() => {
	cleanup();
	clearHistory();
	useProjectStore.getState().clear();
});

describe("useUndoRedoShortcuts under a modal", () => {
	it("undoes on Ctrl+Z with nothing on screen", () => {
		render(<Harness modal={false} />);

		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });

		expect(onAfter).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.project.title).toBe("before");
	});

	it("leaves the document alone while a modal owns the screen", () => {
		const { rerender } = render(<Harness modal />);

		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });

		expect(onAfter).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("after");

		// Nothing was consumed either: the edit is still undoable once the modal is gone.
		rerender(<Harness modal={false} />);
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		expect(useProjectStore.getState().document?.project.title).toBe("before");
	});
});
