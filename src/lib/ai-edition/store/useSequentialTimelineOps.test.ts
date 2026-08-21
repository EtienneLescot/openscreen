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
//   4. `enqueue` shares that one chain with `apply`, so a document write
//      that isn't an operation — the media panel's clip insertion — can't
//      race an op. A second queue would only serialise it against itself.

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
			// call in the queue sees the latest committed state, and report
			// success the way `projectStore.saveDocument` does.
			useProjectStore.getState().setDocument(doc, { history: true });
			callOrder.push(doc.timeline.trimRanges[0]?.startSec.toString() ?? "empty");
			return true;
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
			const r1 = result.current.apply(op1, { history: true });
			const r2 = result.current.apply(op2, { history: true });
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

	it("keeps the queue healthy when a save reports failure", async () => {
		// `projectStore.saveDocument` resolves false rather than rejecting -- it has
		// already told the user why. What this hook owes is that the failed op resolves
		// to null and the NEXT op still runs, off a document that never took the failed
		// edit.
		const seed = makeDocWithAsset();
		useProjectStore.setState({ document: seed });

		const saveDocument = vi
			.fn<(doc: AxcutDocument) => Promise<boolean>>()
			.mockResolvedValueOnce(false)
			.mockImplementationOnce(async (doc) => {
				useProjectStore.getState().setDocument(doc, { history: true });
				return true;
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

		let firstResult: AxcutDocument | null | undefined;
		let secondResult: AxcutDocument | null | undefined;
		await act(async () => {
			const p1 = result.current.apply(op1, { history: true });
			const p2 = result.current.apply(op2, { history: true });
			firstResult = await p1;
			secondResult = await p2;
		});

		expect(firstResult).toBeNull();
		expect(secondResult).not.toBeNull();
		// The queue survived the first failure — both saves were attempted.
		expect(saveDocument).toHaveBeenCalledTimes(2);
		expect(saveDocument).toHaveBeenNthCalledWith(2, secondResult, { history: true });
	});

	it("runs an enqueued write after the op ahead of it has committed", async () => {
		const seed = makeDocWithAsset();
		useProjectStore.setState({ document: seed });

		const saveDocument = vi.fn(async (doc: AxcutDocument) => {
			useProjectStore.getState().setDocument(doc, { history: true });
			return true;
		});

		const { result } = renderHook(() =>
			useSequentialTimelineOps({ fallbackDocument: seed, saveDocument }),
		);

		// What the insertion actually needs: the clip count, read at the moment
		// it runs. On its own queue this would still be the pre-op count.
		let trimsSeenByTask = -1;
		await act(async () => {
			const opPromise = result.current.apply(
				{
					type: "add_trim_range" as const,
					assetId: "asset_1",
					startSec: 1,
					endSec: 2,
					reason: "ahead of the insertion",
				},
				{ history: true },
			);
			const taskPromise = result.current.enqueue(() => {
				trimsSeenByTask = useProjectStore.getState().document?.timeline.trimRanges.length ?? -1;
			});
			await Promise.all([opPromise, taskPromise]);
		});

		expect(trimsSeenByTask).toBe(1);
	});

	it("keeps the chain usable after an enqueued write throws", async () => {
		const seed = makeDocWithAsset();
		useProjectStore.setState({ document: seed });

		const saveDocument = vi.fn(async (doc: AxcutDocument) => {
			useProjectStore.getState().setDocument(doc, { history: true });
			return true;
		});

		const { result } = renderHook(() =>
			useSequentialTimelineOps({ fallbackDocument: seed, saveDocument }),
		);

		let rejection: unknown;
		let ranAfterTheFailure = false;
		await act(async () => {
			const failing = result.current.enqueue(() => {
				throw new Error("insert failed");
			});
			const next = result.current.enqueue(() => {
				ranAfterTheFailure = true;
			});
			await failing.catch((err: unknown) => {
				rejection = err;
			});
			await next;
		});

		// The caller sees the failure...
		expect((rejection as Error).message).toBe("insert failed");
		// ...and the queue behind it did not stall.
		expect(ranAfterTheFailure).toBe(true);
	});

	it("returns null when the store has no document and no fallback is supplied", async () => {
		const saveDocument = vi.fn(async () => true);
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
			resolved = await result.current.apply(op, { history: true });
		});

		expect(resolved).toBeNull();
		// And the queue should NOT have called saveDocument — nothing to save.
		expect(saveDocument).not.toHaveBeenCalled();
	});

	it("returns the saved document from the apply() promise", async () => {
		const seed = makeDocWithAsset();
		useProjectStore.setState({ document: seed });

		const saveDocument = vi.fn(async (doc: AxcutDocument) => {
			useProjectStore.getState().setDocument(doc, { history: true });
			return true;
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
			returned = await result.current.apply(op, { history: true });
		});

		expect(returned).toBeDefined();
		expect(returned?.timeline.trimRanges).toHaveLength(1);
		expect(returned?.timeline.trimRanges[0]?.startSec).toBe(1);
		expect(returned?.timeline.trimRanges[0]?.endSec).toBe(2);
	});

	it("hands the caller's write options through instead of picking them", async () => {
		// This used to hardcode `{ history: true }`, which was right for both of today's
		// callers and invisible to any future one. That is the exact shape of the #433
		// regression `projectStore.replaceTimeline` shipped with: a wrapper whose
		// signature hides the option decides it, so no compile error can reach the call
		// site that got it wrong. `documentWriteAudit.test.ts` pins the shape; this pins
		// the behaviour.
		const seed = makeDocWithAsset();
		useProjectStore.setState({ document: seed });
		const saveDocument = vi.fn(async () => true);

		const { result } = renderHook(() =>
			useSequentialTimelineOps({ fallbackDocument: seed, saveDocument }),
		);

		await act(async () => {
			await result.current.apply(
				{
					type: "add_trim_range" as const,
					assetId: "asset_1",
					startSec: 1,
					endSec: 2,
					reason: "a background job, not the user",
				},
				{ history: false },
			);
		});

		expect(saveDocument).toHaveBeenCalledWith(expect.anything(), { history: false });
	});
});
