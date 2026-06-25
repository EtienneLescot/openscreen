// Hook: region mutations for the new editor shell. Wraps the project store
// with typed add/remove/select operations for zoom, skip, annotation, and
// speed regions. Each add creates a 2-second region at the current playhead
// (a reasonable default for the user to then resize).

import { useCallback, useState } from "react";
import type { AnnotationRegion, AnnotationType } from "@/components/video-editor/types";
import { createId } from "../document/ids";
import type { AxcutDocument } from "../schema";
import { useProjectStore } from "./projectStore";

type RegionKind = "zoom" | "skip" | "annotation" | "speed";

interface RegionHandle {
	kind: RegionKind;
	id: string;
}

export function useTimeline() {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const [selection, setSelection] = useState<RegionHandle | null>(null);

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
		},
		[document, selection, saveDocument],
	);

	const selectRegion = useCallback((kind: RegionKind, id: string) => {
		setSelection({ kind, id });
	}, []);

	const clearSelection = useCallback(() => setSelection(null), []);

	const addClipBefore = useCallback(
		async (assetId: string) => {
			if (!document) return;
			const asset = document.assets.find((a) => a.id === assetId);
			if (!asset) return;
			const duration = asset.durationSec ?? 30;
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
			const duration = asset.durationSec ?? 30;
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

	const splitAndInsert = useCallback(
		async (assetId: string, splitTimeSec: number) => {
			if (!document) return;
			const asset = document.assets.find((a) => a.id === assetId);
			if (!asset) return;
			const duration = asset.durationSec ?? 30;
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
		hasDoc,
		selection,
		addZoom,
		addSkip,
		addAnnotation,
		addSpeed,
		removeRegion,
		selectRegion,
		clearSelection,
		addClipBefore,
		addClipAfter,
		splitAndInsert,
	};
}
