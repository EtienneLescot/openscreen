// @vitest-environment jsdom
//
// `useEditorSettings.test.ts`'s two cases, on the hook that shares its live/commit
// split. Both hooks hold the pre-drag document in `liveBaseRef` until a commit
// records it, both are driven by the same `SliderCell` — which fires `commit` from
// a bare mouseup, with no `onChange` in front of it — and neither `set` empties
// the refs, so a drag that never commits leaves a base behind for that click to
// pick up.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCaptionSettings } from "../captions";
import type { AxcutDocument } from "../schema";
import { axcutSchemaVersion } from "../schema";
import { useProjectStore } from "./projectStore";
import { clearHistory, undo } from "./undo";
import { past } from "./undoStack";
import { useCaptions } from "./useCaptions";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			get: bridgeMocks.get,
			create: bridgeMocks.create,
			save: bridgeMocks.save,
			addAsset: bridgeMocks.addAsset,
			removeAsset: bridgeMocks.removeAsset,
			listProjects: bridgeMocks.listProjects,
		},
	},
}));

const docA: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_a",
		title: "A",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
		primaryAssetId: "asset_1",
	},
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

const docB: AxcutDocument = {
	...docA,
	project: { ...docA.project, id: "proj_b", title: "B" },
};

/** `fontSize` of the document a snapshot holds. 48 is the untouched default, so
 *  reading it back says "this is the pre-drag document" in one number. */
const fontSizeOf = (doc: unknown) => getCaptionSettings(doc as AxcutDocument).fontSize;

describe("useCaptions drag snapshots", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: AxcutDocument) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_a",
			document: docA,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		clearHistory();
		vi.clearAllMocks();
	});

	it("does not record a snapshot of the project the user left", async () => {
		const { result, rerender } = renderHook(() => useCaptions());

		act(() => result.current.setLive({ insetY: 20 }));

		act(() => {
			useProjectStore.setState({ projectId: "proj_b", document: docB });
		});
		rerender();

		await act(async () => {
			await result.current.set({ fontSize: 30 });
		});
		expect(past.map((s) => s.projectId)).toEqual(["proj_b"]);

		await act(async () => {
			await result.current.commit();
		});

		expect(past.map((s) => s.projectId)).toEqual(["proj_b"]);
		// A foreign snapshot costs more than the one bogus step: `undo` answers a
		// projectId that is not the store's by clearing the whole stack.
		expect(undo()).toBe(true);
		expect(fontSizeOf(useProjectStore.getState().document)).toBe(48);
	});

	it("does not hand a bare commit a base the edits since have already buried", async () => {
		const { result } = renderHook(() => useCaptions());

		act(() => result.current.setLive({ insetY: 20 }));

		await act(async () => {
			await result.current.set({ fontSize: 30 });
		});
		await act(async () => {
			await result.current.set({ fontSize: 20 });
		});
		expect(past).toHaveLength(2);

		await act(async () => {
			await result.current.commit();
		});

		expect(past).toHaveLength(2);
		expect(undo()).toBe(true);
		expect(fontSizeOf(useProjectStore.getState().document)).toBe(30);
	});

	it("still records the pre-drag document when the drag does reach its commit", async () => {
		const { result } = renderHook(() => useCaptions());

		act(() => result.current.setLive({ fontSize: 60 }));
		act(() => result.current.setLive({ fontSize: 72 }));
		await act(async () => {
			await result.current.commit();
		});

		expect(past).toHaveLength(1);
		expect(undo()).toBe(true);
		expect(fontSizeOf(useProjectStore.getState().document)).toBe(48);
	});
});
