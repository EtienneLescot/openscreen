// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: (scope: string) => (key: string) => `${scope}.${key}`,
}));

import { AudioTrackPane } from "./RightPanes";

describe("AudioTrackPane", () => {
	const createTl = () => ({
		selectedAudioTrackId: "track_1",
		audioTracks: [
			{
				id: "track_1",
				clipId: "clip_1",
				assetId: "asset_audio_1",
				startSec: 0,
				durationSec: 5,
				gainDb: 0,
				fadeInMs: 0,
				fadeOutMs: 0,
				offsetSec: 0,
			},
		],
		assets: [
			{
				id: "asset_audio_1",
				kind: "audio" as const,
				label: "voice.mp3",
				originalPath: "/path/voice.mp3",
				durationSec: 5,
			},
		],
		clearSelection: vi.fn(),
		selectAudioTrack: vi.fn(),
		setAudioTrackGain: vi.fn(),
		setAudioTrackFade: vi.fn(),
		removeAudioTrack: vi.fn(),
	});

	it("renders close button and closes audio track by default", () => {
		const tl = createTl();
		render(<AudioTrackPane tl={tl as never} />);

		const closeBtn = screen.getByRole("button", { name: "common.actions.close" });
		expect(closeBtn).toBeInTheDocument();
		const header = closeBtn.closest("header");
		expect(header).toHaveStyle({ paddingRight: "var(--sp-4)" });
		const svg = closeBtn.querySelector("svg");
		expect(svg?.classList.contains("lucide-x")).toBe(true);

		fireEvent.click(closeBtn);
		expect(tl.clearSelection).toHaveBeenCalledTimes(1);
	});

	it("calls custom onClose if provided", () => {
		const tl = createTl();
		const onClose = vi.fn();
		render(<AudioTrackPane tl={tl as never} onClose={onClose} />);

		const closeBtn = screen.getByRole("button", { name: "common.actions.close" });
		fireEvent.click(closeBtn);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(tl.selectAudioTrack).not.toHaveBeenCalled();
	});
});
