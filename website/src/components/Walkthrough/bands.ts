/**
 * The walkthrough's content, in one file.
 *
 * Every claim on this page is illustrated by a frame of the real application,
 * never by a drawing of it. That is the whole point of the section: the page it
 * replaced was 54 divs imitating an interface, including a made-up timecode and
 * a grey gradient standing in for video.
 *
 * It also has to hold under `video, img { display: none }`. The clips carry no
 * sound and no narration, so they owe no captions and no transcript — they take
 * WCAG 1.2.1's "media alternative for text" exemption, and the exemption is only
 * earned as long as the prose below says everything the footage says. Read the
 * page with the media hidden before changing a word of it.
 */

export type BandMedia = {
	/** Shown before anything plays. The clip's own first frame, where there is a clip. */
	image: string;
	imageSm: string;
	/** The clip's last frame — the outcome. Shown after it plays, and instead of it
	 *  under reduced motion, so a reader who never sees motion still sees the result. */
	result?: string;
	resultSm?: string;
	clip?: string;
	clipSm?: string;
	/**
	 * The scroll-driven rendition, where one exists.
	 *
	 * A different encode of the same footage, not the same file: scrubbing seeks
	 * rather than plays, and a seek into a long GOP has to decode from the
	 * preceding keyframe, so the shipped `clip` (`-g 60`) stutters under a
	 * scrollwheel. These are all-intra — every frame its own keyframe — which
	 * makes a seek exact and cheap and costs 8.4x the bytes at 30fps. Measured on
	 * the export beat: 32 KB at -g 60, 402 KB all-intra. Dropping to 20fps takes
	 * that to 268 KB, and 20fps is more than a scroll can resolve: a beat spans
	 * roughly a viewport and a half of scrolling, so a frame lands every ~15px.
	 */
	scrub?: {
		clip: string;
		clipSm: string;
		seconds: number;
		frames: number;
	};
	/** Intrinsic size of the desktop asset. Both are needed on the <img> or the
	 *  page reflows when it lands; `aspect-ratio` alone loses Safari 14. */
	width: number;
	height: number;
	widthSm: number;
	heightSm: number;
	seconds?: number;
	alt: string;
	/** Alt text for the outcome frame, when it differs from the opening one. */
	resultAlt?: string;
};

export type Band = {
	id: string;
	index: string;
	kicker: string;
	claim: string;
	body: string;
	fact: string;
	/** plate: 640px, beside the copy. letterbox: full width, copy above — a
	 *  timeline is a horizontal instrument and cropping one to 640px destroys
	 *  the thing being claimed. statement: no media yet. */
	shape: "plate" | "letterbox" | "statement";
	/** Puts the plate on the left. Layout only — the copy stays first in the DOM. */
	flip?: boolean;
	media?: BandMedia;
};

const IMG = "/img/walkthrough";
const VID = "/video";

export const BANDS: Band[] = [
	{
		id: "band-record",
		index: "01",
		kicker: "record",
		claim: "It records with the operating system, not around it.",
		body: "Pick a window or a display. macOS goes through ScreenCaptureKit and Windows through Windows Graphics Capture — the same capture path the system uses itself. The pointer is recorded as data rather than burned into the pixels, so you can restyle it after the fact.",
		fact: "ScreenCaptureKit · Windows Graphics Capture · system audio without extra drivers",
		shape: "statement",
	},
	{
		id: "band-timeline",
		index: "02",
		kicker: "timeline",
		claim: "A zoom is a region, not a keyframe.",
		body: "Press Z and a block appears on the timeline. Drag its edges to change when it happens, pick a depth, scrub back and watch it. T trims, S changes speed, A annotates, C cuts to full camera. Nothing is baked into the pixels until you export, so every block stays a block.",
		fact: "Z zoom · T trim · S speed · A annotate · C full camera",
		shape: "letterbox",
		media: {
			image: `${IMG}/02-timeline-a.jpg`,
			imageSm: `${IMG}/02-timeline-sm-a.jpg`,
			width: 1560,
			height: 288,
			widthSm: 640,
			heightSm: 118,
			alt: "The OpenScreen timeline: a ruler in minutes and seconds, then prompts reading “Press A to add annotation”, “Press S to add speed” and “Press T to add trim” on empty lanes, then two green zoom blocks labelled 1.80x and 2.20x sharing one lane below them, then “Press C to add a Full Camera segment”, and one audio clip drawn as a waveform along the bottom.",
		},
	},
	{
		id: "band-captions",
		index: "03",
		kicker: "captions",
		claim: "Transcription runs on your machine.",
		body: "whisper.cpp ships with the app, and the model downloads once on first use — after that it works with the network off. The audio never leaves the laptop, and what comes back is editable text — set the typeface, the size, the colour, the position, then burn it into the render. Delete a word from the transcript and that span is cut from the video too.",
		fact: "whisper.cpp · offline after first run · Metal, Vulkan or CPU",
		shape: "plate",
		media: {
			image: `${IMG}/03-captions-a.jpg`,
			imageSm: `${IMG}/03-captions-sm-a.jpg`,
			width: 960,
			height: 540,
			widthSm: 640,
			heightSm: 360,
			alt: "The transcription panel, headed “Current transcription”, beside the video canvas. It names the recording and holds the spoken text of it, with the pauses marked inline as “[silence 2.2s]”, “[silence 0.3s]” and “[silence 6.2s]” — the gaps the editor can then cut.",
		},
	},
	{
		id: "band-agent",
		index: "04",
		kicker: "agent",
		claim: "Or describe the edit instead.",
		body: "The agent reads the actual transcript and the actual timeline, so it answers with timecodes you can go and check — which spans it will cut, and how much that saves. It makes the edit, then tells you exactly what it changed — or, with Project edits switched off in Settings → AI, it describes the cut and waits for your word. Every edit it makes is an ordinary undoable one, and it needs a provider key you supply. Nothing runs until you connect one.",
		fact: "bring your own key · off by default · every edit is undoable",
		shape: "plate",
		flip: true,
		media: {
			image: `${IMG}/04-agent-a.jpg`,
			imageSm: `${IMG}/04-agent-sm-a.jpg`,
			scrub: {
				clip: `${VID}/04-agent-scrub.mp4`,
				clipSm: `${VID}/04-agent-sm-scrub.mp4`,
				seconds: 2.75,
				frames: 56,
			},
			width: 960,
			height: 540,
			widthSm: 640,
			heightSm: 360,
			alt: "The agent's reply in the chat panel, quoting the transcript back with timecodes: silences longer than one second at 0.0–2.24s before “Hi” and at 33.88–40.03s after “think.”, a total cut of about 8.4 seconds taking the video from 40s to roughly 31.6s, and a green line underneath reading “applied: added 2 trims”.",
		},
	},
	{
		id: "band-export",
		index: "05",
		kicker: "export",
		claim: "Then it writes the file.",
		body: "MP4 at 720p to source, 24 or 30 or 60, H.264 or H.265 — or a GIF. The encode runs on your machine and counts frames while it does. No queue, no account, no watermark. The file is on disk when the bar fills.",
		fact: "H.264 / H.265 · 24, 30, 60 fps · no watermark",
		// A plate, not a letterbox: the export dialog is already close to 16:9,
		// and cropping it to a 3.5:1 strip cuts the format row off the top and the
		// render bar off the bottom — the two things the claim rests on.
		shape: "plate",
		media: {
			image: `${IMG}/05-export-a.jpg`,
			imageSm: `${IMG}/05-export-sm-a.jpg`,
			result: `${IMG}/05-export-b.jpg`,
			resultSm: `${IMG}/05-export-sm-b.jpg`,
			clip: `${VID}/05-export.mp4`,
			clipSm: `${VID}/05-export-sm.mp4`,
			scrub: {
				clip: `${VID}/05-export-scrub.mp4`,
				clipSm: `${VID}/05-export-sm-scrub.mp4`,
				seconds: 3.2,
				frames: 64,
			},
			width: 960,
			height: 540,
			widthSm: 640,
			heightSm: 360,
			seconds: 3.2,
			alt: "The export dialog: MP4 or GIF, a resolution row offering 720p, 1080p and Source, a frame-rate row offering 24, 30 and 60, and a codec row offering H.264 and H.265.",
			resultAlt: "The same dialog mid-render, with a progress bar part-filled and a counter reading the frame it has reached out of the total, with an estimate of the seconds left.",
		},
	},
];
