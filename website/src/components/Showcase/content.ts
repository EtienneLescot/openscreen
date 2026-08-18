/**
 * Everything the page says after the editor has finished demonstrating itself.
 *
 * The scroll-driven editor above this section is where the product is argued:
 * six settings, shown working, on a real project file. That leaves this section
 * a narrower job — the parts of the app the editor is not — and there are four
 * of them: the recorder in front of it, the encoder behind it, and the two
 * features that are easier to show than to describe.
 *
 * All four now get a picture, which reverses the split this file used to carry.
 * The old argument was that a screenshot of a format dropdown proves nothing a
 * sentence does not and costs a request to say it. That argument was about
 * screenshots. These four panels are drawn in DOM: they cost no photograph and
 * no second request, they re-render in the page's own typeface and swap with
 * the theme, and they cannot go stale against a repaint of the application the
 * way a plate shot on one build does. The reason to withhold a picture was its
 * price; the price is gone.
 *
 * What has not changed is that the copy has to stand on its own. Every panel
 * here is a drawing, it is labelled as one, and nothing in this section asks to
 * be believed on the strength of it. The specification line under each claim is
 * still doing the work.
 */

export type Feature = {
	id: string;
	kicker: string;
	claim: string;
	body: string;
	fact: string;
	/** What the drawn panel depicts, for anyone who cannot see it. */
	label: string;
	/** Layout only — the copy stays first in the DOM either way. */
	flip?: boolean;
};

export const FEATURES: Feature[] = [
	{
		id: "record",
		kicker: "record",
		claim: "It records with the operating system, not around it.",
		body: "Pick a window or a display. macOS goes through ScreenCaptureKit and Windows through Windows Graphics Capture — the same capture path the system uses itself. The pointer is recorded as data rather than burned into the pixels, which is the only reason you could restyle it further up this page.",
		fact: "ScreenCaptureKit on macOS · Windows Graphics Capture · system audio without an extra driver",
		label:
			"A drawing of the recorder: two capture targets side by side, Display 1 selected and a window titled Terminal beside it, then the settings for the take — ScreenCaptureKit, system audio, 1920 × 1080 at 60 fps — a microphone and a system-audio toggle, and a Start recording button.",
	},
	{
		id: "export",
		kicker: "export",
		claim: "Then it writes the file.",
		body: "MP4 from 720p up to source, at 24, 30 or 60, in H.264 or H.265 — or a GIF. The encode runs on your machine and counts frames while it does. No queue, no account, no watermark, and the file is on disk when the bar fills.",
		fact: "H.264 / H.265 · 24, 30, 60 fps · no watermark",
		label:
			"A drawing of the export panel: recording-1783066227227.mp4 going out as MP4, with H.265 chosen beside H.264, 1080p, 60 fps and GIF, and a progress bar 62 per cent along reading frame 1 488 of 2 400, writing to the Movies folder.",
		flip: true,
	},
	{
		id: "captions",
		kicker: "captions",
		claim: "Transcription runs on your machine.",
		body: "whisper.cpp ships with the app, and the model downloads once on first use — after that it works with the network off. The audio never leaves the laptop, and what comes back is editable text: set the typeface, the size, the colour and the position, then burn it into the render.",
		fact: "whisper.cpp · 99 languages · offline after first run",
		label:
			"A drawing of the captions panel: the line “amber day on the validator, and it” set large over the video, and beside it captions switched on, a note that seven caption lines are derived live from the transcript, and a language row offering English, Français, a Translate button and the option to delete a translation.",
	},
	{
		id: "agent",
		kicker: "agent",
		claim: "Or say which parts to cut.",
		body: "The wizard further up this page places zooms by watching where your cursor went. The agent goes further: it reads the actual transcript and the actual timeline, so it answers with timecodes you can go and check — which spans it will cut, and how much that saves. Every edit it makes is an ordinary undoable one, and it needs a provider key you supply. Nothing runs until you connect one.",
		fact: "bring your own key · off by default · every edit is undoable",
		label:
			"A drawing of the agent's reply. Asked to cut the dead air, it answers with timecodes: 0 to 2.19 seconds of lead-in before “Hi” and 35.12 to 40.03 seconds of tail after “think.”, taking the video from 40 seconds to 33 seconds of playable footage, with the existing zooms left on the same moments — then a green line reading “applied: added 2 trims”.",
		flip: true,
	},
];
