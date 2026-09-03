import { afterEach, describe, expect, it, vi } from "vitest";
import type { AxcutDocument, AxcutTranscript } from "../schema";
import { createEmptyDocument } from "../schema";
import { type DocumentWriteOptions, useProjectStore } from "./projectStore";
import { enqueueTranscriptTextEdit } from "./transcriptTextEdit";

const TRANSCRIPT: AxcutTranscript = {
	assetId: "asset_shared",
	language: "en",
	segments: [
		{
			id: "segment_shared",
			kind: "speech",
			startSec: 0,
			endSec: 1,
			text: "original",
			wordIds: ["word_shared"],
		},
	],
	words: [
		{
			id: "word_shared",
			segmentId: "segment_shared",
			startSec: 0,
			endSec: 1,
			text: "original",
		},
	],
};

function documentFor(projectId: string): AxcutDocument {
	const base = createEmptyDocument({ projectId, title: projectId });
	return {
		...base,
		project: { ...base.project, primaryAssetId: TRANSCRIPT.assetId },
		assets: [
			{
				id: TRANSCRIPT.assetId,
				kind: "video",
				label: `${projectId}.mp4`,
				originalPath: `/${projectId}.mp4`,
				cameraTrack: null,
			},
		],
		transcript: TRANSCRIPT,
		transcripts: [TRANSCRIPT],
	};
}

afterEach(() => {
	useProjectStore.getState().clear();
});

describe("enqueueTranscriptTextEdit", () => {
	it("saves against the latest document while the source project is still active", async () => {
		const source = documentFor("project_source");
		useProjectStore.setState({ projectId: source.project.id, document: source });
		const saveDocument = vi.fn(
			async (_document: AxcutDocument, _options: DocumentWriteOptions) => true,
		);
		const enqueue = vi.fn((task: () => Promise<boolean> | boolean) => Promise.resolve().then(task));

		await expect(
			enqueueTranscriptTextEdit({
				sourceProjectId: source.project.id,
				assetId: TRANSCRIPT.assetId,
				wordIds: ["word_shared"],
				text: "corrected",
				enqueue,
				saveDocument,
			}),
		).resolves.toBe(true);

		expect(saveDocument).toHaveBeenCalledTimes(1);
		const [savedDocument, options] = saveDocument.mock.calls[0];
		expect(savedDocument.transcripts[0].words[0].text).toBe("corrected");
		expect(savedDocument.transcript?.words[0].text).toBe("corrected");
		expect(options).toEqual({ history: true });
	});

	it("rejects a queued edit after the active project changes", async () => {
		const source = documentFor("project_source");
		const replacement = documentFor("project_replacement");
		useProjectStore.setState({ projectId: source.project.id, document: source });
		const saveDocument = vi.fn(
			async (_document: AxcutDocument, _options: DocumentWriteOptions) => true,
		);
		const enqueue = vi.fn((task: () => Promise<boolean> | boolean) => Promise.resolve().then(task));

		const pending = enqueueTranscriptTextEdit({
			sourceProjectId: source.project.id,
			assetId: TRANSCRIPT.assetId,
			wordIds: ["word_shared"],
			text: "must not cross projects",
			enqueue,
			saveDocument,
		});
		// Switch synchronously before the queued microtask executes. The replacement
		// deliberately reuses every transcript ID, so an asset lookup alone cannot
		// protect it from the stale edit.
		useProjectStore.setState({
			projectId: replacement.project.id,
			document: replacement,
		});

		await expect(pending).resolves.toBe(false);
		expect(saveDocument).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document).toBe(replacement);
	});
});
