// Hook: region mutations for the new editor shell. Wraps the project store
// with typed add/remove/select operations for zoom, trim, annotation, and
// speed regions. Each add creates a 2-second region at the current playhead
// (a reasonable default for the user to then resize).

import { useCallback, useEffect, useRef, useState } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AnnotationRegion, AnnotationType } from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import { createId } from "../document/ids";
import {
	duplicateClip as duplicateClipInDocument,
	moveClip as moveClipInDocument,
	PLACEHOLDER_DURATION_SEC,
	type RegionKind,
	rederiveRegionMs,
	removeClip as removeClipInDocument,
	removeRegion as removeRegionInDocument,
	resequenceClips,
	setClipSourceRange,
} from "../document/timeline";
import type { AxcutClipCropRegion, AxcutDocument } from "../schema";
import { hasAnyClipWithCamera } from "../timeline/camera";
import { probeVideoDimensions, probeVideoDuration } from "../timeline/duration";
import {
	anchorRegionsWithDerivedMs,
	dropPillsByIds,
	replacePillSpan,
	resolvePillIds,
} from "../timeline/timelineMap";
import { dropTrimPillsByIds, resolveTimelineSpanToTrim } from "../timeline/trim-mapping";
import type { AutoZoomSuggestion } from "../timeline/zoom-suggestions";
import { useProjectStore } from "./projectStore";

// How long a region lasts when the caller doesn't say. The timeline's toolbar
// passes its own duration instead, derived from the current zoom so the new pill
// always comes out the same WIDTH on screen (see PILL_CREATE_PX in V4Timeline).
// Every other entry point — keyboard shortcuts, the agent, auto-zooms — gets
// these 2 s, which is what all five add* used to hardcode.
const DEFAULT_NEW_REGION_SEC = 2;

// NaN-guarded floors. Timeline inputs arrive from drag deltas and persisted
// documents, both of which can carry NaN; every action needs the same guard.
const finiteSec = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
const finiteMs = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
const finiteFraction = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

// Placeholder duration applied to a freshly-inserted clip whose source asset hasn't
// reported its real duration yet (media drag → drop before the preview video fires
// `loadedmetadata`). `applyProbedDuration` (document layer) swaps it — and the
// extent-less clip a legacy v2 import mints — for the real length once metadata
// arrives. Defined there, re-exported here so existing importers keep working and the
// value has exactly one definition.
export { PLACEHOLDER_DURATION_SEC };

interface RegionHandle {
	kind: RegionKind;
	id: string;
}

type Clip = AxcutDocument["timeline"]["clips"][number];

/**
 * Patch every region under the pill `id` belongs to. A payload edit must hit them all,
 * or the pieces of one pill would disagree — and then, by the merge rule, visibly split.
 */
function patchPillById<T extends { id: string; startMs: number; endMs: number }>(
	regions: T[],
	id: string,
	patch: Partial<T>,
): T[] {
	const under = new Set(resolvePillIds(regions, id));
	return regions.map((r) => (under.has(r.id) ? { ...r, ...patch } : r));
}

/**
 * Playhead position at CALL time, read imperatively — deliberately not a
 * subscription.
 *
 * `currentTimeSec` is rewritten on every animation frame during playback (see
 * VirtualPreview's rAF tick). Subscribing to it here would give this hook's
 * return value a new identity 60×/s and re-render every consumer with it — and
 * `useTimeline()` is called by the editor shell, so that meant re-rendering the
 * whole editor (timeline, clips, waveforms, inspector) once per frame just to
 * move the playhead a few pixels. That render cascade was the playhead's own
 * stutter: React had to commit the entire tree before the playhead's DOM moved.
 *
 * Nothing in this hook RENDERS the playhead — the add* actions below only need
 * its value at the instant the user fires them, which is exactly what a
 * getState() read gives (and is strictly fresher than a captured render value).
 */
function playheadSec(): number {
	return useProjectStore.getState().currentTimeSec;
}

export function useTimeline() {
	const ts = useScopedT("settings");
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const setDocument = useProjectStore((s) => s.setDocument);
	const [selection, setSelection] = useState<RegionHandle | null>(null);
	// F2.7 — shift-click multi-selection. `selection` stays the inspector's
	// focused region (the last one clicked); `multiSelection` is the full set
	// the Delete key operates on.
	const [multiSelection, setMultiSelection] = useState<RegionHandle[]>([]);
	const [clipSelection, setClipSelection] = useState<string | null>(null);
	// Pre-drag snapshots for the two optimistic paths (zoom focus, annotations), so a
	// failed commit can put the document back instead of leaving an edit on screen that
	// was never written.
	const zoomFocusRollbackRef = useRef<AxcutDocument | null>(null);
	const zoomFocusLiveRef = useRef<AxcutDocument | null>(null);
	const annotationRollbackRef = useRef<AxcutDocument | null>(null);
	const annotationLiveRef = useRef<AxcutDocument | null>(null);

	// A drag does not always end in a commit: `ZoomFocusOverlay` unmounts the moment
	// `focusMode` flips to "auto", so `endDrag` never runs and the snapshot outlives the
	// project. Left alone, resetting focus in project B and failing that save restored
	// project A's document into B -- the next successful save then wrote A over B. It
	// also pinned two whole documents per hook instance, and annotations can carry
	// base64 image data URLs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: projectId is the trigger, not a read — the body only clears refs.
	useEffect(() => {
		zoomFocusRollbackRef.current = null;
		zoomFocusLiveRef.current = null;
		annotationRollbackRef.current = null;
		annotationLiveRef.current = null;
	}, [projectId]);

	const hasDoc = document !== null && projectId !== null;

	// Backfill missing source dimensions for any USED asset whose `video` was never probed.
	// `probeAndCorrectClip` only populates dims on INSERT, gated on a null duration, so an asset
	// saved with a duration but no dims (e.g. a project migrated from before dims were probed
	// alongside duration) never gets re-probed — opening it triggers no insert. `asset.video` is
	// the single source of truth for a clip's real shape/size: the ratio picker's ORIGINAL list
	// (collectNativeFormats), the output resolution (referenceClipDims) and the export badges all
	// read it, so an unpopulated one silently drops that clip from ALL of them — which is why a
	// cropped clip could show under ORIGINAL while an un-probed 16:9 sibling was missing entirely.
	// Probe once on load and persist via saveDocument with `history: false` (a write the user
	// never made must not be what the next Ctrl+Z reverses), so the fix sticks and every consumer
	// agrees without each re-probing on its own (what the export dialog used to do). Attempt each
	// asset at most once per session, even on failure, so a file that can't be probed doesn't
	// spin the effect on every document change.
	const probedAssetIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (!document) return;
		const usedAssetIds = new Set(document.timeline.clips.map((c) => c.assetId));
		type Asset = (typeof document.assets)[number];
		const needsScreen = (a: Asset) =>
			Boolean(a.originalPath) && (!a.video || !a.video.width || !a.video.height);
		// The camera is backfilled the same way and for the same reason. The PiP's layout
		// box is derived from these dimensions, so an asset that never carried them was
		// laid out from a hardcoded 4:3 — and differently depending on who was asking: the
		// preview had a mounted <video> reporting the real size, an export had nothing, so
		// a 16:9 camera came out framed one way on screen and another in the file.
		const needsCamera = (a: Asset) =>
			Boolean(a.cameraTrack?.sourcePath) && (!a.cameraTrack?.width || !a.cameraTrack?.height);
		const missing = document.assets.filter(
			(a) =>
				usedAssetIds.has(a.id) &&
				(needsScreen(a) || needsCamera(a)) &&
				!probedAssetIdsRef.current.has(a.id),
		);
		if (missing.length === 0) return;
		let cancelled = false;
		void (async () => {
			type Dims = { width: number; height: number };
			const probed: Record<string, { video?: Dims; camera?: Dims }> = {};
			for (const a of missing) {
				probedAssetIdsRef.current.add(a.id);
				const entry: { video?: Dims; camera?: Dims } = {};
				if (needsScreen(a)) {
					const dims = await probeVideoDimensions(toFileUrl(a.originalPath));
					if (dims) entry.video = dims;
				}
				// Probed independently of the screen: one file being unreadable must not cost
				// the other its dimensions, and a camera-less asset simply skips this.
				if (a.cameraTrack && needsCamera(a)) {
					const dims = await probeVideoDimensions(toFileUrl(a.cameraTrack.sourcePath));
					if (dims) entry.camera = dims;
				}
				if (entry.video || entry.camera) probed[a.id] = entry;
			}
			if (cancelled || Object.keys(probed).length === 0) return;
			// Re-read fresh state so a concurrent edit made while probing isn't stomped.
			const current = useProjectStore.getState().document;
			if (!current) return;
			// `history: false` — see the comment above: a backfill nobody asked for must
			// not become the thing the next Ctrl+Z reverses.
			await useProjectStore.getState().saveDocument(
				{
					...current,
					assets: current.assets.map((a) => {
						const found = probed[a.id];
						if (!found) return a;
						return {
							...a,
							...(found.video
								? { video: { codec: "unknown", fps: 0, ...a.video, ...found.video } }
								: {}),
							...(found.camera && a.cameraTrack
								? { cameraTrack: { ...a.cameraTrack, ...found.camera } }
								: {}),
						};
					}),
				},
				{ history: false },
			);
		})();
		return () => {
			cancelled = true;
		};
	}, [document]);

	// Every add* below anchors the new region to the clip(s) it covers before storing it.
	// A modifier MUST own a clip anchor to survive reorder/trim (see
	// technical-documentation/architecture/timeline-model.md) — writing only startMs/endMs
	// would strand it. A region created across a clip boundary becomes one fragment per
	// clip; the ruler renders them as one pill because their properties are equal.
	const addZoom = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC) => {
			if (!document) return;
			const timeMs = Math.round(playheadSec() * 1000);
			const endMs = timeMs + Math.round(durationSec * 1000);
			const anchored = anchorRegionsWithDerivedMs(
				[
					{
						id: createId("zoom"),
						startMs: timeMs,
						endMs,
						depth: 3,
						focus: { cx: 0.5, cy: 0.5 },
						focusMode: "manual" as const,
					},
				],
				document.timeline.clips,
				() => createId("zoom"),
			);
			const next: AxcutDocument = {
				...document,
				zoomRanges: [...document.zoomRanges, ...anchored] as AxcutDocument["zoomRanges"],
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Append several auto-generated zoom regions in one save (auto-enhance).
	// Suggestions come from buildAutoZoomSuggestions, which already reserves
	// existing zoom spans, so no extra overlap filtering is needed here.
	// Returns the count actually added (0 when there's no doc/suggestions).
	const addZoomsBulk = useCallback(
		async (suggestions: AutoZoomSuggestion[]) => {
			if (!document || suggestions.length === 0) return 0;
			const anchored = suggestions.flatMap((s) =>
				anchorRegionsWithDerivedMs(
					[
						{
							id: createId("zoom"),
							startMs: Math.round(s.span.start),
							endMs: Math.round(s.span.end),
							depth: 3 as const,
							focus: { cx: s.focus.cx, cy: s.focus.cy },
							focusMode: "auto" as const,
						},
					],
					document.timeline.clips,
					() => createId("zoom"),
				),
			);
			const next: AxcutDocument = {
				...document,
				zoomRanges: [...document.zoomRanges, ...anchored] as AxcutDocument["zoomRanges"],
			};
			if (!(await saveDocument(next, { history: true }))) return 0;
			return suggestions.length;
		},
		[document, saveDocument],
	);

	const addTrim = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC) => {
			if (!document) return;
			// Insert a 2s trim at the playhead in *timeline* time, then resolve it
			// down to the correct clip's asset + source-time. Writing currentTimeSec
			// straight into startSec (as before) only happened to be right for an
			// identity single-clip project — for trimmed/reordered clips it landed
			// the trim at the wrong source position.
			const playhead = playheadSec();
			const end = playhead + durationSec;
			const resolved = resolveTimelineSpanToTrim(playhead, end, document.timeline.clips);
			const asset =
				document.assets.find((a) => a.id === document.project.primaryAssetId) ?? document.assets[0];
			if (!resolved && !asset) return;
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: [
						...document.timeline.trimRanges,
						{
							id: createId("trim"),
							assetId: resolved?.assetId ?? asset!.id,
							// The carrier clip, so the cut lands on THAT clip and not on every clip
							// sharing its media (see `trimAppliesToClip`). Absent only in the
							// no-clip fallback below, where there is no clip to name.
							...(resolved ? { clipId: resolved.clipId } : {}),
							startSec: resolved?.sourceStartSec ?? playhead,
							endSec: resolved?.sourceEndSec ?? end,
							reason: "manual",
							origin: "user" as const,
						},
					],
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	const addAnnotation = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC) => {
			if (!document) return;
			const timeMs = Math.round(playheadSec() * 1000);
			const ann: AnnotationRegion = {
				id: createId("ann"),
				startMs: timeMs,
				endMs: timeMs + Math.round(durationSec * 1000),
				type: "text" as AnnotationType,
				// Real, localised text rather than an empty field. An empty annotation
				// renders nothing at all, so the user added a region and saw no change
				// on the canvas; the inspector's placeholder is CSS ghost text that
				// never reaches `content`, so it never reached the compositor either.
				// `textContent` stays empty because the render path reads
				// `content || textContent` and seeding both would just duplicate it.
				content: ts("annotation.defaultText"),
				textContent: "",
				position: { x: 50, y: 50 },
				size: { width: 30, height: 20 },
				style: {
					color: "#ffffff",
					backgroundColor: "transparent",
					fontSize: 32,
					fontFamily: "Inter",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					textAlign: "center",
					textAnimation: "none",
				},
				zIndex: document.annotations.length + 1,
			};
			const created = anchorRegionsWithDerivedMs([ann], document.timeline.clips, () =>
				createId("ann"),
			);
			const next: AxcutDocument = {
				...document,
				annotations: [
					...document.annotations,
					...created,
				] as unknown as AxcutDocument["annotations"],
			};
			if (!(await saveDocument(next, { history: true }))) return;
			// Select the freshly added annotation so its inspector opens and it shows a
			// selection box on the canvas, ready to be retyped over.
			const newId = created[0]?.id ?? ann.id;
			setMultiSelection([{ kind: "annotation", id: newId }]);
			setSelection({ kind: "annotation", id: newId });
			// `ts` is memoised on [locale, namespace] by useScopedT, so this does not
			// churn the callback identity between renders.
		},
		[document, saveDocument, ts],
	);

	const addSpeed = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC) => {
			if (!document) return;
			const timeMs = Math.round(playheadSec() * 1000);
			const endMs = timeMs + Math.round(durationSec * 1000);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = (legacy.speedRegions as unknown[]) ?? [];
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					speedRegions: [
						...prev,
						...anchorRegionsWithDerivedMs(
							[{ id: createId("speed"), startMs: timeMs, endMs, speed: 1.5 as const }],
							document.timeline.clips,
							() => createId("speed"),
						),
					],
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Full Camera: a plain time span (no value) during which the preview/export
	// grows the webcam overlay to (almost) fill the canvas and eases it back.
	//
	// With no webcam anywhere on the timeline there is nothing to grow, so the region
	// renders nothing in the preview (`PreviewCanvas.effectiveLayout` short-circuits on
	// a missing `webcamRect`) and nothing in the export — it just sits in
	// `legacyEditor.cameraFullscreenRegions` forever. The agent's `addCameraFullscreen`
	// tool already refuses this and says why (electron/ai-edition/agent-tools.ts,
	// `noCameraUnderSpan`); the gate lives HERE rather than at each button so both UI
	// entry points — the toolbar and the `C` shortcut — and any future one are covered
	// by construction. `hasAnyClipWithCamera` is the consolidated answer to "does this
	// project have a camera at all", used the same way by the Layout pane.
	const addCameraFullscreen = useCallback(
		async (durationSec = DEFAULT_NEW_REGION_SEC) => {
			if (!document) return;
			if (!hasAnyClipWithCamera(document.assets, document.timeline.clips)) return;
			const timeMs = Math.round(playheadSec() * 1000);
			const endMs = timeMs + Math.round(durationSec * 1000);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = (legacy.cameraFullscreenRegions as unknown[]) ?? [];
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					cameraFullscreenRegions: [
						...prev,
						...anchorRegionsWithDerivedMs(
							[{ id: createId("camfull"), startMs: timeMs, endMs }],
							document.timeline.clips,
							() => createId("camfull"),
						),
					],
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Like updateTrimRange but also re-attaches the trim to a (possibly different) CLIP —
	// needed when a trim is dragged across a clip boundary, whether or not the landing clip
	// is backed by another asset. Re-pointing `clipId` as well as `assetId` is what makes a
	// drag onto the second clip of a duplicated asset actually move the cut instead of
	// leaving it on the first (the two are indistinguishable by asset + source range alone).
	// Callers resolve the timeline span via `resolveTimelineSpanToTrim`.
	const updateTrim = useCallback(
		async (
			trimId: string,
			next: { assetId: string; clipId?: string; startSec: number; endSec: number },
		) => {
			if (!document) return;
			const s = finiteSec(next.startSec);
			const e = finiteSec(next.endSec);
			const nextDoc: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: document.timeline.trimRanges.map((r) =>
						r.id === trimId
							? {
									...r,
									assetId: next.assetId,
									clipId: next.clipId,
									startSec: Math.min(s, e),
									endSec: Math.max(s, e),
								}
							: r,
					),
				},
			};
			await saveDocument(nextDoc, { history: true });
		},
		[document, saveDocument],
	);

	// Reconcile the set of trim entries "owned" by one drag with a freshly
	// ventilated result. A trim resized across a clip boundary can't stay a
	// single source range (source-time is per asset), so it materialises as one
	// entry per covered clip — the caller passes explicit, stable ids (so the
	// dragged pill keeps its identity across frames) plus `dropIds` for entries a
	// shrinking span no longer needs. Trims not owned by this drag are untouched.
	const setTrimEntries = useCallback(
		async (
			entries: Array<{
				id: string;
				assetId: string;
				clipId?: string;
				sourceStartSec: number;
				sourceEndSec: number;
			}>,
			dropIds: string[],
		) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const managed = new Set<string>([...entries.map((e) => e.id), ...dropIds]);
			const others = doc.timeline.trimRanges.filter((r) => !managed.has(r.id));
			const rebuilt = entries.map((e) => {
				const prev = doc.timeline.trimRanges.find((r) => r.id === e.id);
				const s = finiteSec(e.sourceStartSec);
				const en = finiteSec(e.sourceEndSec);
				return {
					id: e.id,
					assetId: e.assetId,
					// Ventilation names the covered clip per entry; carrying it through is what
					// keeps a drag over two clips of the SAME media as two distinct cuts rather
					// than one that lands on both.
					clipId: e.clipId,
					startSec: Math.min(s, en),
					endSec: Math.max(s, en),
					reason: prev?.reason ?? "manual",
					origin: prev?.origin ?? ("user" as const),
				};
			});
			await saveDocument(
				{
					...doc,
					timeline: { ...doc.timeline, trimRanges: [...others, ...rebuilt] },
				},
				{ history: true },
			);
		},
		[saveDocument],
	);

	// Span edits are GROUP-AWARE: dragging/resizing a pill re-anchors every fragment
	// under the pill to the new ruler span, so an edit that crosses a clip
	// boundary re-splits and one dragged back inside a clip collapses — one user edit stays
	// one pill. See timelineMap.reanchorGroupSpan.
	const updateZoomSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const s = finiteMs(startMs);
			const e = finiteMs(endMs);
			const next: AxcutDocument = {
				...document,
				zoomRanges: replacePillSpan(
					document.zoomRanges,
					id,
					Math.min(s, e),
					Math.max(s, e),
					document.timeline.clips,
					() => createId("zoom"),
				) as AxcutDocument["zoomRanges"],
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// ponytail: the focus overlay drags at pointermove frequency (~60-120 Hz).
	// Routing every frame through `saveDocument` (IPC round-trip + disk write
	// + zod re-parse + full store replace) made dragging visibly laggy.
	// `updateZoomFocusLive` mirrors `useEditorSettings`'s setLive/commit split:
	// local-only store writes while dragging, one persisted save on release.
	const updateZoomFocusLive = useCallback(
		(id: string, focus: { cx: number; cy: number }) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			// The first live write of a drag is the one editing a document this callback
			// did not itself produce, so it is the pre-drag state — the one thing worth
			// returning to. It is remembered, not recorded: `commitZoomFocus` hands it to
			// `saveDocument` as `historyBase`, so the whole gesture becomes ONE undo step
			// and only once the write landed. Recording it here instead left the entry
			// behind when the commit failed and rolled the document back to that very
			// document — a Ctrl+Z that visibly did nothing, with `future` already wiped.
			if (zoomFocusLiveRef.current !== doc) zoomFocusRollbackRef.current = doc;
			const next: AxcutDocument = {
				...doc,
				zoomRanges: patchPillById(doc.zoomRanges, id, {
					focus: { cx: finiteFraction(focus.cx), cy: finiteFraction(focus.cy) },
				}) as AxcutDocument["zoomRanges"],
			};
			setDocument(next, { history: false });
			zoomFocusLiveRef.current = next;
		},
		[setDocument],
	);

	const commitZoomFocus = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		// The snapshot counts only while the document on screen is still the one this
		// hook's last live write produced -- `updateZoomFocusLive`'s own identity test,
		// read the other way round. Without it a commit that arrives with no live write
		// in front of it picks up whatever an abandoned drag left behind, and every
		// recording write since has already put the states in between on the stack: as a
		// `historyBase` that makes one Ctrl+Z step over the lot, and on the failure path
		// below it puts that buried document back on screen, silently dropping them.
		// `handlePointerDown` sets `draggingRef` BEFORE its live write and that write
		// returns early on a zero-size overlay rect, so `endDrag` can reach here bare.
		const rollback = zoomFocusLiveRef.current === doc ? zoomFocusRollbackRef.current : null;
		zoomFocusRollbackRef.current = null;
		zoomFocusLiveRef.current = null;
		// `historyBase: rollback` — the pre-drag document, not the one the store holds
		// (that is the dragged one, written live). `null` when no live write happened,
		// which records nothing, which is right: nothing changed.
		if (!(await saveDocument(doc, { history: true, historyBase: rollback })) && rollback) {
			useProjectStore.setState((state) =>
				// `dirty` is deliberately NOT cleared. The rollback target is the last document
				// this drag started from, which is not the same as the last SAVED one: with two
				// commits in flight the first one's unsaved document is what we restore. Saying
				// "clean" there tells `beforeunload` and `setHasUnsavedChanges` there is nothing
				// to save, and the window closes on real work without prompting.
				state.document === doc ? { document: rollback, revision: state.revision + 1 } : {},
			);
		}
	}, [saveDocument]);

	// Zoom-level control for the region-settings panel (1-6, matches
	// zoomRegionSchema's depth literal union — 1.0x..3.5x in 0.5x steps per
	// the `depth/2 + 0.5` label formula used throughout the timeline UI).
	const updateZoomDepth = useCallback(
		async (id: string, depth: 1 | 2 | 3 | 4 | 5 | 6) => {
			if (!document) return;
			const next: AxcutDocument = {
				...document,
				zoomRanges: patchPillById(document.zoomRanges, id, {
					depth,
				}) as AxcutDocument["zoomRanges"],
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Same story as `focusMode` below: the 3D tilt was implemented end to end — schema
	// (`rotationPreset`), migration, `sceneDescription` (`rotation:`), `rotation3d_for` in
	// regions.rs and the perspective shader in compositor.rs — with no control to set it.
	// `undefined` clears the preset back to a flat frame; `migrate.ts` already drops the field
	// when it is falsy, so absent and "no rotation" are the same state.
	const updateZoomRotation = useCallback(
		async (id: string, rotationPreset: "iso" | "left" | "right" | undefined) => {
			if (!document) return;
			const next: AxcutDocument = {
				...document,
				zoomRanges: patchPillById(document.zoomRanges, id, {
					rotationPreset,
				}) as AxcutDocument["zoomRanges"],
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Nothing could set `focusMode`: "auto" only ever arrived from the automatic suggestion pass
	// (`zoomSuggestions.ts`), so a hand-drawn zoom stayed pinned to its static focus point with no
	// way to make it follow the cursor. The capability itself was complete end to end —
	// `sceneDescription.ts` ships the mode, `scene.rs` parses it, `regions.rs::resolve_focus`
	// samples the cursor track — only this setter was missing.
	//
	// Writing "manual" explicitly is safe even though `migrate.ts` only persists "auto": an absent
	// field MEANS manual, so both forms resolve identically.
	const updateZoomFocusMode = useCallback(
		async (id: string, focusMode: "manual" | "auto") => {
			if (!document) return;
			const next: AxcutDocument = {
				...document,
				zoomRanges: patchPillById(document.zoomRanges, id, {
					focusMode,
				}) as AxcutDocument["zoomRanges"],
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	const updateAnnotationSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const s = finiteMs(startMs);
			const e = finiteMs(endMs);
			const next: AxcutDocument = {
				...document,
				annotations: replacePillSpan(
					document.annotations,
					id,
					Math.min(s, e),
					Math.max(s, e),
					document.timeline.clips,
					() => createId("ann"),
				),
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	// Drag/resize on the preview overlay (position, size, blur mask edits) — same
	// live/commit split as updateZoomFocusLive/commitZoomFocus, for the same
	// reason: local-only writes while dragging, one persisted save on release.
	const updateAnnotationLive = useCallback(
		(id: string, patch: Partial<AxcutDocument["annotations"][number]>) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			// One undo step per drag, recorded by the commit once it lands — same
			// reasoning, and the same failed-commit hole, as `updateZoomFocusLive` above.
			if (annotationLiveRef.current !== doc) annotationRollbackRef.current = doc;
			const next: AxcutDocument = {
				...doc,
				annotations: patchPillById(doc.annotations, id, patch),
			};
			setDocument(next, { history: false });
			annotationLiveRef.current = next;
		},
		[setDocument],
	);

	const commitAnnotationChange = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		// See `commitZoomFocus`: the snapshot counts only while the document on screen is
		// still the one this hook's live writes produced. This is the reachable half.
		// The inspector's annotation `<textarea>` calls `updateAnnotationLive` on every
		// keystroke and commits `onBlur`, and closing the panel unmounts the focused node
		// before blur can fire: `V4Timeline`'s `startScrub` clears the selection from a
		// pointerdown handler, and React flushes discrete events synchronously, so the
		// textarea is gone before mousedown moves focus. (Deleting the region does NOT
		// reach here — its button is an `onClick`, which runs after blur has committed.)
		// `SliderCell` then wires mouseup
		// straight to `onCommit`, so a bare click on a stroke-width thumb lands here
		// carrying the typing's base. `NewEditorShell` builds one `useTimeline()` for
		// both, so it is one instance's ref.
		const rollback = annotationLiveRef.current === doc ? annotationRollbackRef.current : null;
		annotationRollbackRef.current = null;
		annotationLiveRef.current = null;
		// The pre-drag document is the undo target, and it is recorded only if this write
		// succeeds.
		if (!(await saveDocument(doc, { history: true, historyBase: rollback })) && rollback) {
			useProjectStore.setState((state) =>
				// `dirty` is deliberately NOT cleared. The rollback target is the last document
				// this drag started from, which is not the same as the last SAVED one: with two
				// commits in flight the first one's unsaved document is what we restore. Saying
				// "clean" there tells `beforeunload` and `setHasUnsavedChanges` there is nothing
				// to save, and the window closes on real work without prompting.
				state.document === doc ? { document: rollback, revision: state.revision + 1 } : {},
			);
		}
	}, [saveDocument]);

	const updateSpeedSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const s = finiteMs(startMs);
			const e = finiteMs(endMs);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = ((legacy.speedRegions as unknown[]) ?? []) as Array<{
				id: string;
				startMs: number;
				endMs: number;
				speed: number;
			}>;
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					speedRegions: replacePillSpan(
						prev,
						id,
						Math.min(s, e),
						Math.max(s, e),
						document.timeline.clips,
						() => createId("speed"),
					),
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	const updateCameraFullscreenSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const s = finiteMs(startMs);
			const e = finiteMs(endMs);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = ((legacy.cameraFullscreenRegions as unknown[]) ?? []) as Array<{
				id: string;
				startMs: number;
				endMs: number;
			}>;
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					cameraFullscreenRegions: replacePillSpan(
						prev,
						id,
						Math.min(s, e),
						Math.max(s, e),
						document.timeline.clips,
						() => createId("camfull"),
					),
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	const updateSpeedValue = useCallback(
		async (id: string, speed: number) => {
			if (!document) return;
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = ((legacy.speedRegions as unknown[]) ?? []) as Array<{
				id: string;
				startMs: number;
				endMs: number;
				speed: number;
			}>;
			const next: AxcutDocument = {
				...document,
				legacyEditor: {
					...legacy,
					speedRegions: patchPillById(prev, id, { speed }),
				},
			};
			await saveDocument(next, { history: true });
		},
		[document, saveDocument],
	);

	const removeRegion = useCallback(
		async (kind: RegionKind, id: string) => {
			if (!document) return;
			// One shared mutator with the agent's removeTrim / removeModifier tools.
			if (!(await saveDocument(removeRegionInDocument(document, kind, id), { history: true })))
				return;
			if (selection?.id === id) setSelection(null);
			setMultiSelection((prev) => prev.filter((h) => h.id !== id));
		},
		[document, selection, saveDocument],
	);

	// F2.7 — batch removal for multi-selection: one document save (one undo
	// snapshot) regardless of how many regions are selected.
	const removeRegions = useCallback(
		async (handles: RegionHandle[]) => {
			if (!document || handles.length === 0) return;
			const zoomIds = new Set(handles.filter((h) => h.kind === "zoom").map((h) => h.id));
			const trimIds = new Set(handles.filter((h) => h.kind === "trim").map((h) => h.id));
			const annotationIds = new Set(
				handles.filter((h) => h.kind === "annotation").map((h) => h.id),
			);
			const speedIds = new Set(handles.filter((h) => h.kind === "speed").map((h) => h.id));
			const cameraFullscreenIds = new Set(
				handles.filter((h) => h.kind === "cameraFullscreen").map((h) => h.id),
			);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prevSpeed = dropPillsByIds(
				(legacy.speedRegions as Array<{ id: string; startMs: number; endMs: number }>) ?? [],
				speedIds,
			);
			const prevCameraFullscreen = dropPillsByIds(
				(legacy.cameraFullscreenRegions as Array<{ id: string; startMs: number; endMs: number }>) ??
					[],
				cameraFullscreenIds,
			);
			const next: AxcutDocument = {
				...document,
				zoomRanges: dropPillsByIds(document.zoomRanges, zoomIds) as AxcutDocument["zoomRanges"],
				annotations: dropPillsByIds(document.annotations, annotationIds),
				timeline: {
					...document.timeline,
					// Whole-pill delete, same as the zoom/annotation lines above — a trim grown
					// across a clip boundary is 2+ rows rendering as one stripe, and a bare id
					// filter left the halves the selection didn't name still cutting.
					trimRanges: dropTrimPillsByIds(
						document.timeline.trimRanges,
						document.timeline.clips,
						trimIds,
					),
				},
				legacyEditor:
					speedIds.size > 0 || cameraFullscreenIds.size > 0
						? { ...legacy, speedRegions: prevSpeed, cameraFullscreenRegions: prevCameraFullscreen }
						: document.legacyEditor,
			};
			if (!(await saveDocument(next, { history: true }))) return;
			setSelection(null);
			setMultiSelection([]);
		},
		[document, saveDocument],
	);

	// Selecting a pill and selecting a clip are the SAME act — "this is the thing
	// I mean" — so they cancel each other. They used to be two states that could
	// both be set: the user saw one highlighted element while the app still held
	// the other, and everything keyed off "is a clip selected?" (copy, paste,
	// delete) silently acted on the invisible one. Copy/paste is where it showed:
	// it always operated on the clip, whatever the user had just clicked.
	const selectRegion = useCallback(
		(kind: RegionKind, id: string, opts?: { additive?: boolean }) => {
			const handle = { kind, id };
			setClipSelection(null);
			if (opts?.additive) {
				// Shift-click toggles membership; the focused region follows the click.
				setMultiSelection((prev) => {
					const exists = prev.some((h) => h.kind === kind && h.id === id);
					return exists ? prev.filter((h) => !(h.kind === kind && h.id === id)) : [...prev, handle];
				});
				setSelection(handle);
				return;
			}
			setMultiSelection([handle]);
			setSelection(handle);
		},
		[],
	);

	const clearSelection = useCallback(() => {
		setSelection(null);
		setMultiSelection([]);
		setClipSelection(null);
	}, []);

	// The Edit Clip dialog's Apply, as ONE document and ONE save.
	//
	// Source range and crop are two edits made in a single user action, and they used to
	// be two independent saves fired back to back. Both built their next document from
	// the SAME pre-Apply one — the crop write never saw the source-range change — so
	// whichever IPC write landed last silently dropped the other edit, with no error and
	// no toast (#355). Composing them means the crop is applied to the *resequenced*
	// clips, which is also the only order that can be right.
	//
	// Axcut-consistent clip trim: only the source range is user-editable (the dialog's
	// draggable track). Changing it changes the clip's effective duration, so every clip
	// is resequenced back-to-back afterward — same invariant as
	// insertClipAt/moveClip/removeClip — instead of leaving downstream clips at their old
	// timeline positions (which would overlap). That whole recipe (resequence width +
	// clamp/rederive pills) lives in the one pure `setClipSourceRange`, shared with the op
	// dispatcher and the LLM tool.
	//
	// Crop is a per-clip framing, not a document-wide setting — two clips (even from the
	// same asset) can reasonably want different crops. `undefined` means the dialog's crop
	// section was never touched (leave the stored value alone); `null` clears it back to
	// "no crop" (full frame) rather than storing the identity region explicitly.
	//
	// The document is read from the store, not off the render closure, so this composes
	// with `useSequentialTimelineOps`: queued behind another timeline write, it still sees
	// what that write committed. Same reason as `setTrimEntries` / `insertClipAt`.
	const applyClipEdit = useCallback(
		async (
			clipId: string,
			sourceStartSec: number,
			sourceEndSec: number,
			cropRegion?: AxcutClipCropRegion | null,
		) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const ranged = setClipSourceRange(doc, clipId, sourceStartSec, sourceEndSec);
			const next: AxcutDocument =
				cropRegion === undefined
					? ranged
					: {
							...ranged,
							timeline: {
								...ranged.timeline,
								clips: ranged.timeline.clips.map((c) =>
									c.id === clipId ? { ...c, cropRegion: cropRegion ?? undefined } : c,
								),
							},
						};
			await saveDocument(next, { history: true });
		},
		[saveDocument],
	);

	// Background probe: read the asset's actual duration and patch the
	// freshly-inserted clip to use it. Trims if the clip has already been
	// trimmed (sourceEndSec != PLACEHOLDER_DURATION_SEC) so we never stomp
	// on user edits. Also persists the duration back onto the asset so
	// subsequent inserts use the cached value without re-probing.
	const probeAndCorrectClip = useCallback(
		async (assetId: string, clipId: string, originalPath: string) => {
			const fileUrl = toFileUrl(originalPath);
			// Dims probed alongside duration — otherwise `asset.video` stays permanently unset for
			// most recordings (nothing else populates it), silently breaking anything that reads
			// real source dimensions later (e.g. the export dialog's downscale/upscale badges).
			const [probedDuration, probedDims] = await Promise.all([
				probeVideoDuration(fileUrl),
				probeVideoDimensions(fileUrl),
			]);
			const state = useProjectStore.getState();
			const doc = state.document;
			if (!doc) return;
			const asset = doc.assets.find((a) => a.id === assetId);
			const needsDims = probedDims != null && !asset?.video;
			if (probedDuration == null && !needsDims) return;

			// Guard: only correct clips still sitting at the 0..60s placeholder.
			// If the user has since trimmed the clip or moved on, leave it alone.
			const clip = doc.timeline.clips.find((c) => c.id === clipId);
			const stillPlaceholder =
				clip != null &&
				clip.sourceStartSec === 0 &&
				Math.abs((clip.sourceEndSec ?? 0) - PLACEHOLDER_DURATION_SEC) < 0.01;
			const correctDuration = probedDuration != null && stillPlaceholder;
			if (!correctDuration && !needsDims) return;

			// Only correct the probed clip's own length here — do NOT hand-shift
			// every sibling by the delta, since that has no notion of which clips
			// sit before vs. after this one in timeline order (it used to shift
			// earlier clips too, corrupting their positions). resequenceClips lays
			// everything back-to-back from t=0 using each clip's own (now correct)
			// length, so it's the correct + already-shared way to renormalize.
			const oldClips = doc.timeline.clips;
			const nextClips = correctDuration
				? resequenceClips(
						oldClips.map((c) =>
							c.id === clipId
								? {
										...c,
										sourceEndSec: probedDuration as number,
										timelineEndSec: c.timelineStartSec + (probedDuration as number),
									}
								: c,
						),
					)
				: oldClips;
			const nextAssets = doc.assets.map((a) => {
				if (a.id !== assetId) return a;
				return {
					...a,
					...(correctDuration ? { durationSec: probedDuration as number } : {}),
					...(needsDims ? { video: { codec: "unknown", fps: 0, ...a.video, ...probedDims } } : {}),
				};
			});
			// `history: false`. Nothing about this write is a user action: `addAsset` never
			// populates `durationSec`, so EVERY freshly imported asset lands at the 60s
			// placeholder and fires this probe. Recording it put a placeholder-length clip
			// on the undo stack a beat after the drop, so the first Ctrl+Z snapped the clip
			// back to 60s instead of removing it — and a probe resolving after the user
			// had already undone wiped `future`, destroying redo from a background write.
			await state.saveDocument(
				{
					...doc,
					assets: nextAssets,
					timeline: { ...doc.timeline, clips: nextClips },
				},
				{ history: false },
			);
		},
		[],
	);

	// Insert a new full-duration clip for `assetId` at position `index`
	// (0 = before all, clips.length = after all), then resequence.
	//
	// ponytail: probe the file's actual duration via a throwaway <video> in
	// the BACKGROUND so the drop event stays responsive. Earlier this awaited
	// probeVideoDuration synchronously, which could take up to 5s on a slow
	// disk or broken file path — the user saw the UI freeze for the whole
	// probe window with no feedback. Now: insert the clip immediately at the
	// placeholder (60s), then update its sourceEndSec / timelineEndSec when
	// the probe resolves. If the user has since trimmed the clip, we leave it
	// alone (same guard handleLoadedMetadata uses).
	const insertClipAt = useCallback(
		async (assetId: string, index: number) => {
			const currentDoc = useProjectStore.getState().document;
			if (!currentDoc) return;
			const asset = currentDoc.assets.find((a) => a.id === assetId);
			if (!asset) return;
			// Insert immediately at whatever we know. If the asset has a cached
			// durationSec we use it; otherwise we fall back to the placeholder
			// and let the background probe correct it.
			const knownDuration = asset.durationSec ?? PLACEHOLDER_DURATION_SEC;
			const newClip: Clip = {
				id: createId("clip"),
				assetId,
				sourceStartSec: 0,
				sourceEndSec: knownDuration,
				timelineStartSec: 0,
				timelineEndSec: knownDuration,
				wordRefs: [],
				origin: "user",
				reason: "Inserted from media panel",
			};
			const oldClips = currentDoc.timeline.clips;
			const arr = [...oldClips];
			const at = Math.max(0, Math.min(arr.length, index));
			arr.splice(at, 0, newClip);
			const newClips = resequenceClips(arr);
			const next: AxcutDocument = {
				...currentDoc,
				timeline: { ...currentDoc.timeline, clips: newClips },
			};
			const finalDoc = rederiveRegionMs(next, newClips);
			if (!(await saveDocument(finalDoc, { history: true }))) return;
			setClipSelection(newClip.id);

			// If we used the placeholder, kick off the probe in the background.
			// Don't await — the drop is already responsive; the probe will
			// correct the clip when it lands.
			if (asset.durationSec == null) {
				// Detached on purpose (see above), so it needs its own handler: the probe
				// itself only ever resolves, but it finishes with a `saveDocument`, and
				// that THROWS on a failed write. Losing a background duration correction
				// is survivable — the clip keeps its placeholder length; an unhandled
				// rejection is not.
				void probeAndCorrectClip(assetId, newClip.id, asset.originalPath).catch((err) => {
					console.warn("[timeline] background duration probe failed to save:", err);
				});
			}
		},
		[saveDocument, probeAndCorrectClip],
	);

	// Reorder a clip to a new index, then resequence timeline positions.
	// Delegates to the shared document/timeline.ts implementation — the same
	// function the agent tool-executor uses for "move_clip" ops — so both
	// paths stay in step instead of maintaining two copies of the
	// splice/resequence logic that could drift.
	const moveClip = useCallback(
		async (clipId: string, toIndex: number) => {
			if (!document) return;
			if (!document.timeline.clips.some((c) => c.id === clipId)) return;
			await saveDocument(moveClipInDocument(document, clipId, toIndex), { history: true });
		},
		[document, saveDocument],
	);

	// Duplicate a clip in place (same asset + source range), inserted right
	// after the original, then resequenced. Mirrors Axcut's Ctrl+C/Ctrl+V.
	// Delegates to the shared implementation (see moveClip above).
	const duplicateClip = useCallback(
		async (clipId: string) => {
			if (!document) return;
			if (!document.timeline.clips.some((c) => c.id === clipId)) return;
			// duplicateClipInDocument inserts the copy immediately after the
			// original, so its index in the result is the original's index + 1.
			const insertedIndex = document.timeline.clips.findIndex((c) => c.id === clipId) + 1;
			const next = duplicateClipInDocument(document, clipId, "user", "Duplicated clip");
			if (!(await saveDocument(next, { history: true }))) return;
			setClipSelection(next.timeline.clips[insertedIndex]?.id ?? null);
		},
		[document, saveDocument],
	);

	const removeClip = useCallback(
		async (clipId: string) => {
			if (!document) return;
			// One shared mutator with the agent's removeClip tool: reflow survivors + rederive pills.
			if (!(await saveDocument(removeClipInDocument(document, clipId), { history: true }))) return;
			if (clipSelection === clipId) setClipSelection(null);
		},
		[document, clipSelection, saveDocument],
	);

	// Mirror of selectRegion: picking a clip retires the pill selection.
	const selectClip = useCallback((id: string) => {
		setClipSelection(id);
		setSelection(null);
		setMultiSelection([]);
	}, []);

	const speedRegions = hasDoc
		? (((document.legacyEditor as Record<string, unknown> | null)?.speedRegions as Array<{
				id: string;
				startMs: number;
				endMs: number;
				speed: number;
			}>) ?? [])
		: [];

	const cameraFullscreenRegions = hasDoc
		? (((document.legacyEditor as Record<string, unknown> | null)
				?.cameraFullscreenRegions as Array<{
				id: string;
				startMs: number;
				endMs: number;
			}>) ?? [])
		: [];

	return {
		zoomRegions: document?.zoomRanges ?? [],
		trimRanges: document?.timeline.trimRanges ?? [],
		annotationRegions: (document?.annotations ?? []) as unknown as AnnotationRegion[],
		speedRegions,
		cameraFullscreenRegions,
		clips: document?.timeline.clips ?? [],
		assets: document?.assets ?? [],
		hasDoc,
		selection,
		multiSelection,
		clipSelection,
		addZoom,
		addZoomsBulk,
		addTrim,
		addAnnotation,
		addSpeed,
		addCameraFullscreen,
		removeRegion,
		removeRegions,
		selectRegion,
		clearSelection,
		applyClipEdit,
		insertClipAt,
		moveClip,
		duplicateClip,
		removeClip,
		selectClip,
		updateTrim,
		setTrimEntries,
		updateZoomSpan,
		updateZoomFocusLive,
		commitZoomFocus,
		updateZoomDepth,
		updateZoomRotation,
		updateZoomFocusMode,
		updateAnnotationSpan,
		updateAnnotationLive,
		commitAnnotationChange,
		updateSpeedSpan,
		updateSpeedValue,
		updateCameraFullscreenSpan,
		// T19 — drives the preview video during trim-edge resize.
		setCurrentTime: useProjectStore((s) => s.setCurrentTime),
	};
}
