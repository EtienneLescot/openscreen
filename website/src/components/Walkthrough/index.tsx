import { useEffect, useRef, useState } from "react";

import Head from "@docusaurus/Head";

import Recreation from "../Recreation";
import { BANDS, type Band } from "./bands";
import { PLATE } from "./plate";
import styles from "./styles.module.css";
import { type BandPlayback, useBandPlayback } from "./useBandPlayback";
import { useScrub, useScrubEnabled } from "./useScrub";

/**
 * Decides the layout before the first paint rather than after hydration.
 *
 * The pinned layout makes its band about two viewports tall. Switching to it
 * once React has mounted would move every section below it, which is a layout
 * shift with no user interaction to excuse it — exactly what CLS counts. An
 * attribute set from the document head costs one synchronous statement and is
 * in place before anything is painted.
 *
 * `position: sticky` is checked as well as the motion preference: it is the one
 * capability the layout cannot do without, and an engine that lacks it would
 * otherwise be handed a two-viewport-tall band with a picture stranded at the
 * top of it.
 */
const SCRUB_GATE = `try{var m=matchMedia('(prefers-reduced-motion: reduce)').matches,
w=matchMedia('(min-width: 901px)').matches,s=CSS.supports('position','sticky');
document.documentElement.setAttribute('data-os-scrub',!m&&w&&s?'on':'off')}catch(e){}`;

/** Both global controls are server-rendered as inert spans of identical box size
 *  and upgraded after hydration, so a reader without JavaScript never meets a
 *  control that looks operable and is not. Deliberately not named `use…`: it is a
 *  ternary, it is called after an early return, and a hook-shaped name is how a
 *  later refactor talks itself into putting state inside it. */
function upgradedTag(hydrated: boolean) {
	return hydrated ? "button" : "span";
}

/**
 * A band the reader scrubs: the figure pins, the band is taller than the
 * viewport, and scroll position walks the clip. There is no Play control and no
 * dwell timer — the scroll *is* the transport, in both directions, and a reader
 * who stops gets a still frame rather than something that carries on without
 * them. The poster stays underneath and is what shows until the clip can seek.
 */
function ScrubBand({ band }: { band: Band }) {
	const media = band.media!;
	const scrub = media.scrub!;
	const bandRef = useRef<HTMLElement | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const enabled = useScrubEnabled();
	const [small, setSmall] = useState(false);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 780px)");
		const sync = () => setSmall(mq.matches);
		sync();
		mq.addEventListener("change", sync);
		return () => mq.removeEventListener("change", sync);
	}, []);
	const { progress, ready, near } = useScrub({
		band: bandRef,
		video: videoRef,
		seconds: scrub.seconds,
		enabled,
	});

	return (
		<article
			id={band.id}
			ref={bandRef}
			className={`${styles.band} ${styles.split} ${band.flip ? styles.flip : ""} ${styles.scrubbable}`}
		>
			<Copy band={band} />
			<figure className={styles.figure}>
				<div
					className={styles.frame}
					style={{ aspectRatio: `${media.width} / ${media.height}` }}
				>
					<picture>
						<source media="(max-width: 780px)" srcSet={media.imageSm} />
						<img
							className={styles.still}
							src={media.image}
							width={media.width}
							height={media.height}
							loading="lazy"
							decoding="async"
							alt={media.alt}
						/>
					</picture>
					{enabled && near && (
						<video
							ref={videoRef}
							className={`${styles.clip} ${ready ? styles.clipReady : ""}`}
							src={small ? scrub.clipSm : scrub.clip}
							width={media.width}
							height={media.height}
							muted
							playsInline
							preload="auto"
							aria-hidden="true"
							tabIndex={-1}
							disableRemotePlayback
						/>
					)}
				</div>
				{/* Both captions are rendered and CSS shows one, because which is true
				    depends on a capability the server cannot know. Swapping the text
				    after hydration would say "Scroll to run it" to a reader for whom it
				    is false, for as long as the bundle takes to arrive. */}
				<figcaption className={styles.caption}>
					<span className={`${styles.captionText} ${styles.captionScrub}`}>
						Scroll to run it · {scrub.frames} frames
					</span>
					<span className={`${styles.captionText} ${styles.captionStill}`}>
						A frame of the running application
					</span>
				</figcaption>
				<span className={`${styles.rail} ${styles.railScrub}`} aria-hidden="true">
					<span
						className={styles.railFill}
						style={{ transform: `scaleX(${progress.toFixed(4)})` }}
					/>
				</span>
			</figure>
		</article>
	);
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
	const { markRefused, playToken, small } = ctl;

	useEffect(() => {
		if (!owns) {
			setReady(false);
			setPlaying(false);
			return;
		}
		const el = videoRef.current;
		if (!el) return;
		let live = true;
		// `playToken` and `small` are dependencies for the same reason: neither one
		// moves `owns`, and both mean the element has to start over. The second is
		// the less obvious one — changing `src` runs the resource-selection
		// algorithm, which rewinds to 0 and pauses without firing `pause`, so
		// nothing else on the page would ever learn that playback had stopped.
		el.currentTime = 0;
		const attempt = el.play();
		if (attempt) {
			attempt.catch((err: DOMException) => {
				// iOS in Low Power Mode refuses muted inline autoplay outright, and
				// the page cannot override it. The poster and the labelled button
				// stay; only the element goes away. An AbortError claims nothing of
				// the sort — the band lost the element, or swapped rendition, while
				// the clip was still loading — and filing it as a refusal deletes
				// the only control the section has over its own motion.
				if (live && err?.name === "NotAllowedError") markRefused(band.id);
			});
		}
		return () => {
			live = false;
		};
	}, [owns, band.id, markRefused, playToken, small]);

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
	const Tag = upgradedTag(ctl.hydrated);
	const label = played ? `Replay the ${band.kicker} clip` : `Play the ${band.kicker} clip`;

	return (
		<article
			id={band.id}
			className={`${styles.band} ${band.shape === "letterbox" ? styles.wide : styles.split} ${
				band.flip ? styles.flip : ""
			}`}
		>
			<Copy band={band} />
			{/* The observer watches the picture, not the band. A stacked band on a
			    landscape phone is taller than the viewport, so its intersection
			    ratio cannot reach the threshold at all and the clip never starts
			    however long the reader sits on it. The figure always fits. */}
			<figure
				className={styles.figure}
				ref={ctl.registerBand(band.id)}
				data-band-id={band.id}
			>
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
							src={small ? media.clipSm : media.clip}
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
							onEmptied={() => {
								setReady(false);
								setPlaying(false);
							}}
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
	const scrubbing = useScrubEnabled();
	const Tag = upgradedTag(ctl.hydrated);

	return (
		<>
			<Head>
				<script>{SCRUB_GATE}</script>
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
						// react-dom 18 does not recognise the camelCase prop it learns in 19,
						// and logs an unknown-prop error for it on every dev load of the
						// landing page. Both spellings serialise to fetchpriority="high";
						// the spread is only what gets the lowercase one past @types/react,
						// which is already on 19.
						{...{ fetchpriority: "high" }}
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
						{/* The line this replaces read "Nothing here is a drawing of the
						    interface", which the recreation makes false on a wide screen —
						    and a claim that is true at 900px and false at 901px is worse
						    than no claim. What survives is the part that is still checkable:
						    the photographs are the application, and the drawn panels quote a
						    file rather than an art director. */}
						<p className={styles.deck}>
							No sound, no narration. The photographs are the running application, unretouched. The
							editor you scroll through is drawn live from the same design tokens the app ships,
							around real footage of the recording it is editing — and every label in it is read out
							of the project file rather than typed by hand.
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
											// Turning it off has to stop the clip that is running and
											// the one that is 400ms from starting, or the control
											// reports a state the page has not entered.
											onClick: () =>
												ctl.autoplay ? ctl.stopAutoplay() : ctl.setAutoplay(true),
										}
									: { "aria-hidden": true })}
							>
								<span className={styles.toggleDot} aria-hidden="true" />
								Play clips as they scroll into view
							</Tag>
						</div>
					</div>

					{/* Which component renders a band is decided by the data, not by a
					    capability — the server and the client must agree, and the pinned
					    layout is turned on and off in CSS alone.

					    The middle three bands and the recreation are the same three claims
					    told twice, so exactly one of them is ever visible. Both gates are
					    pure CSS and exact mirrors of each other — ≥901px and `position:
					    sticky` supported and not forced-colors — so there is no width at
					    which a reader gets both or neither, and nothing waits for
					    hydration to decide. Record and export are not in the recreation
					    (they are separate screens in the app, not part of the editor), so
					    they render at every width. */}
					{BANDS.filter((b) => b.index === "01").map((band) => (
						<BandView key={band.id} band={band} ctl={ctl} />
					))}

					<Recreation />

					<div className={styles.superseded}>
						{BANDS.filter((b) => ["02", "03", "04"].includes(b.index)).map((band) =>
							band.media?.scrub ? (
								<ScrubBand key={band.id} band={band} />
							) : (
								<BandView key={band.id} band={band} ctl={ctl} />
							),
						)}
					</div>

					{BANDS.filter((b) => b.index === "05").map((band) =>
						band.media?.scrub ? (
							<ScrubBand key={band.id} band={band} />
						) : (
							<BandView key={band.id} band={band} ctl={ctl} />
						),
					)}
				</div>
			</section>
		</>
	);
}
