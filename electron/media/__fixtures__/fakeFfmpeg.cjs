// A stand-in for ffmpeg so ffmpegEncodeSession's tests stay hermetic — the real
// binary is not bundled yet, and we do not want tests that depend on a machine's
// encoders. Behaviour is driven by FAKE_FFMPEG_MODE:
//
//   ok       drain stdin, exit 0
//   fail     drain stdin, print a known message + the byte count, exit 3
//   count    drain stdin, print the byte count, exit 3 (so the count reaches the
//            test through the session's stderr tail — the only channel it exposes)
//   progress emit frame=N progress lines while draining, exit 0
//   hang     drain stdin and never exit (for cancel())
//
// It ignores the ffmpeg argv it is handed; buildFfmpegArgs is asserted separately.
const mode = process.env.FAKE_FFMPEG_MODE || "ok";

let bytes = 0;
let frames = 0;

process.stdin.on("data", (chunk) => {
	bytes += chunk.length;
	if (mode === "progress") {
		// Roughly one progress line per MiB, so a test writing a few MB sees several.
		const next = Math.floor(bytes / (1024 * 1024));
		if (next > frames) {
			frames = next;
			process.stderr.write(`frame=${frames}\nfps=60\n`);
		}
	}
});

process.stdin.on("end", () => {
	if (mode === "hang") return;
	if (mode === "fail") {
		process.stderr.write(`fake ffmpeg: deliberate failure for the test BYTES=${bytes}\n`);
		process.exit(3);
	}
	if (mode === "count") {
		process.stderr.write(`BYTES=${bytes}\n`);
		process.exit(3);
	}
	process.exit(0);
});

// `hang` must survive stdin ending: keep the loop alive until we are killed.
if (mode === "hang") {
	setInterval(() => {
		// Nothing to do — an empty timer is exactly what keeps this process
		// alive so cancel() has something real to kill.
	}, 1 << 30);
}
