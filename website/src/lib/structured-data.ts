/**
 * Schema.org nodes for the product, shared by the two pages that are genuinely
 * about it: the landing page and /download.
 *
 * The Organization and WebSite pair lives in docusaurus.config.ts instead,
 * because it is true of every URL and is emitted from headTags. The product
 * entity deliberately is not: a SoftwareApplication repeated under every docs
 * page is what earns a manual action. Emitting it on the two pages that
 * describe the product costs nothing, because both use the same @id — search
 * engines reconcile them into one entity rather than two competing copies.
 */

import type { LatestRelease } from "./release";

const SITE_URL = "https://getopenscreen.com";

/** Minted to match the @ids in docusaurus.config.ts; keep the two in step. */
export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;
export const SOFTWARE_ID = `${SITE_URL}/#software`;

const SOFTWARE_APPLICATION_LD = {
	"@type": "SoftwareApplication",
	"@id": SOFTWARE_ID,
	name: "OpenScreen",
	applicationCategory: "MultimediaApplication",
	applicationSubCategory: "Screen Recorder",
	operatingSystem: "Windows, macOS, Linux",
	description:
		"Free, open-source screen recorder and video editor. Native capture on macOS and Windows, multi-track timeline editing, on-device Whisper captions, and MP4/GIF export — no watermarks, no subscription, no account.",
	url: SITE_URL,
	// Our own page rather than the Releases list: it is the URL we want ranking
	// for "openscreen download", and it routes to GitHub from there anyway.
	downloadUrl: `${SITE_URL}/download/`,
	installUrl: "https://github.com/getopenscreen/openscreen/releases",
	softwareHelp: `${SITE_URL}/docs/intro/`,
	// No `screenshot`. It pointed at the establishing plate the landing page used
	// to open with; that page is the scroll recreation now and the plate went with
	// it, so the URL had been resolving to a 404. Nothing shipped is an honest
	// replacement — og-image.png is a wordmark card, and the recreation is a
	// recreation rather than a frame of the running editor — so restoring the
	// property means shipping a real screenshot, not repointing this at the
	// nearest available picture.
	//
	// Deliberately no VideoObject either: the walkthrough's clips are silent
	// five-second fragments with no standalone playback page, which is not what
	// that rich result describes, and declaring a video the page never presents
	// as one is a manual-action risk.
	license: "https://github.com/getopenscreen/openscreen/blob/main/LICENSE",
	isAccessibleForFree: true,
	// `offers` at price 0 is what lets a result carry a "Free" annotation;
	// omitting it on a free app just forfeits the label.
	offers: {
		"@type": "Offer",
		price: "0",
		priceCurrency: "USD",
	},
	featureList: [
		"Native screen capture (ScreenCaptureKit, Windows Graphics Capture)",
		"Multi-track timeline editing with zoom, trim, and speed regions",
		"On-device Whisper transcription and burned-in captions",
		"Webcam picture-in-picture and cursor smoothing",
		"MP4 (H.264/H.265) and animated GIF export",
	],
	publisher: { "@id": ORGANIZATION_ID },
};

/**
 * The product entity, carrying the version and release date wherever the caller
 * has the build-time release lookup to hand. Those two properties belong to the
 * same @id as the bare node, so a page that knows the current version and one
 * that doesn't describe one entity, not a contradiction.
 */
export function softwareApplicationLd(release?: LatestRelease) {
	if (!release) return SOFTWARE_APPLICATION_LD;
	return {
		...SOFTWARE_APPLICATION_LD,
		// Tags are minted as v1.8.0; schema.org wants the version alone.
		softwareVersion: release.tag.replace(/^v/, ""),
		...(release.publishedIso ? { datePublished: release.publishedIso } : {}),
	};
}

/**
 * Serializes nodes under the document-level @context. Several nodes become an
 * @graph rather than one <script> apiece, so cross-references between them
 * resolve within a single document.
 */
export function jsonLd(...nodes: object[]): string {
	const body = nodes.length === 1 ? nodes[0] : { "@graph": nodes };
	return JSON.stringify({ "@context": "https://schema.org", ...body });
}
