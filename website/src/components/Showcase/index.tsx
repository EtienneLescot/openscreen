/**
 * What the app is besides the editor: the recorder in front of it, the encoder
 * behind it, and the two features that are easier to show than to describe.
 *
 * Two treatments, and which one a claim gets is the editorial decision recorded
 * in `content.ts`. Nothing here plays: the page has one moving thing on it and
 * it is the editor above, which is the point of having built it.
 */

import Heading from "@theme/Heading";

import { SHOWN, TOLD } from "./content";
import styles from "./styles.module.css";

export default function Showcase() {
	return (
		<section className={styles.section} aria-labelledby="showcase-title">
			<div className={styles.inner}>
				<p className={styles.kicker}>also in the box</p>
				<Heading as="h2" id="showcase-title" className={styles.title}>
					Recorder, captions, agent, encoder.
				</Heading>

				{/* The two sentences first: they are the pipeline the editor sits in
				    the middle of, and they read in seconds. */}
				<div className={styles.told}>
					{TOLD.map((item) => (
						<article key={item.id} id={item.id} className={styles.toldCard}>
							<p className={styles.itemKicker}>{item.kicker}</p>
							<h3 className={styles.claim}>{item.claim}</h3>
							<p className={styles.body}>{item.body}</p>
							<p className={styles.fact}>{item.fact}</p>
						</article>
					))}
				</div>

				{SHOWN.map((item) => (
					<article
						key={item.id}
						id={item.id}
						className={`${styles.band} ${item.flip ? styles.flip : ""}`}
					>
						<div className={styles.copy}>
							<p className={styles.itemKicker}>{item.kicker}</p>
							<h3 className={styles.claim}>{item.claim}</h3>
							<p className={styles.body}>{item.body}</p>
							<p className={styles.fact}>{item.fact}</p>
						</div>
						<figure className={styles.figure}>
							<div
								className={styles.frame}
								style={{ aspectRatio: `${item.media.width} / ${item.media.height}` }}
							>
								<picture>
									<source media="(max-width: 780px)" srcSet={item.media.imageSm} />
									<img
										className={styles.still}
										src={item.media.image}
										width={item.media.width}
										height={item.media.height}
										loading="lazy"
										decoding="async"
										alt={item.media.alt}
									/>
								</picture>
							</div>
							<figcaption className={styles.caption}>A frame of the running application</figcaption>
						</figure>
					</article>
				))}
			</div>
		</section>
	);
}
