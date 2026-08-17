/**
 * The page's centre of gravity: a heading, and then six viewports of editor.
 *
 * It sits immediately under the hero because it is the argument. Everything
 * after it is either a claim the editor cannot make on its own (the recorder,
 * the encoder, captions, the agent) or a property rather than a capability
 * (the licence, the privacy, the platforms).
 *
 * The heading keeps the page's measure; the recreation does not, and is the one
 * block on this page that uses the whole viewport.
 */

import Heading from "@theme/Heading";

import Recreation from "../Recreation";
import styles from "./styles.module.css";

export default function Editor() {
	return (
		<section className={styles.section} aria-labelledby="editor-title">
			<div className={styles.head}>
				{/* The band is six viewports tall. Tabbing through it to reach the
				    download link is a long way to go for someone who has already
				    decided. */}
				<a className={styles.skip} href="#download-install">
					Skip the editor — go to downloads
				</a>

				<p className={styles.kicker}>the editor</p>
				<Heading as="h2" id="editor-title" className={styles.title}>
					Six things you will actually do.
				</Heading>
				<p className={styles.deck}>
					Scroll to drive it. Nothing below is a video: it is the editor, redrawn live in your
					browser from the design tokens the app ships and the project file of one real session.
				</p>
			</div>

			<Recreation />
		</section>
	);
}
