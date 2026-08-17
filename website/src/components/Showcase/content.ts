/**
 * Everything the page says after the editor has finished demonstrating itself.
 *
 * The scroll-driven editor above this section is where the product is argued:
 * six settings, shown working, on a real project file. That leaves this section
 * a narrower job — the parts of the app the editor is not — and the job is done
 * badly by repeating the same treatment four more times.
 *
 * So the split here is deliberate and it is editorial, not technical:
 *
 *   A photograph earns its place when the claim is about something you have to
 *   SEE to believe. Captions are type rendered over video, and the agent's reply
 *   is prose with real timecodes in it; a paragraph describing either one is
 *   asking to be taken on trust when the evidence was cheap to show.
 *
 *   Recording and exporting are settings and a progress bar. A screenshot of a
 *   format dropdown proves nothing a sentence does not, costs a request and a
 *   place in the reader's attention, and pads a page whose whole argument is
 *   that this application is quick. They are text, and the specification line
 *   under each is doing the work the screenshot would have pretended to.
 *
 * If a claim here ever needs an image to be believed, the claim is the thing to
 * fix first.
 */

const IMG = "/img/walkthrough";

export type Shown = {
	id: string;
	kicker: string;
	claim: string;
	body: string;
	fact: string;
	/** Layout only — the copy stays first in the DOM either way. */
	flip?: boolean;
	media: {
		image: string;
		imageSm: string;
		/** Both are needed on the `<img>` or the page reflows when it lands;
		 *  `aspect-ratio` alone loses Safari 14. */
		width: number;
		height: number;
		alt: string;
	};
};

export type Told = {
	id: string;
	kicker: string;
	claim: string;
	body: string;
	fact: string;
};

/** The two worth a photograph. */
export const SHOWN: Shown[] = [
	{
		id: "captions",
		kicker: "captions",
		claim: "Transcription runs on your machine.",
		body: "whisper.cpp ships with the app, and the model downloads once on first use — after that it works with the network off. The audio never leaves the laptop, and what comes back is editable text: set the typeface, the size, the colour and the position, then burn it into the render.",
		fact: "whisper.cpp · 13 languages · offline after first run",
		media: {
			image: `${IMG}/03-captions-a.jpg`,
			imageSm: `${IMG}/03-captions-sm-a.jpg`,
			width: 960,
			height: 540,
			alt: "A caption line reading “amber day on the validator, and it” rendered large over the video, with the Captions panel open beside it: captions switched on, a note that fifteen caption lines were derived live from the transcript, a language row offering the original transcript or a translation, and the type controls — typeface, bold, size, colour — that are setting how the line above is drawn.",
		},
	},
	{
		id: "agent",
		kicker: "agent",
		claim: "Or say which parts to cut.",
		body: "The wizard further up this page places zooms by watching where your cursor went. The agent goes further: it reads the actual transcript and the actual timeline, so it answers with timecodes you can go and check — which spans it will cut, and how much that saves. Every edit it makes is an ordinary undoable one, and it needs a provider key you supply. Nothing runs until you connect one.",
		fact: "bring your own key · off by default · every edit is undoable",
		flip: true,
		media: {
			image: `${IMG}/04-agent-a.jpg`,
			imageSm: `${IMG}/04-agent-sm-a.jpg`,
			width: 960,
			height: 540,
			alt: "The agent's reply in the chat panel, quoting the transcript back with timecodes: the only silences over a second were at the two ends, 0–2.19s of dead lead-in before “Hi” and 35.12–40.03s of dead tail after “think.”, both cut, taking the video about seven seconds shorter — from 40.0s to 33.0s of playable footage — with a note that the existing zooms stay anchored to the same moments, and a green line underneath reading “applied: added 2 trims”.",
		},
	},
];

/** The two that are a sentence and a specification, and nothing more. */
export const TOLD: Told[] = [
	{
		id: "record",
		kicker: "record",
		claim: "It records with the operating system, not around it.",
		body: "Pick a window or a display. macOS goes through ScreenCaptureKit and Windows through Windows Graphics Capture — the same capture path the system uses itself. The pointer is recorded as data rather than burned into the pixels, which is the only reason you could restyle it further up this page.",
		fact: "ScreenCaptureKit on macOS · Windows Graphics Capture · system audio without an extra driver",
	},
	{
		id: "export",
		kicker: "export",
		claim: "Then it writes the file.",
		body: "MP4 from 720p up to source, at 24, 30 or 60, in H.264 or H.265 — or a GIF. The encode runs on your machine and counts frames while it does. No queue, no account, no watermark, and the file is on disk when the bar fills.",
		fact: "H.264 / H.265 · 24, 30, 60 fps · no watermark",
	},
];
