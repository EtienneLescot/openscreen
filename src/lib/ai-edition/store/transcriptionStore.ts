// Single source of truth for "where is each asset's transcript?".
//
// Transcription is local (whisper.cpp, no network), so there is no reason to
// make the user go and ask for it: every asset that lands in the document —
// imported from the Media tab, or auto-added from a screen recording — is
// queued here and transcribed in the background. The transcript itself still
// lives on the document (`document.transcripts[]`); this store only owns the
// JOB: queued / running / failed, plus the phase for the spinner. Nothing
// derives "is there a transcript?" from here — that answer comes from the
// document, and the two are folded together by `deriveAssetStatus`.
//
// Loop safety, which is the whole difficulty of an auto pass whose result
// mutates the document it reacts to:
//
//   - `sync` only ever enqueues an asset that has NO transcript, NO job entry
//     (queued / running / failed alike) and NO persisted failure. A finished
//     run leaves a transcript on the document, a failed one leaves a `failed`
//     entry here, so neither can be picked up twice.
//   - the job entry is deleted only AFTER the save has resolved, i.e. after
//     the document already carries the transcript.
//   - the pump is a single sequential loop (whisper-server is one process and
//     audio extraction is memory-hungry), guarded by a module-level promise,
//     and it drops any job a run left behind rather than spinning on it.

import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { toastText as translateToast } from "@/i18n/toastText";
import { transcribeAsset, withTranscript } from "../document/transcribe";
import type { AxcutDocument } from "../schema";
import {
	type AssetTranscriptionView,
	classifyTranscriptionError,
	deriveAssetStatus,
	findAssetTranscript,
	isAbortError,
	isPermanentFailure,
	resolveTranscriptGate,
	type TranscriptGate,
	type TranscriptionFailure,
	type TranscriptionPhase,
	type TranscriptionProgress,
	transcriptRelevantAssetIds,
} from "../transcription/status";
import { useProjectStore } from "./projectStore";

export interface TranscriptionJob {
	status: "queued" | "running" | "failed";
	/** Set when a run picks the job up. Identifies THIS attempt, so a run that
	 *  finishes after the user asked for another one cannot clear its successor. */
	runId?: number;
	phase?: TranscriptionPhase;
	/** Chunk progress while transcribing; absent until the first chunk lands. */
	progress?: TranscriptionProgress;
	/**
	 * Which device the engine bound, and how fast it is going. Both arrive with
	 * the first landed chunk and are refreshed by every chunk after it; both stay
	 * absent against a helper binary too old to report timing at all.
	 */
	backend?: string;
	rtf?: number;
	/** `"auto"` unless the user forced a language from the media card. */
	language: string;
	failure?: TranscriptionFailure;
	/** User-triggered runs get a toast on success; the background pass stays quiet. */
	manual: boolean;
}

interface TranscriptionState {
	/** Project the jobs belong to — switching projects drops them all. */
	projectId: string | null;
	jobs: Record<string, TranscriptionJob>;

	/** Reconcile the queue with a document. Idempotent; safe to call on every document change. */
	sync: (document: AxcutDocument | null) => void;
	/** Transcribe (or re-transcribe) one asset now. Resolves once the run settles. */
	request: (assetId: string, language?: string) => Promise<void>;
	/**
	 * What the panes' "Transcribe now" button asks for: every asset the timeline
	 * plays that still has no transcript. NOT just the primary asset — a project
	 * whose first (primary) media is a silent screen capture would otherwise
	 * leave that button unable to transcribe the talking clip next to it.
	 */
	requestTimelineTranscripts: () => Promise<void>;
	reset: () => void;
}

/** The local engine is only reachable through the preload bridge. */
function hasLocalSttEngine(): boolean {
	if (typeof window === "undefined") return false;
	return typeof window.electronAPI?.stt?.transcribe === "function";
}

/** This store's toasts all live in the `editor` namespace. */
const toastText = (key: string, vars?: Record<string, string | number>) =>
	translateToast("editor", key, vars);

export const useTranscriptionStore = create<TranscriptionState>((set, get) => ({
	projectId: null,
	jobs: {},

	sync(document) {
		if (!document) {
			if (get().projectId !== null || Object.keys(get().jobs).length > 0) get().reset();
			return;
		}
		if (document.project.id !== get().projectId) {
			get().reset();
			set({ projectId: document.project.id });
		}

		const assetIds = new Set(document.assets.map((a) => a.id));
		const jobs = get().jobs;
		let next: Record<string, TranscriptionJob> | null = null;
		const patch = () => {
			if (!next) next = { ...jobs };
			return next;
		};

		// An asset the user removed takes its job with it (the run itself is
		// dropped by `runJob`, which re-reads the document before starting).
		for (const assetId of Object.keys(jobs)) {
			if (!assetIds.has(assetId)) delete patch()[assetId];
		}

		if (hasLocalSttEngine()) {
			for (const asset of document.assets) {
				if (jobs[asset.id]) continue;
				if (findAssetTranscript(document, asset.id)) continue;
				if (asset.transcriptionFailure) continue;
				patch()[asset.id] = { status: "queued", language: "auto", manual: false };
			}
		}

		if (next) {
			set({ jobs: next });
			void pump();
		}
	},

	request(assetId, language = "auto") {
		// A manual run can be the first thing that happens in a project (the
		// auto pass is off without a local engine), so adopt the loaded project
		// before queueing — `runJob` refuses to write into a document the queue
		// doesn't belong to.
		const document = useProjectStore.getState().document;
		if (document && document.project.id !== get().projectId) get().sync(document);
		// Asking again for an asset that is mid-run (regenerate in another
		// language while the background pass is on it) supersedes that run
		// instead of queueing behind it and losing the language.
		if (activeRun?.assetId === assetId) abortActiveRun();
		const settled = waitForSettle(assetId);
		set((state) => ({
			jobs: { ...state.jobs, [assetId]: { status: "queued", language, manual: true } },
		}));
		void pump();
		return settled;
	},

	requestTimelineTranscripts() {
		const document = useProjectStore.getState().document;
		if (!document) return Promise.resolve();
		get().sync(document);
		const targets = transcriptRelevantAssetIds(document).filter((assetId) => {
			if (findAssetTranscript(document, assetId)) return false;
			// A media with no audio track can only fail again — asking for it here
			// would buy the user a run and an error toast for nothing. The per-asset
			// regenerate in the media stage stays available for the stubborn case.
			return !document.assets.find((a) => a.id === assetId)?.transcriptionFailure;
		});
		if (targets.length === 0) return Promise.resolve();
		return Promise.all(
			targets.map((assetId) => {
				// Already queued or running: the background pass owns that run, so
				// wait for it instead of superseding it with an identical one.
				const job = get().jobs[assetId];
				if (job && job.status !== "failed") return waitForSettle(assetId);
				return get().request(assetId);
			}),
		).then(() => undefined);
	},

	reset() {
		abortActiveRun();
		const pending = Object.keys(get().jobs);
		set({ projectId: null, jobs: {} });
		for (const assetId of pending) flushSettleWaiters(assetId);
	},
}));

// ─── The pump ──────────────────────────────────────────────────────
// Module state, not store state: none of it is rendered, and keeping it out of
// the store means a re-render can never observe a half-started run.

let pumping: Promise<void> | null = null;
let activeRun: { assetId: string; controller: AbortController } | null = null;
const settleWaiters = new Map<string, Array<() => void>>();

function waitForSettle(assetId: string): Promise<void> {
	return new Promise((resolve) => {
		const waiters = settleWaiters.get(assetId);
		if (waiters) waiters.push(resolve);
		else settleWaiters.set(assetId, [resolve]);
	});
}

function flushSettleWaiters(assetId: string): void {
	const waiters = settleWaiters.get(assetId);
	if (!waiters) return;
	settleWaiters.delete(assetId);
	for (const resolve of waiters) resolve();
}

function abortActiveRun(): void {
	activeRun?.controller.abort();
	activeRun = null;
}

/**
 * Hand a queued job to a run: stamps it with the run's id, which every later
 * write checks. A `request` made mid-run replaces the entry with a fresh
 * (unstamped) one, and that stamp is what stops the outgoing run from
 * reporting its own status — or its deletion — over its successor.
 */
function claimJob(projectId: string, assetId: string, runId: number): boolean {
	let claimed = false;
	useTranscriptionStore.setState((state) => {
		if (state.projectId !== projectId) return state;
		const job = state.jobs[assetId];
		if (!job || job.status !== "queued") return state;
		claimed = true;
		return {
			jobs: {
				...state.jobs,
				[assetId]: {
					...job,
					runId,
					status: "running",
					phase: "extracting-audio",
					failure: undefined,
				},
			},
		};
	});
	return claimed;
}

/** Patch the job a run owns. No-op once that run has been superseded. */
function patchJob(assetId: string, runId: number, patch: Partial<TranscriptionJob>): void {
	useTranscriptionStore.setState((state) => {
		const job = state.jobs[assetId];
		if (!job || job.runId !== runId) return state;
		return { jobs: { ...state.jobs, [assetId]: { ...job, ...patch } } };
	});
}

/**
 * Give every still-queued job the verdict that just came back from the engine.
 * Waiters are flushed so a `requestTimelineTranscripts()` awaiting the batch
 * settles instead of hanging on runs that will never happen.
 */
function failRemainingQueue(projectId: string, failure: TranscriptionFailure): void {
	const queued = Object.entries(useTranscriptionStore.getState().jobs)
		.filter(([, job]) => job.status === "queued")
		.map(([assetId]) => assetId);
	if (queued.length === 0) return;
	useTranscriptionStore.setState((state) => {
		if (state.projectId !== projectId) return state;
		const jobs = { ...state.jobs };
		for (const assetId of queued) {
			const job = jobs[assetId];
			if (job?.status !== "queued") continue;
			jobs[assetId] = { ...job, status: "failed", phase: undefined, progress: undefined, failure };
		}
		return { jobs };
	});
	for (const assetId of queued) flushSettleWaiters(assetId);
}

/** True while `runId` is still the attempt the store is tracking for this asset. */
function isCurrentRun(assetId: string, runId: number): boolean {
	return useTranscriptionStore.getState().jobs[assetId]?.runId === runId;
}

/**
 * Remove a job once it has settled. With a `runId`, only the entry that run
 * owns. Waiters are flushed whenever the entry is gone: a caller superseded by
 * a newer request is waiting on that newer run, which flushes them in turn.
 */
function dropJob(assetId: string, runId?: number): void {
	useTranscriptionStore.setState((state) => {
		const job = state.jobs[assetId];
		if (!job) return state;
		if (runId !== undefined && job.runId !== runId) return state;
		const jobs = { ...state.jobs };
		delete jobs[assetId];
		return { jobs };
	});
	if (useTranscriptionStore.getState().jobs[assetId] === undefined) flushSettleWaiters(assetId);
}

/**
 * Remember a deterministic failure on the asset so the next project open shows
 * "no audio" straight away instead of re-extracting the audio to rediscover it.
 * Best-effort: a save that loses a race with a user edit is not worth a toast.
 */
async function persistPermanentFailure(
	projectId: string,
	assetId: string,
	failure: TranscriptionFailure,
): Promise<void> {
	const kind = failure.kind;
	if (!isPermanentFailure(kind)) return;
	const project = useProjectStore.getState();
	const doc = project.document;
	if (!doc || doc.project.id !== projectId) return;
	if (!doc.assets.some((a) => a.id === assetId)) return;
	// Best-effort bookkeeping: `saveDocument` reports its own failures and resolves
	// false rather than throwing, and a note on the asset is not worth a second
	// message on top of the one the user already got.
	const persisted = await project.saveDocument(
		{
			...doc,
			assets: doc.assets.map((a) =>
				a.id === assetId
					? {
							...a,
							transcriptionFailure: {
								kind,
								message: failure.message,
								at: new Date().toISOString(),
							},
						}
					: a,
			),
		},
		// Bookkeeping, not an edit — it must not become an undo step.
		{ history: false },
	);
	if (!persisted) {
		console.warn("[transcription] could not persist the failure on the asset");
	}
}

let runSeq = 0;

async function runJob(assetId: string, job: TranscriptionJob): Promise<void> {
	const projectId = useTranscriptionStore.getState().projectId;
	const doc = useProjectStore.getState().document;
	if (
		!projectId ||
		!doc ||
		doc.project.id !== projectId ||
		!doc.assets.some((a) => a.id === assetId)
	) {
		// Nothing this run could legally write to. Drop it rather than leave it
		// queued — `drain` would otherwise pick the same job forever.
		dropJob(assetId);
		return;
	}

	const runId = ++runSeq;
	if (!claimJob(projectId, assetId, runId)) return;
	const controller = new AbortController();
	activeRun = { assetId, controller };

	try {
		const transcript = await transcribeAsset(doc, assetId, {
			language: job.language,
			signal: controller.signal,
			// `TranscribeStatus` and `TranscriptionPhase` are the same vocabulary on
			// purpose (see status.ts), so this no longer needs a cast. `progress`
			// only arrives during "transcribing"; carrying it through undefined the
			// rest of the time is what lets the UI fall back to a spinner instead
			// of a bar frozen at 0%.
			onStatus: (status) =>
				patchJob(assetId, runId, {
					phase: status.phase,
					progress:
						status.completedSec !== undefined && status.totalSec !== undefined
							? { completedSec: status.completedSec, totalSec: status.totalSec }
							: undefined,
					// Omitted rather than set to undefined when absent: `patchJob` spreads
					// this object over the job, so a key that is present-but-undefined
					// would blank out what the last chunk reported. The phases before the
					// first chunk (audio extraction, the model download) carry neither.
					...(status.backend !== undefined ? { backend: status.backend } : {}),
					...(status.rtf !== undefined ? { rtf: status.rtf } : {}),
				}),
		});
		if (controller.signal.aborted) {
			dropJob(assetId, runId);
			return;
		}
		// The user may have switched projects while whisper was working — writing
		// the transcript now would attach it to the document that is loaded today.
		const current = useProjectStore.getState().document;
		if (!current || current.project.id !== projectId) {
			dropJob(assetId, runId);
			return;
		}
		// One save: the transcript, and (on a successful retry) the removal of
		// the verdict remembered on the asset.
		// `history: false`: a transcript landing from a background job is not an edit
		// the user made, and making it the target of the next Ctrl+Z would both surprise
		// them and throw the transcript away.
		await useProjectStore.getState().saveDocument(
			withTranscript(
				{
					...current,
					assets: current.assets.map((a) =>
						a.id === assetId && a.transcriptionFailure ? { ...a, transcriptionFailure: null } : a,
					),
				},
				transcript,
			),
			{ history: false },
		);
		dropJob(assetId, runId);
		if (job.manual) toast.success(toastText("mediaStage.transcriptReady"));
	} catch (error) {
		if (isAbortError(error) || controller.signal.aborted) {
			dropJob(assetId, runId);
			return;
		}
		if (!isCurrentRun(assetId, runId)) return; // superseded by a newer request
		const failure = classifyTranscriptionError(error);
		patchJob(assetId, runId, { status: "failed", phase: undefined, progress: undefined, failure });
		flushSettleWaiters(assetId);
		await persistPermanentFailure(projectId, assetId, failure);
		// A transient failure is about the ENGINE, not about this media: the model
		// download died, whisper-server didn't come up. Marching the rest of the
		// queue into the same wall would spend a full retry budget per asset and
		// stack one identical toast per asset. Fail them with the same verdict
		// instead — the gate then reads "failed" (not "queued forever"), and one
		// manual retry re-runs them all once the engine is back.
		if (failure.kind === "error") failRemainingQueue(projectId, failure);
		// A silent recording is an expected outcome, not an incident: the media
		// card and every gated button already say so. Only surface the noisy
		// (retryable) failures, plus anything the user asked for by hand.
		if (failure.kind === "error" || job.manual) {
			toast.error(toastText("mediaStage.transcriptionFailed"), { description: failure.message });
		}
	} finally {
		if (activeRun?.controller === controller) activeRun = null;
	}
}

function nextQueuedJob(): [string, TranscriptionJob] | null {
	const { jobs } = useTranscriptionStore.getState();
	for (const [assetId, job] of Object.entries(jobs)) {
		if (job.status === "queued") return [assetId, job];
	}
	return null;
}

async function drain(): Promise<void> {
	for (;;) {
		const next = nextQueuedJob();
		if (!next) return;
		const [assetId, job] = next;
		await runJob(assetId, job);
		// Belt and braces: a run that neither settled nor failed its job would
		// make this loop spin. Drop it and move on.
		if (useTranscriptionStore.getState().jobs[assetId] === job) {
			console.warn("[transcription] job left queued after a run, dropping:", assetId);
			dropJob(assetId);
		}
	}
}

function pump(): Promise<void> {
	if (pumping) return pumping;
	pumping = drain().finally(() => {
		pumping = null;
	});
	return pumping;
}

/** Test/diagnostic helper: resolves once the queue has drained. */
export function whenTranscriptionIdle(): Promise<void> {
	return pumping ?? Promise.resolve();
}

// ─── React bindings ────────────────────────────────────────────────

/**
 * Mount once (the editor shell does). Keeps the queue reconciled with whatever
 * document is loaded — a new project, an imported asset, a removed one.
 */
export function useAutoTranscription(): void {
	const document = useProjectStore((s) => s.document);
	const sync = useTranscriptionStore((s) => s.sync);
	useEffect(() => {
		sync(document);
	}, [document, sync]);
}

/**
 * Per-asset transcription state, keyed by asset id — one subscription for a
 * whole media list instead of a hook per row (which a `.map()` can't have).
 *
 * There is deliberately no single-asset variant: every consumer either lists
 * media (this) or asks about a transcript-dependent action, and the answer for
 * an action is `useTimelineTranscriptGate` — resolved over the assets the
 * timeline plays, never over one asset picked as representative.
 */
export function useAssetTranscriptions(): Record<string, AssetTranscriptionView> {
	const document = useProjectStore((s) => s.document);
	const jobs = useTranscriptionStore((s) => s.jobs);
	return useMemo(() => {
		const views: Record<string, AssetTranscriptionView> = {};
		for (const asset of document?.assets ?? []) {
			views[asset.id] = deriveAssetStatus({
				assetId: asset.id,
				job: jobs[asset.id],
				transcript: findAssetTranscript(document, asset.id),
				persistedFailure: asset.transcriptionFailure,
			});
		}
		return views;
	}, [document, jobs]);
}

/**
 * Gate for the transcript-dependent timeline actions (Smart cuts): resolved
 * over the assets the timeline actually plays.
 */
export function useTimelineTranscriptGate(): TranscriptGate {
	const document = useProjectStore((s) => s.document);
	const jobs = useTranscriptionStore((s) => s.jobs);
	return useMemo(() => {
		const views = transcriptRelevantAssetIds(document).map((assetId) =>
			deriveAssetStatus({
				assetId,
				job: jobs[assetId],
				transcript: findAssetTranscript(document, assetId),
				persistedFailure:
					document?.assets.find((a) => a.id === assetId)?.transcriptionFailure ?? null,
			}),
		);
		return resolveTranscriptGate(views);
	}, [document, jobs]);
}
