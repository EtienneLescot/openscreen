/**
 * The establishing plate — one photograph of the real editor, unretouched.
 *
 * It is the page's LCP element, so it is preloaded and it is a JPEG: `as="video"`
 * is not implemented in any engine, which means a poster is the only thing on a
 * media-led page that can be preloaded at all.
 *
 * Density is deliberately capped at 1.5x. A 2080-wide rendition measures ~95 KB
 * and would push the 2x critical path over the 250 KB the page is held to; the
 * 1560 asset on a 3x display is a far cheaper compromise than the alternative.
 */
export const PLATE = {
	src: "/img/walkthrough/editor-1040.jpg",
	srcSet: "/img/walkthrough/editor-1040.jpg 1040w, /img/walkthrough/editor-1560.jpg 1560w",
	sizes: "(max-width: 1096px) calc(100vw - 56px), 1040px",
	width: 1040,
	height: 584,
	// Not "unretouched": the window's rounded corners were squared against its own
	// chrome colour so the wallpaper behind it does not bleed into the frame. That
	// is matting, but the caption should not claim more than the picture is.
	caption: "OpenScreen 1.9 · one frame of the running editor",
	alt: "The OpenScreen editor at the end of a session: the chat panel down the left holding the agent's reply and a green line confirming two trims were applied, the video canvas in the middle showing the page being demonstrated, a transcript panel on the right where the two silences it cut are struck through in red, and a timeline below holding those two trims and three zoom regions above one audio waveform.",
} as const;
