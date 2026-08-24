// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFloatingSelfView } from "./useFloatingSelfView";

type FakeTrack = {
	readyState: MediaStreamTrackState;
	getSettings: () => MediaTrackSettings;
};

function makeStream(
	track: FakeTrack = {
		readyState: "live",
		getSettings: () => ({ deviceId: "camera-1" }),
	},
): MediaStream {
	return {
		getVideoTracks: () => [track as MediaStreamTrack],
	} as MediaStream;
}

function Harness({
	recording,
	stream,
	autoShowEnabled = true,
	webcamEnabled = true,
	isMac = true,
	onUnavailable = vi.fn(),
}: {
	recording: boolean;
	stream: MediaStream | null;
	autoShowEnabled?: boolean;
	webcamEnabled?: boolean;
	isMac?: boolean;
	onUnavailable?: () => void;
}) {
	const selfView = useFloatingSelfView({
		recording,
		stream,
		autoShowEnabled,
		webcamEnabled,
		isMac,
		onUnavailable,
	});
	return (
		<>
			<button type="button" onClick={() => void selfView.toggle()}>
				toggle
			</button>
			<output data-testid="state">
				{String(selfView.supported)}:{String(selfView.ready)}:{String(selfView.open)}
			</output>
		</>
	);
}

describe("useFloatingSelfView", () => {
	beforeEach(() => {
		window.electronAPI = {
			showFloatingSelfView: vi.fn(async () => ({ success: true })),
			hideFloatingSelfView: vi.fn(async () => ({ success: true })),
			getFloatingSelfViewState: vi.fn(async () => ({ open: false })),
			onFloatingSelfViewStateChanged: vi.fn(() => () => undefined),
		} as unknown as Window["electronAPI"];
	});

	afterEach(() => {
		cleanup();
	});

	it("auto-opens once when a new recording becomes active", async () => {
		const stream = makeStream();
		const view = render(<Harness recording={false} stream={stream} />);

		view.rerender(<Harness recording stream={stream} />);

		await waitFor(() => expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalledTimes(1));
		expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalledWith("camera-1");
		expect(screen.getByTestId("state").textContent).toBe("true:true:true");
	});

	it("opens again after recording restart, but never twice within one take", async () => {
		const stream = makeStream();
		const view = render(<Harness recording={false} stream={stream} />);

		view.rerender(<Harness recording stream={stream} />);
		await waitFor(() => expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalledTimes(1));
		view.rerender(<Harness recording stream={stream} />);
		expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalledTimes(1);

		view.rerender(<Harness recording={false} stream={stream} />);
		view.rerender(<Harness recording stream={stream} />);
		await waitFor(() => expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalledTimes(2));
	});

	it("keeps manual show available when auto-show is disabled", async () => {
		const stream = makeStream();
		render(<Harness recording stream={stream} autoShowEnabled={false} />);

		fireEvent.click(screen.getByRole("button", { name: "toggle" }));

		await waitFor(() => expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalledTimes(1));
	});

	it("allows manual close and reopen without stopping the recorder's camera track", async () => {
		const track = {
			readyState: "live" as const,
			getSettings: () => ({ deviceId: "camera-1" }),
		};
		const stream = makeStream(track);
		render(<Harness recording stream={stream} autoShowEnabled={false} />);

		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(window.electronAPI.hideFloatingSelfView).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalledTimes(2));
		expect(track.readyState).toBe("live");
	});

	it("closes after recording stops or the recorder camera track is lost", async () => {
		const track: FakeTrack = {
			readyState: "live",
			getSettings: () => ({ deviceId: "camera-1" }),
		};
		const stream = makeStream(track);
		const view = render(<Harness recording stream={stream} autoShowEnabled={false} />);
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalled());

		view.rerender(<Harness recording={false} stream={stream} autoShowEnabled={false} />);
		await waitFor(() => expect(window.electronAPI.hideFloatingSelfView).toHaveBeenCalled());
		const hidesAfterStop = vi.mocked(window.electronAPI.hideFloatingSelfView).mock.calls.length;

		view.rerender(<Harness recording stream={stream} autoShowEnabled={false} />);
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalledTimes(2));
		track.readyState = "ended";
		view.rerender(<Harness recording stream={null} autoShowEnabled={false} />);
		await waitFor(() =>
			expect(window.electronAPI.hideFloatingSelfView).toHaveBeenCalledTimes(hidesAfterStop + 1),
		);
	});

	it("closes the fallback when the HUD is destroyed", async () => {
		const stream = makeStream();
		const view = render(<Harness recording stream={stream} autoShowEnabled={false} />);
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(window.electronAPI.showFloatingSelfView).toHaveBeenCalledTimes(1));

		view.unmount();

		await waitFor(() => expect(window.electronAPI.hideFloatingSelfView).toHaveBeenCalled());
	});

	it("contains unsupported and rejected requests without changing recording state", async () => {
		const onUnavailable = vi.fn();
		const stream = makeStream();
		const view = render(
			<Harness
				recording
				stream={stream}
				autoShowEnabled={false}
				isMac={false}
				onUnavailable={onUnavailable}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));

		vi.mocked(window.electronAPI.showFloatingSelfView).mockResolvedValueOnce({
			success: false,
			error: "camera-unavailable",
		});
		view.rerender(
			<Harness
				recording
				stream={stream}
				autoShowEnabled={false}
				isMac
				onUnavailable={onUnavailable}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(2));
		expect(screen.getByTestId("state").textContent).toBe("true:true:false");
	});
});
