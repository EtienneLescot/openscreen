// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import type { AxcutAudioTrack } from "@/lib/ai-edition/schema";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { AudioTrackPane } from "./RightPanes";

type TimelineApi = ReturnType<typeof useTimeline>;

describe("AudioTrackPane reset button", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		localStorage.clear();
	});

	it("resets all track parameters (gain, fades, mute, loop) on reset click", () => {
		const updateAudioTrack = vi.fn();
		const mockTrack: AxcutAudioTrack = {
			id: "audio_track_1",
			clipId: "clip_1",
			assetId: "asset_audio_1",
			trackId: "audio_track_1",
			startMs: 1000,
			endMs: 5000,
			durationSec: 10,
			offsetMs: 0,
			gainDb: -6,
			fadeInMs: 500,
			fadeOutMs: 1000,
			muted: true,
			loop: true,
			kind: "music",
			label: "test-audio.mp3",
			origin: "user",
		};

		const tl = {
			selectedAudioTrackId: "audio_track_1",
			audioTracks: [mockTrack],
			assets: [
				{
					id: "asset_audio_1",
					kind: "audio",
					label: "test-audio.mp3",
					originalPath: "/path/test-audio.mp3",
					durationSec: 10,
				},
			],
			updateAudioTrack,
		} as unknown as TimelineApi;

		render(
			<I18nProvider>
				<AudioTrackPane tl={tl} />
			</I18nProvider>,
		);

		const resetBtn = screen.getByRole("button", { name: /reset/i });
		fireEvent.click(resetBtn);

		expect(updateAudioTrack).toHaveBeenCalledTimes(1);
		expect(updateAudioTrack).toHaveBeenCalledWith("audio_track_1", {
			gainDb: 0,
			fadeInMs: 0,
			fadeOutMs: 0,
			muted: false,
			loop: false,
		});
	});

	it("resets all track parameters under French locale", () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
		const updateAudioTrack = vi.fn();
		const mockTrack: AxcutAudioTrack = {
			id: "audio_track_1",
			clipId: "clip_1",
			assetId: "asset_audio_1",
			trackId: "audio_track_1",
			startMs: 1000,
			endMs: 5000,
			durationSec: 10,
			offsetMs: 0,
			gainDb: -0.5,
			fadeInMs: 300,
			fadeOutMs: 400,
			muted: true,
			loop: false,
			kind: "music",
			label: "openscreen-test-voix.mp3",
			origin: "user",
		};

		const tl = {
			selectedAudioTrackId: "audio_track_1",
			audioTracks: [mockTrack],
			assets: [
				{
					id: "asset_audio_1",
					kind: "audio",
					label: "openscreen-test-voix.mp3",
					originalPath: "/path/openscreen-test-voix.mp3",
					durationSec: 10,
				},
			],
			updateAudioTrack,
		} as unknown as TimelineApi;

		render(
			<I18nProvider>
				<AudioTrackPane tl={tl} />
			</I18nProvider>,
		);

		// French label: "Réinitialiser l’audio"
		const resetBtn = screen.getByRole("button", { name: /réinitialiser l’audio/i });
		fireEvent.click(resetBtn);

		expect(updateAudioTrack).toHaveBeenCalledTimes(1);
		expect(updateAudioTrack).toHaveBeenCalledWith("audio_track_1", {
			gainDb: 0,
			fadeInMs: 0,
			fadeOutMs: 0,
			muted: false,
			loop: false,
		});
	});
});
