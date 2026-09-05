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

		const { rerender } = render(
			<I18nProvider>
				<AudioTrackPane tl={tl} />
			</I18nProvider>,
		);

		const gainSlider = screen.getByRole("slider", { name: "Output level" });
		const fadeInSlider = screen.getByRole("slider", { name: "Fade in" });
		const fadeOutSlider = screen.getByRole("slider", { name: "Fade out" });

		// Draft in-progress slider changes without committing
		fireEvent.change(gainSlider, { target: { value: "3" } });
		fireEvent.change(fadeInSlider, { target: { value: "1500" } });
		fireEvent.change(fadeOutSlider, { target: { value: "2000" } });

		expect(gainSlider).toHaveValue("3");
		expect(fadeInSlider).toHaveValue("1500");
		expect(fadeOutSlider).toHaveValue("2000");

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

		// Draft values are cleared; inputs no longer display the drafted values
		expect(gainSlider).not.toHaveValue("3");
		expect(fadeInSlider).not.toHaveValue("1500");
		expect(fadeOutSlider).not.toHaveValue("2000");

		// When re-rendered with the reset track state, sliders show zeroed defaults
		const resetTrack: AxcutAudioTrack = {
			...mockTrack,
			gainDb: 0,
			fadeInMs: 0,
			fadeOutMs: 0,
			muted: false,
			loop: false,
		};
		rerender(
			<I18nProvider>
				<AudioTrackPane tl={{ ...tl, audioTracks: [resetTrack] } as unknown as TimelineApi} />
			</I18nProvider>,
		);

		expect(gainSlider).toHaveValue("0");
		expect(fadeInSlider).toHaveValue("0");
		expect(fadeOutSlider).toHaveValue("0");
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

		const { rerender } = render(
			<I18nProvider>
				<AudioTrackPane tl={tl} />
			</I18nProvider>,
		);

		const gainSlider = screen.getByRole("slider", { name: /niveau de sortie/i });
		const fadeInSlider = screen.getByRole("slider", { name: /fondu d['’]entrée/i });
		const fadeOutSlider = screen.getByRole("slider", { name: /fondu de sortie/i });

		fireEvent.change(gainSlider, { target: { value: "-12" } });
		fireEvent.change(fadeInSlider, { target: { value: "800" } });
		fireEvent.change(fadeOutSlider, { target: { value: "1200" } });

		expect(gainSlider).toHaveValue("-12");
		expect(fadeInSlider).toHaveValue("800");
		expect(fadeOutSlider).toHaveValue("1200");

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

		expect(gainSlider).not.toHaveValue("-12");
		expect(fadeInSlider).not.toHaveValue("800");
		expect(fadeOutSlider).not.toHaveValue("1200");

		const resetTrack: AxcutAudioTrack = {
			...mockTrack,
			gainDb: 0,
			fadeInMs: 0,
			fadeOutMs: 0,
			muted: false,
			loop: false,
		};
		rerender(
			<I18nProvider>
				<AudioTrackPane tl={{ ...tl, audioTracks: [resetTrack] } as unknown as TimelineApi} />
			</I18nProvider>,
		);

		expect(gainSlider).toHaveValue("0");
		expect(fadeInSlider).toHaveValue("0");
		expect(fadeOutSlider).toHaveValue("0");
	});
});
