/**
 * The page's centre of gravity: nine viewports of editor, and nothing above it.
 *
 * It sits immediately under the hero because it is the argument. Everything
 * after it is either a claim the editor cannot make on its own (the recorder,
 * the encoder, captions, the agent) or a property rather than a capability
 * (the licence, the privacy, the platforms).
 *
 * No visible heading, as the design has it. The five beats caption themselves —
 * "STYLE / Swap the background", and four more — so a heading above them was a
 * lid on a box that labels itself, and the deck under it was the page
 * explaining itself to the reader instead of showing them.
 *
 * Two things survive that removal, both invisible:
 *
 *   The h2, now screen-reader-only. Without it the outline runs h1 straight to
 *   the five h3 captions, which is a skipped level, and the section's
 *   aria-labelledby has nothing to point at.
 *
 *   The skip link, visible on focus. The band is nine viewports tall; tabbing
 *   through it to reach the download link is a long way for someone who has
 *   already decided.
 */

import Heading from "@theme/Heading";

import Recreation from "../Recreation";
import styles from "./styles.module.css";

export default function Editor() {
	return (
		<section className={styles.section} aria-labelledby="editor-title">
			<div className={styles.head}>
				<a className={styles.skip} href="#download-install">
					Skip the editor — go to downloads
				</a>

				<Heading as="h2" id="editor-title" className={styles.title}>
					Five things you will actually do
				</Heading>
			</div>

			<Recreation />
		</section>
	);
}
