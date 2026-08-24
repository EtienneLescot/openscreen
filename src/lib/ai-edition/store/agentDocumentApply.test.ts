// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../schema";
import { applyAgentDocumentIfCurrent, runAgentTurn } from "./agentDocumentApply";
import { useProjectStore } from "./projectStore";
import { clearHistory, redo, undo } from "./undo";
import { future, past } from "./undoStack";

const saveMock = vi.hoisted(() => vi.fn());

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: { save: saveMock },
	},
}));

describe("applyAgentDocumentIfCurrent", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		saveMock.mockReset();
	});

	it("applies an agent result when the document revision is unchanged", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const agentResult = {
			...before,
			project: { ...before.project, title: "Agent edit" },
		};
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		await expect(applyAgentDocumentIfCurrent(agentResult, 4)).resolves.toBe("applied");

		expect(saveMock).toHaveBeenCalledOnce();
		expect(useProjectStore.getState().document?.project.title).toBe("Agent edit");
	});

	it("preserves a manual edit made after the agent snapshot", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const agentResult = {
			...before,
			project: { ...before.project, title: "Agent edit" },
		};
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		useProjectStore.getState().setDocument(
			{
				...before,
				project: { ...before.project, title: "Manual edit" },
			},
			{ history: true },
		);

		await expect(applyAgentDocumentIfCurrent(agentResult, 4)).resolves.toBe("conflict");

		expect(saveMock).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("Manual edit");
	});

	it("puts the document back when the save fails, and does not call it applied", async () => {
		// Without this the user is told the edits were rejected while looking at them, and
		// `dirty` is left set -- so the next unrelated save writes the rejected document.
		//
		// `saveDocument` reports its own failures and resolves false rather than
		// throwing. This was written against a `saveDocument` that threw, and the two
		// changes landed minutes apart: a dead `catch` type-checks, so the rollback
		// stopped firing and "applied" came back for a write that never happened.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const agentResult = { ...before, project: { ...before.project, title: "Agent edit" } };
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		saveMock.mockResolvedValue({ success: false, error: "EACCES" });

		await expect(applyAgentDocumentIfCurrent(agentResult, 4)).resolves.toBe("save-failed");

		expect(useProjectStore.getState().document?.project.title).toBe("Before");
		expect(useProjectStore.getState().dirty).toBe(false);
	});

	it("leaves no undo step behind a rejected agent edit", async () => {
		// The rollback is a `setState` by design, so it cannot pop an entry the apply
		// already pushed. Recording on the optimistic `setDocument` therefore left a
		// phantom Ctrl+Z step for an edit that never reached disk -- and `pushHistory`
		// had cleared `future` on the way in, so the user's redo went with it.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });

		// A real edit and an undo first, so there is a redo entry to lose.
		saveMock.mockResolvedValueOnce({
			success: true,
			document: { ...before, project: { ...before.project, title: "User edit" } },
		});
		await useProjectStore
			.getState()
			.saveDocument(
				{ ...before, project: { ...before.project, title: "User edit" } },
				{ history: true },
			);
		expect(undo()).toBe(true);
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);

		saveMock.mockResolvedValue({ success: false, error: "EACCES" });
		const agentResult = { ...before, project: { ...before.project, title: "Agent edit" } };
		await expect(applyAgentDocumentIfCurrent(agentResult)).resolves.toBe("save-failed");

		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);
		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("User edit");
	});

	it("does not roll back over an undo that overtook its save", async () => {
		// `saveDocument` resolves false for two different things now: the write failed,
		// and the write was superseded by an undo while it was in flight. The rollback
		// above is right for the first and catastrophic for the second -- it would put
		// the agent's pre-edit document over the one the user just asked to return to,
		// on the agent's behalf, seconds after they pressed Ctrl+Z.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });

		// A user edit to have something to undo TO, then hold the agent's save open.
		saveMock.mockImplementation(async (document: unknown) => ({ success: true, document }));
		await useProjectStore
			.getState()
			.saveDocument(
				{ ...before, project: { ...before.project, title: "User edit" } },
				{ history: true },
			);

		let release: (() => void) | undefined;
		saveMock.mockImplementationOnce(async (document: unknown) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { success: true, document };
		});
		const agentResult = { ...before, project: { ...before.project, title: "Agent edit" } };
		const applying = applyAgentDocumentIfCurrent(agentResult);

		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Before");

		release?.();
		await expect(applying).resolves.toBe("save-failed");

		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("records exactly one undo step for an agent edit that lands", async () => {
		// Two writes, one step: the optimistic `setDocument` opts out and the save
		// names the pre-agent document as its base. Losing the step altogether would
		// be the same class of bug in the other direction.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const agentResult = { ...before, project: { ...before.project, title: "Agent edit" } };
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		await expect(applyAgentDocumentIfCurrent(agentResult, 4)).resolves.toBe("applied");

		expect(past).toHaveLength(1);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("still rejects when the agent hands back something that is not a document", async () => {
		// The one throw left on this path, and the reason the caller keeps a try/catch.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });

		await expect(applyAgentDocumentIfCurrent({ not: "a document" }, 4)).rejects.toThrow();

		expect(useProjectStore.getState().document?.project.title).toBe("Before");
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("allows an explicit rewind to replace the current revision", async () => {
		const current = createEmptyDocument({ projectId: "project_1", title: "Current" });
		const checkpoint = {
			...current,
			project: { ...current.project, title: "Checkpoint" },
		};
		useProjectStore.setState({ projectId: "project_1", document: current, revision: 9 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		await expect(applyAgentDocumentIfCurrent(checkpoint)).resolves.toBe("applied");

		expect(useProjectStore.getState().document?.project.title).toBe("Checkpoint");
	});
});

describe("runAgentTurn", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		saveMock.mockReset();
	});

	it("refuses to apply when the document moved WHILE the turn was running", async () => {
		// The assertion the guard actually needs. Reading `revision` after the await --
		// the one-line mistake that restores the bug in full -- leaves every other test in
		// this file green, because they all move the store before the turn starts.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		const { result, applyDocument } = await runAgentTurn(async (documentSnapshot) => {
			// A background transcription landing mid-turn, which is the common case.
			useProjectStore.getState().setDocument(
				{
					...before,
					project: { ...before.project, title: "Manual edit" },
				},
				{ history: true },
			);
			return {
				document: { ...documentSnapshot, project: { ...before.project, title: "Agent edit" } },
			};
		});

		expect(result.document).toBeTruthy();
		await expect(applyDocument()).resolves.toBe("conflict");
		expect(saveMock).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("Manual edit");
	});

	it("applies anyway when the user answers the conflict toast", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		const { applyDocument } = await runAgentTurn(async () => {
			useProjectStore.getState().setDocument(
				{
					...before,
					project: { ...before.project, title: "Manual edit" },
				},
				{ history: true },
			);
			return { document: { ...before, project: { ...before.project, title: "Agent edit" } } };
		});

		await expect(applyDocument()).resolves.toBe("conflict");
		// Same turn, same document, still in hand -- the point of keeping it.
		await expect(applyDocument({ ignoreConflict: true })).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("Agent edit");
	});

	it("never writes a text-only turn over a real project", async () => {
		// With no document open the agent runs against an empty stand-in that still
		// carries the real project id, so a matching revision must not be enough.
		useProjectStore.setState({ projectId: "project_1", document: null, revision: 0 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		const { applyDocument } = await runAgentTurn(async (documentSnapshot) => {
			expect(documentSnapshot).toBeUndefined();
			return { document: createEmptyDocument({ projectId: "project_1", title: "Empty" }) };
		});

		await expect(applyDocument()).resolves.toBe("no-live-document");
		expect(saveMock).not.toHaveBeenCalled();
	});
});
