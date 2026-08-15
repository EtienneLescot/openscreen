import { useEffect, useRef, useState } from "react";

import Head from "@docusaurus/Head";

import { BANDS, type Band } from "./bands";
import { PLATE } from "./plate";
import styles from "./styles.module.css";
import { type BandPlayback, useBandPlayback } from "./useBandPlayback";

/** Both global controls are server-rendered as inert spans of identical box size
 *  and upgraded after hydration, so a reader without JavaScript never meets a
 *  control that looks operable and is not. */
function useUpgradedTag(hydrated: boolean) {
	return hydrated ? "button" : "span";
}

function BandView({ band, ctl }: { band: Band; ctl: BandPlayback }) {
	const { media } = band;
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const [ready, setReady] = useState(false);
	const [playing, setPlaying] = useState(false);

	const owns = ctl.activeId === band.id && !!media?.clip;
	const played = ctl.playedIds.has(band.id);
	const refused = ctl.refusedIds.has(band.id);
	// Depending on `ctl` itself would re-run this on every render — it is a fresh
	// object each time — and call play() again on an element already playing.
	const { markRefused } = ctl;

	useEffect(() => {
		if (!owns) {
			setReady(false);
			setPlaying(false);
			return;
		}
		const el = videoRef.current;
		if (!el) return;
		const attempt = el.play();
		if (attempt) {
			// iOS in Low Power Mode refuses muted inline autoplay outright, and the
			// page cannot override it. The poster and the labelled button stay; only
			// the element goes away.
			attempt.catch(() => markRefused(band.id));
		}
	}, [owns, band.id, markRefused]);

	if (!media) {
		return (
			<article
				id={band.id}
				className={`${styles.band} ${styles.statement}`}
				ref={ctl.registerBand(band.id)}
				data-band-id={band.id}
			>
				<Copy band={band} />
			</article>
		);
	}

	// Once a clip has finished, its band keeps showing the last frame rather than
	// snapping back to the first — so scrolling back up shows outcomes, and the
	// reduced-motion reader is shown those outcomes from the start.
	const showResult = (played || ctl.quiet) && !!media.result;
	const still = showResult ? (media.result as string) : media.image;
	const stillSm = showResult ? (media.resultSm as string) : media.imageSm;
	const alt = showResult && media.resultAlt ? media.resultAlt : media.alt;

	const hasClip = !!media.clip;
	const Tag = useUpgradedTag(ctl.hydrated);
	const label = played ? `Replay the ${band.kicker} clip` : `Play the ${band.kicker} clip`;

	return (
		<article
			id={band.id}
			className={`${styles.band} ${band.shape === "letterbox" ? styles.wide : styles.split} ${
				band.flip ? styles.flip : ""
			}`}
			ref={ctl.registerBand(band.id)}
			data-band-id={band.id}
		>
			<Copy band={band} />
			<figure className={styles.figure}>
				<div
					className={styles.frame}
					style={{ aspectRatio: `${media.width} / ${media.height}` }}
				>
					<picture>
						<source media="(max-width: 780px)" srcSet={stillSm} />
						<img
							className={styles.still}
							src={still}
							width={media.width}
							height={media.height}
							loading="lazy"
							decoding="async"
							alt={alt}
						/>
					</picture>
					{owns && (
						<video
							ref={videoRef}
							className={`${styles.clip} ${ready ? styles.clipReady : ""}`}
							src={ctl.small ? media.clipSm : media.clip}
							width={media.width}
							height={media.height}
							muted
							playsInline
							preload="auto"
							aria-hidden="true"
							tabIndex={-1}
							disableRemotePlayback
							onLoadedData={() => setReady(true)}
							onPlaying={() => setPlaying(true)}
							onEnded={() => {
								setPlaying(false);
								ctl.markPlayed(band.id);
							}}
						/>
					)}
				</div>
				<figcaption className={styles.caption}>
					<span className={styles.captionText}>
						{hasClip
							? `${media.seconds?.toFixed(1)}s · one take · no sound`
							: "A frame of the running application"}
					</span>
					{hasClip && !refused && (
						<Tag
							className={styles.replay}
							{...(ctl.hydrated
								? { type: "button" as const, onClick: () => ctl.play(band.id) }
								: { "aria-hidden": true })}
						>
							{label}
						</Tag>
					)}
				</figcaption>
				{hasClip && (
					<span className={styles.rail} aria-hidden="true">
						<span
							className={`${styles.railFill} ${playing ? styles.railRunning : ""} ${
								played && !playing ? styles.railDone : ""
							}`}
							style={{ animationDuration: `${media.seconds ?? 5}s` }}
						/>
					</span>
				)}
			</figure>
		</article>
	);
}

function Copy({ band }: { band: Band }) {
	return (
		<div className={styles.copy}>
			<p className={styles.kicker}>
				<span className={styles.index}>{band.index}</span>
				{band.kicker}
			</p>
			<h3 className={styles.claim}>{band.claim}</h3>
			<p className={styles.body}>{band.body}</p>
			<p className={styles.fact}>{band.fact}</p>
		</div>
	);
}

export default function Walkthrough() {
	const ctl = useBandPlayback();
	const Tag = useUpgradedTag(ctl.hydrated);

	return (
		<>
			<Head>
				<link
					rel="preload"
					as="image"
					href={PLATE.src}
					imageSrcSet={PLATE.srcSet}
					imageSizes={PLATE.sizes}
					fetchPriority="high"
				/>
			</Head>

			<section className={styles.plateSection}>
				<figure className={styles.plate}>
					<img
						className={styles.plateImage}
						src={PLATE.src}
						srcSet={PLATE.srcSet}
						sizes={PLATE.sizes}
						width={PLATE.width}
						height={PLATE.height}
						fetchPriority="high"
						decoding="async"
						alt={PLATE.alt}
					/>
					<figcaption className={styles.plateCaption}>{PLATE.caption}</figcaption>
				</figure>
			</section>

			<section className={styles.walkthrough} aria-labelledby="walkthrough-title">
				<div className={styles.inner}>
					<a className={styles.skip} href="#download-install">
						Skip the walkthrough — go to downloads
					</a>

					<div className={styles.head}>
						<p className={styles.sectionKicker}>What it does</p>
						<h2 id="walkthrough-title" className={styles.sectionTitle}>
							Recorder first. Editor second. AI only if you ask.
						</h2>
						<p className={styles.deck}>
							No sound, no narration. Every frame below is the running application — the same build
							you can download — doing exactly what the line beside it says. Nothing here is a
							drawing of the interface.
						</p>

						<div className={styles.controls}>
							<nav className={styles.chapters} aria-label="Walkthrough sections">
								{BANDS.map((band) => (
									<a key={band.id} href={`#${band.id}`}>
										{band.kicker}
									</a>
								))}
							</nav>
							<Tag
								className={styles.toggle}
								{...(ctl.hydrated
									? {
											type: "button" as const,
											"aria-pressed": ctl.autoplay,
											onClick: () => ctl.setAutoplay(!ctl.autoplay),
										}
									: { "aria-hidden": true })}
							>
								<span className={styles.toggleDot} aria-hidden="true" />
								Play clips as they scroll into view
							</Tag>
						</div>
					</div>

					{BANDS.map((band) => (
						<BandView key={band.id} band={band} ctl={ctl} />
					))}
				</div>
			</section>
		</>
	);
}
