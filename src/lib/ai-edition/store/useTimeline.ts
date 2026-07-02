// Hook: region mutations for the new editor shell. Wraps the project store
// with typed add/remove/select operations for zoom, skip, annotation, and
// speed regions. Each add creates a 2-second region at the current playhead
// (a reasonable default for the user to then resize).

import { useCallback, useState } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AnnotationRegion, AnnotationType } from "@/components/video-editor/types";
import { createId } from "../document/ids";
import { resequenceClips } from "../document/timeline";
import type { AxcutDocument } from "../schema";
import { probeVideoDuration } from "../timeline/duration";
import { useProjectStore } from "./projectStore";

type RegionKind = "zoom" | "skip" | "annotation" | "speed";

// Placeholder duration applied to a freshly-inserted clip whose source asset
// hasn't reported its real duration yet (media drag → drop before the preview
// video fires `loadedmetadata`). The renderer's handleLoadedMetadata
// (NewEditorShell) scans for clips sitting at exactly this value and
// auto-corrects them to the probed duration once metadata arrives, so the
// timeline ruler, progress bar, and sourceEndSec all stay in sync.
export const PLACEHOLDER_DURATION_SEC = 60;

interface RegionHandle {
	kind: RegionKind;
	id: string;
}

type Clip = AxcutDocument["timeline"]["clips"][number];

export function useTimeline() {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const [selection, setSelection] = useState<RegionHandle | null>(null);
	// F2.7 — shift-click multi-selection. `selection` stays the inspector's
	// focused region (the last one clicked); `multiSelection` is the full set
	// the Delete key operates on.
	const [multiSelection, setMultiSelection] = useState<RegionHandle[]>([]);
	const [clipSelection, setClipSelection] = useState<string | null>(null);

	const hasDoc = document !== null && projectId !== null;

	const addZoom = useCallback(async () => {
		if (!document) return;
		const timeMs = Math.round(currentTimeSec * 1000);
		const next: AxcutDocument = {
			...document,
			zoomRanges: [
				...document.zoomRanges,
				{
					id: createId("zoom"),
					startMs: timeMs,
					endMs: timeMs + 2000,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
					focusMode: "manual" as const,
				},
			] as AxcutDocument["zoomRanges"],
		};
		await saveDocument(next);
	}, [document, currentTimeSec, saveDocument]);

	const addSkip = useCallback(async () => {
		if (!document) return;
		const asset =
			document.assets.find((a) => a.id === document.project.primaryAssetId) ?? document.assets[0];
		if (!asset) return;
		const id = createId("skip");
		const next: AxcutDocument = {
			...document,
			timeline: {
				...document.timeline,
				skipRanges: [
					...document.timeline.skipRanges,
					{
						id,
						assetId: asset.id,
						startSec: currentTimeSec,
						endSec: currentTimeSec + 2,
						reason: "manual",
						origin: "user" as const,
					},
				],
			},
		};
		await saveDocument(next);
	}, [document, currentTimeSec, saveDocument]);

	// T15 — add a skip at a specific (assetId, sourceStartSec, sourceEndSec).
	// Used by the place-skip mode in TimelinePane where the cursor lands
	// inside a specific clip's source range, not just at currentTimeSec.
	const addSkipAt = useCallback(
		async (assetId: string, sourceStartSec: number, sourceEndSec: number) => {
			if (!document) return;
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					skipRanges: [
						...document.timeline.skipRanges,
						{
							id: createId("skip"),
							assetId,
							startSec: sourceStartSec,
							endSec: sourceEndSec,
							reason: "manual",
							origin: "user" as const,
						},
					],
				},
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const addAnnotation = useCallback(async () => {
		if (!document) return;
		const timeMs = Math.round(currentTimeSec * 1000);
		const ann: AnnotationRegion = {
			id: createId("ann"),
			startMs: timeMs,
			endMs: timeMs + 2000,
			type: "text" as AnnotationType,
			content: "New annotation",
			textContent: "New annotation",
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
		const next: AxcutDocument = {
			...document,
			annotations: [...document.annotations, ann] as unknown as AxcutDocument["annotations"],
		};
		await saveDocument(next);
	}, [document, currentTimeSec, saveDocument]);

	const addSpeed = useCallback(async () => {
		if (!document) return;
		const timeMs = Math.round(currentTimeSec * 1000);
		const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
		const prev = (legacy.speedRegions as unknown[]) ?? [];
		const next: AxcutDocument = {
			...document,
			legacyEditor: {
				...legacy,
				speedRegions: [
					...prev,
					{
						id: createId("speed"),
						startMs: timeMs,
						endMs: timeMs + 2000,
						speed: 1.5 as const,
					},
				],
			},
		};
		await saveDocument(next);
	}, [document, currentTimeSec, saveDocument]);

	const updateSkipRange = useCallback(
		async (skipId: string, startSec: number, endSec: number) => {
			if (!document) return;
			const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
			const s = clamp(startSec);
			const e = clamp(endSec);
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					skipRanges: document.timeline.skipRanges.map((r) =>
						r.id === skipId ? { ...r, startSec: Math.min(s, e), endSec: Math.max(s, e) } : r,
					),
				},
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const updateZoomSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const clampMs = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
			const s = clampMs(startMs);
			const e = clampMs(endMs);
			const next: AxcutDocument = {
				...document,
				zoomRanges: document.zoomRanges.map((z) =>
					z.id === id ? { ...z, startMs: Math.min(s, e), endMs: Math.max(s, e) } : z,
				) as AxcutDocument["zoomRanges"],
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const updateAnnotationSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const clampMs = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
			const s = clampMs(startMs);
			const e = clampMs(endMs);
			const next: AxcutDocument = {
				...document,
				annotations: document.annotations.map((a) =>
					a.id === id ? { ...a, startMs: Math.min(s, e), endMs: Math.max(s, e) } : a,
				),
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const updateSpeedSpan = useCallback(
		async (id: string, startMs: number, endMs: number) => {
			if (!document) return;
			const clampMs = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
			const s = clampMs(startMs);
			const e = clampMs(endMs);
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
					speedRegions: prev.map((r) =>
						r.id === id ? { ...r, startMs: Math.min(s, e), endMs: Math.max(s, e) } : r,
					),
				},
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const removeRegion = useCallback(
		async (kind: RegionKind, id: string) => {
			if (!document) return;
			let next: AxcutDocument;
			if (kind === "zoom") {
				next = {
					...document,
					zoomRanges: document.zoomRanges.filter((z) => z.id !== id) as AxcutDocument["zoomRanges"],
				};
			} else if (kind === "skip") {
				next = {
					...document,
					timeline: {
						...document.timeline,
						skipRanges: document.timeline.skipRanges.filter((s) => s.id !== id),
					},
				};
			} else if (kind === "annotation") {
				next = {
					...document,
					annotations: document.annotations.filter((a) => a.id !== id),
				};
			} else {
				const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
				const prev = ((legacy.speedRegions as unknown[]) ?? []).filter(
					(s) => (s as { id: string }).id !== id,
				);
				next = {
					...document,
					legacyEditor: { ...legacy, speedRegions: prev },
				};
			}
			await saveDocument(next);
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
			const skipIds = new Set(handles.filter((h) => h.kind === "skip").map((h) => h.id));
			const annotationIds = new Set(
				handles.filter((h) => h.kind === "annotation").map((h) => h.id),
			);
			const speedIds = new Set(handles.filter((h) => h.kind === "speed").map((h) => h.id));
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prevSpeed = ((legacy.speedRegions as unknown[]) ?? []).filter(
				(s) => !speedIds.has((s as { id: string }).id),
			);
			const next: AxcutDocument = {
				...document,
				zoomRanges: document.zoomRanges.filter(
					(z) => !zoomIds.has(z.id),
				) as AxcutDocument["zoomRanges"],
				annotations: document.annotations.filter((a) => !annotationIds.has(a.id)),
				timeline: {
					...document.timeline,
					skipRanges: document.timeline.skipRanges.filter((s) => !skipIds.has(s.id)),
				},
				legacyEditor:
					speedIds.size > 0 ? { ...legacy, speedRegions: prevSpeed } : document.legacyEditor,
			};
			await saveDocument(next);
			setSelection(null);
			setMultiSelection([]);
		},
		[document, saveDocument],
	);

	const selectRegion = useCallback(
		(kind: RegionKind, id: string, opts?: { additive?: boolean }) => {
			const handle = { kind, id };
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
	}, []);

	const addClipBefore = useCallback(
		async (assetId: string) => {
			if (!document) return;
			const asset = document.assets.find((a) => a.id === assetId);
			if (!asset) return;
			const duration = asset.durationSec ?? PLACEHOLDER_DURATION_SEC;
			const newClip: AxcutDocument["timeline"]["clips"][number] = {
				id: createId("clip"),
				assetId,
				sourceStartSec: 0,
				sourceEndSec: duration,
				timelineStartSec: 0,
				timelineEndSec: duration,
				wordRefs: [],
				origin: "user",
				reason: "Inserted before all clips",
			};
			const shifted = document.timeline.clips.map((c) => ({
				...c,
				timelineStartSec: c.timelineStartSec + duration,
				timelineEndSec: c.timelineEndSec + duration,
			}));
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					clips: [newClip, ...shifted],
				},
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const addClipAfter = useCallback(
		async (assetId: string) => {
			if (!document) return;
			const asset = document.assets.find((a) => a.id === assetId);
			if (!asset) return;
			const duration = asset.durationSec ?? PLACEHOLDER_DURATION_SEC;
			const lastEnd = document.timeline.clips.at(-1)?.timelineEndSec ?? 0;
			const newClip: AxcutDocument["timeline"]["clips"][number] = {
				id: createId("clip"),
				assetId,
				sourceStartSec: 0,
				sourceEndSec: duration,
				timelineStartSec: lastEnd,
				timelineEndSec: lastEnd + duration,
				wordRefs: [],
				origin: "user",
				reason: "Inserted after all clips",
			};
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					clips: [...document.timeline.clips, newClip],
				},
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const editClip = useCallback(
		async (
			clipId: string,
			patch: Partial<
				Pick<
					AxcutDocument["timeline"]["clips"][number],
					"sourceStartSec" | "sourceEndSec" | "timelineStartSec" | "timelineEndSec"
				>
			>,
		) => {
			if (!document) return;
			// ponytail: clamp negative values and keep end >= start so the schema
			// refine doesn't reject the save. Swap when end < start instead of
			// throwing — a user typing into a number input is expected to be
			// able to type in any order.
			const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
			const next: AxcutDocument["timeline"]["clips"][number] = {
				...(document.timeline.clips.find((c) => c.id === clipId) as
					| AxcutDocument["timeline"]["clips"][number]
					| undefined),
			} as AxcutDocument["timeline"]["clips"][number];
			if (!next?.id) return;
			const sStart = clamp(patch.sourceStartSec ?? next.sourceStartSec);
			const sEnd = clamp(patch.sourceEndSec ?? next.sourceEndSec ?? 0);
			const tStart = clamp(patch.timelineStartSec ?? next.timelineStartSec);
			const tEnd = clamp(patch.timelineEndSec ?? next.timelineEndSec);
			const updated: AxcutDocument["timeline"]["clips"][number] = {
				...next,
				sourceStartSec: Math.min(sStart, sEnd),
				sourceEndSec: Math.max(sStart, sEnd),
				timelineStartSec: Math.min(tStart, tEnd),
				timelineEndSec: Math.max(tStart, tEnd),
			};
			const nextDoc: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					clips: document.timeline.clips.map((c) => (c.id === clipId ? updated : c)),
				},
			};
			await saveDocument(nextDoc);
		},
		[document, saveDocument],
	);

	// Axcut-consistent clip trim: only the source range is user-editable (the
	// Edit Clip dialog's draggable track). Changing it changes the clip's
	// effective duration, so every clip is resequenced back-to-back afterward —
	// same invariant as insertClipAt/moveClip/removeClip — instead of leaving
	// downstream clips at their old timeline positions (which would overlap).
	const updateClipSourceRange = useCallback(
		async (clipId: string, sourceStartSec: number, sourceEndSec: number) => {
			if (!document) return;
			const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
			const s = clamp(sourceStartSec);
			const e = clamp(sourceEndSec);
			const arr = document.timeline.clips.map((c) =>
				c.id === clipId
					? { ...c, sourceStartSec: Math.min(s, e), sourceEndSec: Math.max(s, e) }
					: c,
			);
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: resequenceClips(arr) },
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	const splitAndInsert = useCallback(
		async (assetId: string, splitTimeSec: number) => {
			if (!document) return;
			const asset = document.assets.find((a) => a.id === assetId);
			if (!asset) return;
			const duration = asset.durationSec ?? PLACEHOLDER_DURATION_SEC;
			const targetIdx = document.timeline.clips.findIndex(
				(c) => c.timelineStartSec <= splitTimeSec && c.timelineEndSec >= splitTimeSec,
			);
			if (targetIdx === -1) {
				await addClipAfter(assetId);
				return;
			}
			const target = document.timeline.clips[targetIdx];
			const left = {
				id: createId("clip"),
				assetId: target.assetId,
				sourceStartSec: target.sourceStartSec,
				sourceEndSec: splitTimeSec,
				timelineStartSec: target.timelineStartSec,
				timelineEndSec: splitTimeSec,
				wordRefs: [] as string[],
				origin: "user" as const,
				reason: "Split left",
			};
			const insert = {
				id: createId("clip"),
				assetId,
				sourceStartSec: 0,
				sourceEndSec: duration,
				timelineStartSec: splitTimeSec,
				timelineEndSec: splitTimeSec + duration,
				wordRefs: [] as string[],
				origin: "user" as const,
				reason: "Inserted between splits",
			};
			const right = {
				id: createId("clip"),
				assetId: target.assetId,
				sourceStartSec: target.sourceStartSec + splitTimeSec - target.timelineStartSec,
				sourceEndSec: target.sourceEndSec,
				timelineStartSec: splitTimeSec + duration,
				timelineEndSec: target.timelineEndSec + duration,
				wordRefs: [] as string[],
				origin: "user" as const,
				reason: "Split right",
			};
			const nextClips: AxcutDocument["timeline"]["clips"] = [
				...document.timeline.clips.slice(0, targetIdx),
				left,
				insert,
				right as (typeof document.timeline.clips)[number],
				...document.timeline.clips.slice(targetIdx + 1),
			];
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: nextClips },
			};
			await saveDocument(next);
		},
		[document, saveDocument, addClipAfter],
	);

	// Background probe: read the asset's actual duration and patch the
	// freshly-inserted clip to use it. Skips if the clip has already been
	// trimmed (sourceEndSec != PLACEHOLDER_DURATION_SEC) so we never stomp
	// on user edits. Also persists the duration back onto the asset so
	// subsequent inserts use the cached value without re-probing.
	const probeAndCorrectClip = useCallback(
		async (assetId: string, clipId: string, originalPath: string) => {
			const probed = await probeVideoDuration(toFileUrl(originalPath));
			if (probed == null) return;
			const state = useProjectStore.getState();
			const doc = state.document;
			if (!doc) return;
			const clip = doc.timeline.clips.find((c) => c.id === clipId);
			if (!clip) return;
			// Guard: only correct clips still sitting at the 0..60s placeholder.
			// If the user has since trimmed the clip or moved on, leave it alone.
			const stillPlaceholder =
				clip.sourceStartSec === 0 &&
				Math.abs((clip.sourceEndSec ?? 0) - PLACEHOLDER_DURATION_SEC) < 0.01;
			if (!stillPlaceholder) return;
			const shiftSec = probed - (clip.sourceEndSec ?? PLACEHOLDER_DURATION_SEC);
			const nextClips = doc.timeline.clips.map((c) => {
				if (c.id !== clipId) {
					return {
						...c,
						timelineStartSec: c.timelineStartSec + shiftSec,
						timelineEndSec: c.timelineEndSec + shiftSec,
					};
				}
				return {
					...c,
					sourceEndSec: probed,
					timelineEndSec: c.timelineStartSec + probed,
				};
			});
			const nextAssets = doc.assets.map((a) =>
				a.id === assetId ? { ...a, durationSec: probed } : a,
			);
			await state.saveDocument({
				...doc,
				assets: nextAssets,
				timeline: { ...doc.timeline, clips: nextClips },
			});
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
			const arr = [...currentDoc.timeline.clips];
			const at = Math.max(0, Math.min(arr.length, index));
			arr.splice(at, 0, newClip);
			const next: AxcutDocument = {
				...currentDoc,
				timeline: { ...currentDoc.timeline, clips: resequenceClips(arr) },
			};
			await saveDocument(next);
			setClipSelection(newClip.id);

			// If we used the placeholder, kick off the probe in the background.
			// Don't await — the drop is already responsive; the probe will
			// correct the clip when it lands.
			if (asset.durationSec == null) {
				void probeAndCorrectClip(assetId, newClip.id, asset.originalPath);
			}
		},
		[saveDocument, probeAndCorrectClip],
	);

	// Reorder a clip to a new index, then resequence timeline positions.
	const moveClip = useCallback(
		async (clipId: string, toIndex: number) => {
			if (!document) return;
			const arr = [...document.timeline.clips];
			const from = arr.findIndex((c) => c.id === clipId);
			if (from === -1) return;
			const [moved] = arr.splice(from, 1);
			const at = Math.max(0, Math.min(arr.length, toIndex));
			arr.splice(at, 0, moved);
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: resequenceClips(arr) },
			};
			await saveDocument(next);
		},
		[document, saveDocument],
	);

	// Duplicate a clip in place (same asset + source range), inserted right
	// after the original, then resequenced. Mirrors Axcut's Ctrl+C/Ctrl+V.
	const duplicateClip = useCallback(
		async (clipId: string) => {
			if (!document) return;
			const arr = [...document.timeline.clips];
			const from = arr.findIndex((c) => c.id === clipId);
			if (from === -1) return;
			const source = arr[from];
			const copy: Clip = {
				...source,
				id: createId("clip"),
				reason: "Duplicated clip",
			};
			arr.splice(from + 1, 0, copy);
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: resequenceClips(arr) },
			};
			await saveDocument(next);
			setClipSelection(copy.id);
		},
		[document, saveDocument],
	);

	const removeClip = useCallback(
		async (clipId: string) => {
			if (!document) return;
			const arr = document.timeline.clips.filter((c) => c.id !== clipId);
			const next: AxcutDocument = {
				...document,
				timeline: { ...document.timeline, clips: resequenceClips(arr) },
			};
			await saveDocument(next);
			if (clipSelection === clipId) setClipSelection(null);
		},
		[document, clipSelection, saveDocument],
	);

	const selectClip = useCallback((id: string) => setClipSelection(id), []);
	const clearClipSelection = useCallback(() => setClipSelection(null), []);

	const speedRegions = hasDoc
		? (((document.legacyEditor as Record<string, unknown> | null)?.speedRegions as Array<{
				id: string;
				startMs: number;
				endMs: number;
				speed: number;
			}>) ?? [])
		: [];

	return {
		zoomRegions: document?.zoomRanges ?? [],
		skipRanges: document?.timeline.skipRanges ?? [],
		annotationRegions: (document?.annotations ?? []) as unknown as AnnotationRegion[],
		speedRegions,
		clips: document?.timeline.clips ?? [],
		assets: document?.assets ?? [],
		hasDoc,
		selection,
		multiSelection,
		clipSelection,
		addZoom,
		addSkip,
		addSkipAt,
		addAnnotation,
		addSpeed,
		removeRegion,
		removeRegions,
		selectRegion,
		clearSelection,
		addClipBefore,
		addClipAfter,
		editClip,
		updateClipSourceRange,
		splitAndInsert,
		insertClipAt,
		moveClip,
		duplicateClip,
		removeClip,
		selectClip,
		clearClipSelection,
		updateSkipRange,
		updateZoomSpan,
		updateAnnotationSpan,
		updateSpeedSpan,
		// T19 — drives the preview video during skip-edge resize.
		setCurrentTime: useProjectStore((s) => s.setCurrentTime),
	};
}
