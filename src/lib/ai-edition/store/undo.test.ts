// @vitest-environment jsdom
//
// Regression cover for #433: undo/redo silently did nothing. `undo.ts` had no
// test at all, which is exactly why CI stayed green while Ctrl+Z was dead —
// the history stack was only ever written by `setDocument`, and every edit the
// editor actually makes (add a region, delete one, rename the project) goes
// through `saveDocument`.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../schema";
import { useProjectStore } from "./projectStore";
import { clearHistory, redo, undo, useUndoRedoShortcuts } from "./undo";
import { future, past } from "./undoStack";

const saveMock = vi.hoisted(() => vi.fn());

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: { save: saveMock },
	},
}));

const PROJECT_ID = "project_1";

function titled(title: string) {
	return createEmptyDocument({ projectId: PROJECT_ID, title });
}

function currentTitle(): string | undefined {
	return useProjectStore.getState().document?.project.title;
}

describe("undo/redo", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		saveMock.mockReset();
		// The bridge hands the document back; `saveDocument` re-parses what it returns,
		// so the store ends up holding a structurally equal but distinct object — same
		// as in the app.
		saveMock.mockImplementation(async (document: unknown) => ({ success: true, document }));
		useProjectStore.setState({ projectId: PROJECT_ID, document: titled("Original") });
	});

	it("records a saveDocument edit and reverts it", async () => {
		// The path every region add / delete / rename takes. It recorded nothing
		// before this fix, so `past` stayed empty and `undo()` returned false.
		await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true });
		expect(currentTitle()).toBe("Renamed");
		expect(past).toHaveLength(1);

		expect(undo()).toBe(true);
		expect(currentTitle()).toBe("Original");
	});

	it("reapplies the edit on redo", async () => {
		const renamed = titled("Renamed");
		await useProjectStore.getState().saveDocument(renamed, { history: true });

		expect(undo()).toBe(true);
		expect(currentTitle()).toBe("Original");
		expect(redo()).toBe(true);
		expect(currentTitle()).toBe("Renamed");
	});

	it("does not record the undo's own write as a new edit", async () => {
		// The bug that made redo unreachable: the restore used to go back through
		// `setDocument`, whose deferred `import("./undo")` pushed in a later microtask —
		// after the re-entrancy guard had already been re-armed. The pre-undo document
		// landed on `past` and `pushHistory` cleared `future`, so one Ctrl+Z turned the
		// history into an A/B toggle with redo permanently gone.
		await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true });
		expect(past).toHaveLength(1);

		expect(undo()).toBe(true);
		await Promise.resolve();
		await Promise.resolve();

		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);
	});

	it("walks back more than one level", async () => {
		// The microtask race silently capped this at one: the second Ctrl+Z replayed
		// the document the first had just pushed back on, so undo oscillated.
		await useProjectStore.getState().saveDocument(titled("Second"), { history: true });
		await useProjectStore.getState().saveDocument(titled("Third"), { history: true });
		expect(currentTitle()).toBe("Third");

		expect(undo()).toBe(true);
		expect(currentTitle()).toBe("Second");
		expect(undo()).toBe(true);
		expect(currentTitle()).toBe("Original");
		expect(undo()).toBe(false);

		expect(redo()).toBe(true);
		expect(currentTitle()).toBe("Second");
		expect(redo()).toBe(true);
		expect(currentTitle()).toBe("Third");
	});

	it("skips history for writes the user did not make", async () => {
		// Probe backfills, background transcripts and the persist an undo itself
		// triggers all opt out — a Ctrl+Z that reverted one of those would either do
		// nothing visible or throw the transcript away.
		await useProjectStore.getState().saveDocument(titled("Backfilled"), { history: false });

		expect(past).toHaveLength(0);
		expect(undo()).toBe(false);
		expect(currentTitle()).toBe("Backfilled");
	});

	it("keeps the redo entry when the restored document is persisted", async () => {
		// What `NewEditorShell` does in `useUndoRedoShortcuts`'s callback. Without
		// `history: false` there, the persist re-records the restored document and
		// wipes the redo the undo just created.
		await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true });
		expect(undo()).toBe(true);

		const restored = useProjectStore.getState().document;
		if (!restored) throw new Error("no document to persist");
		await useProjectStore.getState().saveDocument(restored, { history: false });

		expect(future).toHaveLength(1);
		expect(redo()).toBe(true);
		expect(currentTitle()).toBe("Renamed");
	});

	it("drops the redo stack once a new edit lands on an undone document", async () => {
		await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true });
		expect(undo()).toBe(true);
		expect(future).toHaveLength(1);

		await useProjectStore.getState().saveDocument(titled("Different branch"), { history: true });

		expect(future).toHaveLength(0);
		expect(redo()).toBe(false);
	});

	it("refuses to restore a snapshot from another project", async () => {
		await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true });
		useProjectStore.setState({ projectId: "project_2" });

		expect(undo()).toBe(false);
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(0);
	});

	it("marks the document dirty so the restore can be persisted", async () => {
		await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true });
		expect(useProjectStore.getState().dirty).toBe(false);

		const revisionBefore = useProjectStore.getState().revision;
		expect(undo()).toBe(true);

		expect(useProjectStore.getState().dirty).toBe(true);
		// Consumers repaint off `document`; `revision` is what the agent-apply guard reads.
		expect(useProjectStore.getState().revision).toBe(revisionBefore + 1);
	});

	describe("a write that failed", () => {
		// `saveDocument` resolves false on a handled failure -- a read-only project --
		// and every caller reads that as "the edit did not happen". Recording history
		// ABOVE the await recorded it anyway, and nothing ever took it back off.

		it("records no undo step, so Ctrl+Z is not left doing nothing", async () => {
			// The exact symptom #433 was filed for, re-created by the first fix for it:
			// `past` held a snapshot identical to the document on screen, so the next
			// Ctrl+Z restored what was already there.
			saveMock.mockResolvedValueOnce({ success: false, error: "EACCES" });

			expect(
				await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true }),
			).toBe(false);

			expect(currentTitle()).toBe("Original");
			expect(past).toHaveLength(0);
			expect(undo()).toBe(false);
		});

		it("leaves the redo stack alone", async () => {
			// Worse than a wasted step: `pushHistory` clears `future` on its way past, so
			// a failed write destroyed a redo the user had already earned.
			await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true });
			expect(undo()).toBe(true);
			expect(future).toHaveLength(1);

			saveMock.mockResolvedValueOnce({ success: false, error: "EACCES" });
			expect(
				await useProjectStore.getState().saveDocument(titled("Rejected"), { history: true }),
			).toBe(false);

			expect(future).toHaveLength(1);
			expect(redo()).toBe(true);
			expect(currentTitle()).toBe("Renamed");
		});

		it("records the step once a retry lands", async () => {
			// Not recording is only correct if the record still happens when the write
			// eventually succeeds -- otherwise the fix trades one dead Ctrl+Z for another.
			saveMock.mockResolvedValueOnce({ success: false, error: "EACCES" });
			await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true });

			await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true });

			expect(currentTitle()).toBe("Renamed");
			expect(past).toHaveLength(1);
			expect(undo()).toBe(true);
			expect(currentTitle()).toBe("Original");
		});
	});

	it("records the pre-drag document a commit names, not the one on screen", async () => {
		// `historyBase`. A live drag writes every pointermove into the store with
		// `history: false`, so by commit time the store's own "previous" document is the
		// dragged one -- recording that would leave the gesture un-undoable.
		const dragged = titled("Dragged");
		const preDrag = useProjectStore.getState().document;
		useProjectStore.getState().setDocument(dragged, { history: false });
		expect(past).toHaveLength(0);

		await useProjectStore.getState().saveDocument(dragged, { history: true, historyBase: preDrag });

		expect(past).toHaveLength(1);
		expect(undo()).toBe(true);
		expect(currentTitle()).toBe("Original");
	});
});

describe("the Edit menu's undo/redo route", () => {
	// On macOS the native menu is the ONLY path Cmd+Z has to the renderer: AppKit
	// matches the menu item's key equivalent before the key event reaches the web
	// contents, so the keydown listener never runs. `electron/main.ts` therefore
	// forwards `menu-undo` / `menu-redo` over IPC, and `NewEditorShell` wires them to
	// these handlers. The Electron half is pinned in `electron/edit-menu.test.ts`.
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		saveMock.mockReset();
		saveMock.mockImplementation(async (document: unknown) => ({ success: true, document }));
		useProjectStore.setState({ projectId: PROJECT_ID, document: titled("Original") });
		window.document.body.innerHTML = "";
	});

	it("undoes the document and persists the restore", async () => {
		const persist = vi.fn();
		const { result } = renderHook(() => useUndoRedoShortcuts(persist));
		await useProjectStore.getState().saveDocument(titled("Renamed"), { history: true });

		act(() => {
			result.current.runUndo();
		});

		expect(currentTitle()).toBe("Original");
		expect(persist).toHaveBeenCalledOnce();

		act(() => {
			result.current.runRedo();
		});
		expect(currentTitle()).toBe("Renamed");
	});

	it("leaves a focused text field to the browser's own text undo", () => {
		// Same rule the keydown path applies, and the one thing the `undo` role was
		// still good for.
		const persist = vi.fn();
		const { result } = renderHook(() => useUndoRedoShortcuts(persist));
		past.push({ projectId: PROJECT_ID, doc: titled("Older") });

		const input = window.document.createElement("input");
		window.document.body.appendChild(input);
		input.focus();

		act(() => {
			result.current.runUndo();
		});

		expect(currentTitle()).toBe("Original");
		expect(past).toHaveLength(1);
		expect(persist).not.toHaveBeenCalled();
	});
});
