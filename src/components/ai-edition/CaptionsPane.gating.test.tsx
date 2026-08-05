// @vitest-environment jsdom
// Captions are a view of the transcript, so the pane's "Transcribe video"
// button is a retry, not a first step — the background pass has already tried.
// On a media with no audio track that retry can only fail again, so the button
// has to be dead and the pane has to say what is wrong instead of inviting a
// pointless click.

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

beforeEach(() => {
	useTranscriptionStore.getState().reset();
	useProjectStore.getState().clear();
});

afterEach(() => {
	cleanup();
});

describe("captions pane gating", () => {
	it("offers the retry while the media might still yield a transcript", () => {
		load(documentWith(ASSET));
		render(
			<I18nProvider>
				<CaptionsPane />
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Transcribe video" })).toBeEnabled();
	});

	it("shows the queued background run instead of an idle button", () => {
		load(documentWith(ASSET));
		useTranscriptionStore.setState({
			projectId: "proj_1",
			jobs: { asset_1: { status: "running", language: "auto", manual: false } },
		});
		render(
			<I18nProvider>
				<CaptionsPane />
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Transcribing…" })).toBeDisabled();
	});

	it("kills the retry on a media with no audio track and explains it", () => {
		load(
			documentWith({
				...ASSET,
				transcriptionFailure: { kind: "no-audio", message: "No audio track found in this video." },
			}),
		);
		render(
			<I18nProvider>
				<CaptionsPane />
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Transcribe video" })).toBeDisabled();
		expect(
			screen.getByText("This media has no audio track — there is nothing to transcribe."),
		).toBeInTheDocument();
	});
});
