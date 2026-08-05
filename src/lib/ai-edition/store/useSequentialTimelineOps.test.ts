// @vitest-environment jsdom
// ponytail: tests for the queued timeline-op hook. The hook used to live
// inline in NewEditorShell.tsx (saveQueueRef + handleAddTrimRange /
// handleRemoveTrimRange) and was untested; the bug it fixed (synchronous
// doc read vs async save) is the kind of regression that slips back in
// without a test. These cover the three properties the inline pattern
// depended on:
//   1. Two concurrent calls are serialised — op N+1 reads the doc op N
//      committed, not the pre-op-N doc.
//   2. A save rejection doesn't poison the queue; the next call still
//      has a resolved promise to chain off.
//   3. The store-empty fallback (no project loaded) returns null instead
//      of crashing.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "./projectStore";
import { useSequentialTimelineOps } from "./useSequentialTimelineOps";

function makeDocWithAsset(): AxcutDocument {
	const base = createEmptyDocument({ projectId: "proj_seq", title: "seq" });
	return {
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.webm",
				originalPath: "/tmp/screen.webm",
				durationSec: 30,
				video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
				cameraTrack: null,
			},
		],
		project: { ...base.project, primaryAssetId: "asset_1" },
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_a",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	};
}

beforeEach(() => {
	useProjectStore.getState().clear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("useSequentialTimelineOps", () => {
	it("serialises calls: op N+1 reads the doc op N committed", async () => {
		const seed = makeDocWithAsset();
		useProjectStore.setState({ document: seed });

		const callOrder: string[] = [];
		const saveDocument = vi.fn(async (doc: AxcutDocument) => {
			// Mirror the real store: write the saved doc back so the next
			// call in the queue sees the latest committed state.
			useProjectStore.getState().setDocument(doc);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			callOrder.push(doc.timeline.trimRanges[0]?.startSec.toString() ?? "empty");
		});

		const { result } = renderHook(() =>
			useSequentialTimelineOps({ fallbackDocument: seed, saveDocument }),
		);

		const op1 = {
			type: "add_trim_range" as const,
			assetId: "asset_1",
			startSec: 1,
			endSec: 2,
			reason: "first",
		};
		const op2 = {
			type: "add_trim_range" as const,
			assetId: "asset_1",
			startSec: 5,
			endSec: 6,
			reason: "second",
		};

		await act(async () => {
			const r1 = result.current.apply(op1);
			const r2 = result.current.apply(op2);
			await Promise.all([r1, r2]);
		});

		// Both saves fired in queue order (callOrder), and the second save
		// saw a doc that ALREADY had the first trim applied.
		expect(callOrder).toEqual(["1", "1"]);
		expect(saveDocument).toHaveBeenCalledTimes(2);
		const doc1 = saveDocument.mock.calls[0]?.[0] as AxcutDocument;
		const doc2 = saveDocument.mock.calls[1]?.[0] as AxcutDocument;
		expect(doc1.timeline.trimRanges).toHaveLength(1);
		expect(doc1.timeline.trimRanges[0]?.startSec).toBe(1);
		expect(doc2.timeline.trimRanges).toHaveLength(2);
		expect(doc2.timeline.trimRanges.map((t) => t.startSec).sort()).toEqual([1, 5]);
	});

	it("swallows save errors so the next call can still proceed", async () => {
		const seed = makeDocWithAsset();
		useProjectStore.setState({ document: seed });

		const saveDocument = vi
			.fn<(doc: AxcutDocument) => Promise<void>>()
			.mockRejectedValueOnce(new Error("save failed"))
			.mockImplementationOnce(async (doc) => {
				useProjectStore.getState().setDocument(doc);
			});

		const { result } = renderHook(() =>
			useSequentialTimelineOps({ fallbackDocument: seed, saveDocument }),
		);

		const op1 = {
			type: "add_trim_range" as const,
			assetId: "asset_1",
			startSec: 1,
			endSec: 2,
			reason: "first",
		};
		const op2 = {
			type: "remove_trim_range" as const,
			trimId: "trim_doesnt_exist",
			reason: "second",
		};

		let firstSettled = false;
		let secondSettled = false;
		await act(async () => {
			const p1 = result.current.apply(op1);
			const p2 = result.current.apply(op2);
			await p1.catch((err: unknown) => {
				firstSettled = true;
				expect((err as Error).message).toBe("save failed");
			});
			await p2.then(() => {
				secondSettled = true;
			});
		});

		expect(firstSettled).toBe(true);
		expect(secondSettled).toBe(true);
		// The queue survived the first failure — both saves were attempted.
		expect(saveDocument).toHaveBeenCalledTimes(2);
	});

	it("returns null when the store has no document and no fallback is supplied", async () => {
		const saveDocument = vi.fn(async () => undefined);
		const { result } = renderHook(() =>
			useSequentialTimelineOps({ fallbackDocument: null, saveDocument }),
		);

		const op = {
			type: "add_trim_range" as const,
			assetId: "asset_1",
			startSec: 1,
			endSec: 2,
			reason: "no doc",
		};

		let resolved: AxcutDocument | null | undefined;
		await act(async () => {
			resolved = await result.current.apply(op);
		});

		expect(resolved).toBeNull();
		// And the queue should NOT have called saveDocument — nothing to save.
		expect(saveDocument).not.toHaveBeenCalled();
	});

	it("returns the saved document from the apply() promise", async () => {
		const seed = makeDocWithAsset();
		useProjectStore.setState({ document: seed });

		const saveDocument = vi.fn(async (doc: AxcutDocument) => {
			useProjectStore.getState().setDocument(doc);
		});

		const { result } = renderHook(() =>
			useSequentialTimelineOps({ fallbackDocument: seed, saveDocument }),
		);

		const op = {
			type: "add_trim_range" as const,
			assetId: "asset_1",
			startSec: 1,
			endSec: 2,
			reason: "x",
		};

		let returned: AxcutDocument | null | undefined;
		await act(async () => {
			returned = await result.current.apply(op);
		});

		expect(returned).toBeDefined();
		expect(returned?.timeline.trimRanges).toHaveLength(1);
		expect(returned?.timeline.trimRanges[0]?.startSec).toBe(1);
		expect(returned?.timeline.trimRanges[0]?.endSec).toBe(2);
	});
});
