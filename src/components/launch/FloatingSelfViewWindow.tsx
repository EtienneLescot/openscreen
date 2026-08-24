import { X } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import { useScopedT } from "@/contexts/I18nContext";

function stopTracks(stream: MediaStream | null) {
	for (const track of stream?.getTracks() ?? []) track.stop();
}

/** Renderer for the hidden-before-capture BrowserWindow self-view fallback. */
export function FloatingSelfViewWindow() {
	const t = useScopedT("launch");
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const requestGeneration = useRef(0);

	const stop = useCallback(() => {
		requestGeneration.current += 1;
		const video = videoRef.current;
		if (video) video.srcObject = null;
		stopTracks(streamRef.current);
		streamRef.current = null;
	}, []);

	const start = useCallback(
		async (deviceId?: string) => {
			stop();
			const generation = requestGeneration.current;
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: {
						...(deviceId ? { deviceId: { exact: deviceId } } : {}),
						width: { ideal: 640, max: 640 },
						height: { ideal: 360, max: 480 },
						frameRate: { ideal: 24, max: 30 },
					},
				});
				if (requestGeneration.current !== generation) {
					stopTracks(stream);
					return;
				}

				streamRef.current = stream;
				const videoTrack = stream.getVideoTracks()[0];
				if (!videoTrack) throw new Error("Camera returned no video track");
				videoTrack.addEventListener(
					"ended",
					() => {
						if (requestGeneration.current !== generation) return;
						stop();
						void window.electronAPI.reportFloatingSelfViewFailed();
					},
					{ once: true },
				);

				const video = videoRef.current;
				if (!video) throw new Error("Self-view video element is unavailable");
				video.srcObject = stream;
				await video.play();
				if (requestGeneration.current !== generation) return;
				await window.electronAPI.reportFloatingSelfViewReady();
			} catch {
				if (requestGeneration.current !== generation) return;
				stop();
				await window.electronAPI.reportFloatingSelfViewFailed().catch(() => undefined);
			}
		},
		[stop],
	);

	useEffect(() => {
		const unsubscribe = window.electronAPI.onFloatingSelfViewCommand((command) => {
			if (command.visible) void start(command.deviceId);
			else stop();
		});
		return () => {
			unsubscribe();
			stop();
		};
	}, [start, stop]);

	return (
		<main
			className="group relative h-screen w-screen overflow-hidden bg-[#050608]"
			style={{ WebkitAppRegion: "drag" } as CSSProperties}
		>
			<video
				ref={videoRef}
				autoPlay
				muted
				playsInline
				aria-label={t("selfView.show")}
				className="h-full w-full select-none object-cover"
			/>
			<button
				type="button"
				aria-label={t("selfView.hide")}
				onClick={() => void window.electronAPI.closeFloatingSelfViewWindow()}
				className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white opacity-0 shadow-sm backdrop-blur-sm transition-opacity hover:bg-black/75 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 group-hover:opacity-100"
				style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
			>
				<X aria-hidden="true" size={15} strokeWidth={2.2} />
			</button>
		</main>
	);
}
