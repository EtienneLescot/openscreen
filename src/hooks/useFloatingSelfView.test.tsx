// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFloatingSelfView } from "./useFloatingSelfView";

type FakeTrack = { readyState: MediaStreamTrackState };

function makeStream(track: FakeTrack = { readyState: "live" }): MediaStream {
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
			<video ref={selfView.videoRef} data-testid="video" muted playsInline />
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
	let pictureInPictureElement: Element | null;
	let requestPictureInPicture: ReturnType<typeof vi.fn>;
	let exitPictureInPicture: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		pictureInPictureElement = null;
		Object.defineProperty(document, "pictureInPictureEnabled", {
			value: true,
			configurable: true,
		});
		Object.defineProperty(document, "pictureInPictureElement", {
			get: () => pictureInPictureElement,
			configurable: true,
		});
		requestPictureInPicture = vi.fn(async function (this: HTMLVideoElement) {
			pictureInPictureElement = this;
			this.dispatchEvent(new Event("enterpictureinpicture"));
			return {};
		});
		Object.defineProperty(HTMLVideoElement.prototype, "requestPictureInPicture", {
			value: requestPictureInPicture,
			configurable: true,
		});
		Object.defineProperty(HTMLMediaElement.prototype, "play", {
			value: vi.fn(async () => undefined),
			configurable: true,
		});
		exitPictureInPicture = vi.fn(async () => {
			const previous = pictureInPictureElement;
			pictureInPictureElement = null;
			previous?.dispatchEvent(new Event("leavepictureinpicture"));
		});
		Object.defineProperty(document, "exitPictureInPicture", {
			value: exitPictureInPicture,
			configurable: true,
		});
		window.electronAPI = {
			requestFloatingSelfViewAutoOpen: vi.fn(async () => {
				return (await window.__openscreenRequestFloatingSelfView?.()) ?? { success: false };
			}),
		} as unknown as Window["electronAPI"];
	});

	function makeReady() {
		fireEvent.loadedMetadata(screen.getByTestId("video"));
	}

	it("auto-opens once when a new recording becomes active", async () => {
		const stream = makeStream();
		const view = render(<Harness recording={false} stream={stream} />);
		makeReady();

		view.rerender(<Harness recording stream={stream} />);

		await waitFor(() => expect(requestPictureInPicture).toHaveBeenCalledTimes(1));
		expect(window.electronAPI.requestFloatingSelfViewAutoOpen).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("state").textContent).toBe("true:true:true");
	});

	it("keeps manual show available when auto-show is disabled", async () => {
		const stream = makeStream();
		render(<Harness recording stream={stream} autoShowEnabled={false} />);
		makeReady();

		fireEvent.click(screen.getByRole("button", { name: "toggle" }));

		await waitFor(() => expect(requestPictureInPicture).toHaveBeenCalledTimes(1));
		expect(window.electronAPI.requestFloatingSelfViewAutoOpen).not.toHaveBeenCalled();
	});

	it("allows manual close and reopen without stopping camera tracks", async () => {
		const track = { readyState: "live" as const };
		const stream = makeStream(track);
		render(<Harness recording stream={stream} autoShowEnabled={false} />);
		makeReady();

		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(requestPictureInPicture).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(exitPictureInPicture).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(requestPictureInPicture).toHaveBeenCalledTimes(2));
		expect(track.readyState).toBe("live");
	});

	it("closes after recording stops or the camera track is lost", async () => {
		const track: FakeTrack = { readyState: "live" };
		const stream = makeStream(track);
		const view = render(<Harness recording stream={stream} autoShowEnabled={false} />);
		makeReady();
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(requestPictureInPicture).toHaveBeenCalled());

		view.rerender(<Harness recording={false} stream={stream} autoShowEnabled={false} />);
		await waitFor(() => expect(exitPictureInPicture).toHaveBeenCalledTimes(1));

		view.rerender(<Harness recording stream={stream} autoShowEnabled={false} />);
		makeReady();
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(requestPictureInPicture).toHaveBeenCalledTimes(2));
		track.readyState = "ended";
		view.rerender(<Harness recording stream={null} autoShowEnabled={false} />);
		await waitFor(() => expect(exitPictureInPicture).toHaveBeenCalledTimes(2));
	});

	it("contains unsupported and rejected requests", async () => {
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
		makeReady();
		fireEvent.click(screen.getByRole("button", { name: "toggle" }));
		await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));

		requestPictureInPicture.mockRejectedValueOnce(new Error("denied"));
		view.rerender(
			<Harness
				recording
				stream={stream}
				autoShowEnabled={false}
				isMac
				onUnavailable={onUnavailable}
			/>,
		);
		makeReady();
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "toggle" })));
		await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(2));
	});
});
