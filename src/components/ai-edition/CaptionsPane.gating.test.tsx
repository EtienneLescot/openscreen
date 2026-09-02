// @vitest-environment jsdom
// Captions are a view of the transcript, and since issue #560 they are reached from
// the transcript tab rather than owning one. So this pane no longer STARTS a
// transcription — the transcript tab's empty state carries the single gate. Two
// buttons for one background pass is what made people believe captions were
// transcribed separately.
//
// What the pane still owes the reader is a status: whether a pass is already
// running, and why there will never be one on a media with no audio track.

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutAsset, AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useTranscriptionStore } from "@/lib/ai-edition/store/transcriptionStore";
import { CaptionsPane } from "./CaptionsPane";

vi.mock("@/native", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function documentWith(asset: AxcutAsset): AxcutDocument {
	return {
		schemaVersion: 7,
		project: {
			id: "proj_1",
			title: "Test",
			createdAt: "2026-06-25T10:00:00.000Z",
			updatedAt: "2026-06-25T10:00:00.000Z",
			primaryAssetId: asset.id,
		},
		assets: [asset],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip_1",
					assetId: asset.id,
					sourceStartSec: 0,
					sourceEndSec: 12,
					timelineStartSec: 0,
					timelineEndSec: 12,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	} as unknown as AxcutDocument;
}

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "recording.mp4",
	originalPath: "/rec.mp4",
	durationSec: 12,
	cameraTrack: null,
};

function load(document: AxcutDocument) {
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		status: "ready",
		error: null,
		dirty: false,
	});
}

function mount() {
	render(
		<I18nProvider>
			<CaptionsPane />
		</I18nProvider>,
	);
}

beforeEach(() => {
	useTranscriptionStore.getState().reset();
	useProjectStore.getState().clear();
});

afterEach(() => {
	cleanup();
});

describe("captions pane gating", () => {
	it("does not offer a second way to start a transcription", () => {
		load(documentWith(ASSET));
		mount();
		expect(screen.queryByRole("button", { name: "Transcribe video" })).toBeNull();
		expect(
			screen.getByText("Captions are read from the media transcript.", { exact: false }),
		).toBeInTheDocument();
	});

	it("reports a background run that is already going", () => {
		load(documentWith(ASSET));
		useTranscriptionStore.setState({
			projectId: "proj_1",
			jobs: { asset_1: { status: "running", language: "auto", manual: false } },
		});
		mount();
		expect(screen.getByText("Transcribing")).toBeInTheDocument();
		// Still not a control: a running pass is news, not something to press.
		expect(screen.queryByRole("button", { name: "Transcribing" })).toBeNull();
	});

	it("stays quiet when only an off-timeline asset is busy", () => {
		// The gate answers for the timeline's assets; the label must not answer for the whole
		// bin. A bin asset mid-transcription used to relabel the pane as if the film were
		// being transcribed.
		const offTimeline: AxcutAsset = {
			id: "asset_2",
			kind: "video",
			label: "bin-only.mp4",
			originalPath: "/bin.mp4",
			durationSec: 8,
			cameraTrack: null,
		};
		const document = documentWith(ASSET);
		document.assets.push(offTimeline);
		load(document);
		useTranscriptionStore.setState({
			projectId: "proj_1",
			jobs: { asset_2: { status: "running", language: "auto", manual: false } },
		});
		mount();
		expect(screen.queryByText("Transcribing")).toBeNull();
	});

	it("explains a media with no audio track, where no pass will ever help", () => {
		load(
			documentWith({
				...ASSET,
				transcriptionFailure: { kind: "no-audio", message: "No audio track found in this video." },
			}),
		);
		mount();
		expect(
			screen.getByText("This media has no audio track — there is nothing to transcribe."),
		).toBeInTheDocument();
	});
});
