// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

	it("retains slider value on release while async commit is in flight without jumping back", async () => {
		let resolveGain: () => void = () => undefined;
		let resolveFadeIn: () => void = () => undefined;
		let resolveFadeOut: () => void = () => undefined;

		const setAudioTrackGain = vi.fn().mockImplementation(
			() =>
				new Promise<void>((res) => {
					resolveGain = res;
				}),
		);
		const updateAudioTrack = vi.fn().mockImplementation(
			(_id: string, patch: { fadeInMs?: number; fadeOutMs?: number }) =>
				new Promise<void>((res) => {
					if (patch.fadeInMs !== undefined) resolveFadeIn = res;
					if (patch.fadeOutMs !== undefined) resolveFadeOut = res;
				}),
		);

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
			muted: false,
			loop: false,
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
			setAudioTrackGain,
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

		// 1. Gain slider: drag to 2.5 and release (onMouseUp)
		fireEvent.change(gainSlider, { target: { value: "2.5" } });
		fireEvent.mouseUp(gainSlider);

		expect(setAudioTrackGain).toHaveBeenCalledWith("audio_track_1", 2.5);
		// While save is in flight, the slider MUST NOT jump back to -6
		expect(gainSlider).toHaveValue("2.5");

		// Complete the async save and simulate the store update
		await act(async () => {
			resolveGain();
		});

		rerender(
			<I18nProvider>
				<AudioTrackPane
					tl={
						{
							...tl,
							audioTracks: [{ ...mockTrack, gainDb: 2.5 }],
						} as unknown as TimelineApi
					}
				/>
			</I18nProvider>,
		);
		expect(gainSlider).toHaveValue("2.5");

		// 2. Fade in slider: drag to 1500 and release
		fireEvent.change(fadeInSlider, { target: { value: "1500" } });
		fireEvent.mouseUp(fadeInSlider);

		expect(updateAudioTrack).toHaveBeenCalledWith("audio_track_1", { fadeInMs: 1500 });
		// While save is in flight, the slider MUST NOT jump back to 500
		expect(fadeInSlider).toHaveValue("1500");

		await act(async () => {
			resolveFadeIn();
		});

		rerender(
			<I18nProvider>
				<AudioTrackPane
					tl={
						{
							...tl,
							audioTracks: [{ ...mockTrack, gainDb: 2.5, fadeInMs: 1500 }],
						} as unknown as TimelineApi
					}
				/>
			</I18nProvider>,
		);
		expect(fadeInSlider).toHaveValue("1500");

		// 3. Fade out slider: drag to 2500 and release
		fireEvent.change(fadeOutSlider, { target: { value: "2500" } });
		fireEvent.mouseUp(fadeOutSlider);

		expect(updateAudioTrack).toHaveBeenCalledWith("audio_track_1", { fadeOutMs: 2500 });
		// While save is in flight, the slider MUST NOT jump back to 1000
		expect(fadeOutSlider).toHaveValue("2500");

		await act(async () => {
			resolveFadeOut();
		});

		rerender(
			<I18nProvider>
				<AudioTrackPane
					tl={
						{
							...tl,
							audioTracks: [{ ...mockTrack, gainDb: 2.5, fadeInMs: 1500, fadeOutMs: 2500 }],
						} as unknown as TimelineApi
					}
				/>
			</I18nProvider>,
		);
		expect(fadeOutSlider).toHaveValue("2500");
	});
});
