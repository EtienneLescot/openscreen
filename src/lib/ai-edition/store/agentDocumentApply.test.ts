// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../schema";
import { applyAgentDocumentIfCurrent } from "./agentDocumentApply";
import { useProjectStore } from "./projectStore";

const saveMock = vi.hoisted(() => vi.fn());

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: { save: saveMock },
	},
}));

describe("applyAgentDocumentIfCurrent", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
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
		useProjectStore.getState().setDocument({
			...before,
			project: { ...before.project, title: "Manual edit" },
		});

		await expect(applyAgentDocumentIfCurrent(agentResult, 4)).resolves.toBe("conflict");

		expect(saveMock).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("Manual edit");
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
