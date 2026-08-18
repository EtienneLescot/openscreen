/**
 * The OpenScreen editor, redrawn in live DOM and walked through by the scroll.
 *
 * Five beats in two acts. Act one — background, effects, cursor — is the
 * composite and one inspector panel, and draws no timeline: those three
 * settings are legible in a still frame and the picture would rather have the
 * room. Act two brings the floor in once and keeps it, for the edits that only
 * mean anything against a timeline.
 *
 * ── DERIVED, AND STAGED ──────────────────────────────────────────────────────
 *
 * The chrome is the application's. `PANELS` carries the panel titles by locale
 * key, `CONTROLS` every slider at the vendored document's own setting — scaled
 * and suffixed the way `RightPanes.tsx` does it, which is where a hand-written
 * panel goes plausibly wrong — and `CURSORS` the ten packs the picker shows,
 * each with the hotspot the renderer actually uses.
 *
 * The session is staged: the transcript, the trims, the zooms and the speed
 * ramp are a composed demonstration, not a recording. `generated.ts` carries the
 * provenance of every string it draws.
 *
 * ── ONE CLOCK, TWO TIMEBASES ─────────────────────────────────────────────────
 *
 * The scroll is the only input. `scene.ts` turns scroll position into a `Frame`
 * carrying both the scene clock and the footage clock — which differ, because a
 * speed ramp is in the middle of the take. `driver.ts` writes that frame to
 * custom properties on one element and seeks one video. React renders once.
 *
 * ── ACCESSIBILITY ────────────────────────────────────────────────────────────
 *
 * No focusable node. The app's controls are real buttons and sliders; recreated
 * as controls they become tab stops announcing actions this page will never
 * perform. Every swatch, slider and pill here is a span.
 *
 * What is exposed is the five claims and the transcript's words as real text.
 * The drawn application — wallpaper, window, pointers, ruler, waveform,
 * playhead, webcam — is `aria-hidden`: it is a picture of software, and a
 * screen reader that walked it would recite a hundred nodes of chrome.
 */

import {
	Clock,
	Crosshair,
	MessageSquare,
	SplitSquareHorizontal,
	Wand2,
	ZoomIn,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { attachDriver, SCENE_QUERIES } from "./driver";
import { CONTROLS, CURSORS, PANELS } from "./generated";
import {
	BEATS,
	CLIPS,
	CUT_INDEX,
	FLOOR_H,
	frameAt,
	LANES,
	PLAYHEAD,
	SPEED,
	shotCursorSrc,
	TOKENS,
	trims,
	WALLPAPER_COUNT_SHOWN,
	ZOOMS,
} from "./scene";
import styles from "./styles.module.css";

/* ── geometry helpers ─────────────────────────────────────────────────────── */

/** Rail positions are static; only the rail itself is translated. */
/* Seconds, resolved against the rail's scale at paint time rather than baked in
   here. --k moves with the stage's width, and the rail's own transform already
   reads it, so children placed this way stay nailed to the ruler at any width.
   Inline styles, so postcss never sees this calc. */
const x = (sec: number) => `calc(${sec.toFixed(3)} * var(--k) * 1px)`;

/** The frame the scene comes to rest on, and the one a reader with no driver is
 *  handed. Everything below that needs a resting value reads it. */
const REST = frameAt(1);

/** The twelve wallpapers the picker shows, in the design's order. */
const WALLPAPERS = [2, 5, 8, 11, 1, 4, 6, 7, 9, 10, 12, 13];
/** The four the background beat steps through, as full-size canvas layers. */
const CANVAS_BG = [1, 2, 3, 4];

/** The ruler's half-second ticks and its labelled seconds. */
const RULER = Array.from({ length: 103 }, (_, i) => (i - 18) / 2).filter((t) => t <= 42);

const fmt = (sec: number) => {
	const s = Math.max(0, sec);
	return `${Math.floor(s / 60)}:${(Math.floor(s) % 60).toString().padStart(2, "0")}`;
};

/* ── small pieces ─────────────────────────────────────────────────────────── */

function Slider({ label, display, pct }: { label: string; display: string; pct: number }) {
	return (
		<span className={styles.control}>
			<span className={styles.controlHead}>
				<span className={styles.controlLabel}>{label}</span>
				<span className={styles.controlValue}>{display}</span>
			</span>
			<span className={styles.track}>
				<span className={styles.trackFill} style={{ width: `${pct}%` }} />
				<span className={styles.knob} style={{ left: `${pct}%` }} />
			</span>
		</span>
	);
}

function Toggle({ label, on }: { label: string; on: boolean }) {
	return (
		<span className={`${styles.control} ${styles.controlRow}`}>
			<span className={styles.controlLabel}>{label}</span>
			<span className={`${styles.switch} ${on ? styles.switchOn : ""}`} />
		</span>
	);
}

const pctOf = (c: { value: number; min: number; max: number }) =>
	((c.value - c.min) / (c.max - c.min)) * 100;

/* ── the component ────────────────────────────────────────────────────────── */

export default function Recreation() {
	const band = useRef<HTMLElement | null>(null);
	const root = useRef<HTMLDivElement | null>(null);
	const cam = useRef<HTMLVideoElement | null>(null);
	const padValue = useRef<HTMLSpanElement | null>(null);
	const sizeValue = useRef<HTMLSpanElement | null>(null);
	const flow = useRef<HTMLParagraphElement | null>(null);

	useEffect(() => {
		const refs = {
			band: band.current,
			root: root.current,
			cam: cam.current,
			padValue: padValue.current,
			sizeValue: sizeValue.current,
			flow: flow.current,
		};
		if (Object.values(refs).some((el) => el === null)) return;
		const classes = { struck: styles.struck };

		// The gate is re-checked, not decided once: a reader who opens the page
		// narrower than 360px and widens it past that gets the stage from CSS the
		// instant the query flips, and a driver that had given up at mount would
		// leave it frozen at its resting frame with the scroll doing nothing.
		let detach = attachDriver(refs as Parameters<typeof attachDriver>[0], classes);
		const queries = SCENE_QUERIES.map((q) => window.matchMedia(q));
		const recheck = () => {
			detach();
			detach = attachDriver(refs as Parameters<typeof attachDriver>[0], classes);
		};
		for (const q of queries) q.addEventListener("change", recheck);
		return () => {
			for (const q of queries) q.removeEventListener("change", recheck);
			detach();
		};
	}, []);

	const placed = trims(0);

	return (
		<section className={styles.band} ref={band} data-recreation="">
			{/* Three resting values that cannot live in the stylesheet, all read off
			    the closing frame rather than typed:

			    the two cursor sprites, because a url() inside a CSS module is
			    inlined by webpack as a data URI and these two came to a quarter of
			    the site's only render-blocking resource — paid for on every docs
			    page, none of which has a stage on it;

			    the wallpaper, because the selection is an attribute rather than a
			    custom property, so there is nowhere in the sheet to declare it.
			    `release()` restores it from the same expression.

			    The driver overwrites all three per frame. */}
			<div
				className={styles.stage}
				ref={root}
				data-bg={String(REST.bg)}
				style={
					{
						"--shot-cursor": `url("${shotCursorSrc(REST)}")`,
						"--ui-cursor": `url("${CURSORS.themes[0].src}")`,
					} as React.CSSProperties
				}
			>
				{/* ═══ THE LEFT COLUMN ═══ The caption and the inspector, in one flow
				    so the pair can be balanced against the picture as a unit — nothing
				    can align two boxes that are positioned absolutely and
				    independently, which is what they were.

				    The panel lives here rather than inside `.scene` for that reason
				    alone, and carries its own aria-hidden: it is a drawing, while the
				    caption above it is the section's real copy and has to stay in the
				    accessibility tree. */}
				<div className={styles.column}>
					{/* ═══ THE CAPTIONS ═══ Above the gate they share one box and take
					    turns; below it they stack. */}
					<div className={styles.captions}>
						{BEATS.map((b) => (
							<article key={b.id} className={styles.cap} data-cap={b.id}>
								<p className={styles.capKicker}>{b.kicker}</p>
								<h3 className={styles.capTitle}>{b.title}</h3>
								<p className={styles.capSub}>{b.sub}</p>
							</article>
						))}
					</div>

					{/* ═══ THE INSPECTOR ═══ */}
					<div className={styles.panel} aria-hidden="true">
						<header className={styles.panelHead}>
							<h4 className={styles.panelTitle} data-pane="style">
								{PANELS.background.title}
							</h4>
							<h4 className={styles.panelTitle} data-pane="effects">
								{PANELS.effects.title}
							</h4>
							<h4 className={styles.panelTitle} data-pane="cursor">
								{PANELS.cursor.title}
							</h4>
							<h4 className={styles.panelTitle} data-pane="transcript">
								Current transcription
							</h4>
						</header>

						<div className={styles.panelBody}>
							{/* ── Background ── */}
							<div className={styles.pane} data-pane="style">
								<span className={styles.tabs}>
									{PANELS.background.tabs.map((tab, i) => (
										<span key={tab} className={i === 0 ? styles.tabOn : styles.tab}>
											{tab}
										</span>
									))}
								</span>
								<span className={styles.upload}>{PANELS.background.uploadCustom}</span>
								<span className={styles.swatches} data-strip="">
									{WALLPAPERS.slice(0, WALLPAPER_COUNT_SHOWN).map((n, i) => (
										<span
											key={n}
											className={styles.swatch}
											data-i={i}
											data-t={i < 4 ? `th-${i}` : undefined}
										>
											{/* Lazy, and warmed by the driver — see primeStrip(). These
											    twelve sit in a pane held at `display: none` until the
											    style beat opens, and a lazy image inside a display:none
											    box never intersects anything, so all twelve fired at
											    once when the beat arrived and the strip painted blank
											    for the first half second of it. Loading them eagerly
											    fixes that and bills 48 KB to everyone who opens the
											    page, including the readers who never scroll this far.
											    Phones are not an exception to pay it for: the scene
											    runs from 360px up, and they reach this strip too. */}
											<img
												src={`/img/walkthrough/wp-${String(n).padStart(2, "0")}.jpg`}
												alt=""
												width={240}
												height={240}
												loading="lazy"
												decoding="async"
											/>
										</span>
									))}
								</span>
							</div>

							{/* ── Video Effects ── */}
							<div className={styles.pane} data-pane="effects">
								<span className={`${styles.control} ${styles.controlLive}`}>
									<span className={styles.controlHead}>
										<span className={styles.controlLabel}>{CONTROLS.padding.label}</span>
										<span className={styles.controlValue} ref={padValue}>
											{CONTROLS.padding.display}
										</span>
									</span>
									<span className={styles.track} data-t="padtrk">
										<span className={`${styles.trackFill} ${styles.trackFillPad}`} />
										<span className={`${styles.knob} ${styles.knobPad}`} />
									</span>
								</span>
								<Toggle label={CONTROLS.blurBg.label} on={CONTROLS.blurBg.on} />
								<Slider
									label={CONTROLS.motionBlur.label}
									display={CONTROLS.motionBlur.display}
									pct={pctOf(CONTROLS.motionBlur)}
								/>
								<Slider
									label={CONTROLS.shadow.label}
									display={CONTROLS.shadow.display}
									pct={pctOf(CONTROLS.shadow)}
								/>
								<Slider
									label={CONTROLS.roundness.label}
									display={CONTROLS.roundness.display}
									pct={pctOf(CONTROLS.roundness)}
								/>
							</div>

							{/* ── Cursor ── */}
							<div className={styles.pane} data-pane="cursor">
								<Toggle label={CONTROLS.cursorShow.label} on={CONTROLS.cursorShow.on} />
								<Toggle label={CONTROLS.clipToBounds.label} on={CONTROLS.clipToBounds.on} />
								<span className={styles.controlLabel}>{CONTROLS.cursorTheme.label}</span>
								<span className={styles.cursorStyles}>
									{CURSORS.themes.map((theme, i) => (
										<span
											key={theme.id}
											className={styles.cursorStyle}
											data-t={`cur-${i}`}
											data-i={i}
											style={{ backgroundImage: `url(${theme.src})` }}
										/>
									))}
								</span>
								<span className={`${styles.control} ${styles.controlLive}`}>
									<span className={styles.controlHead}>
										<span className={styles.controlLabel}>{CONTROLS.cursorSize.label}</span>
										<span className={styles.controlValue} ref={sizeValue}>
											{CONTROLS.cursorSize.display}
										</span>
									</span>
									<span className={styles.track} data-t="sztrk">
										<span className={`${styles.trackFill} ${styles.trackFillSize}`} />
										<span className={`${styles.knob} ${styles.knobSize}`} />
									</span>
								</span>
								<Slider
									label={CONTROLS.smoothing.label}
									display={CONTROLS.smoothing.display}
									pct={pctOf(CONTROLS.smoothing)}
								/>
							</div>

							{/* ── Current transcription ── */}
							<div className={styles.pane} data-pane="transcript">
								<span className={styles.flowMask}>
									<p className={styles.flow} ref={flow}>
										{TOKENS.map((tok, i) =>
											tok.silence ? (
												<span
													key={`${tok.text}-${i}`}
													className={styles.sil}
													data-w={i}
													data-t={`tok-${i}`}
												>
													{tok.text}
												</span>
											) : (
												<span
													key={`${tok.text}-${i}`}
													className={styles.word}
													data-w={i}
													data-tier={tok.tier}
													data-t={CUT_INDEX.includes(i) ? `tok-${i}` : undefined}
												>
													{tok.text}{" "}
												</span>
											),
										)}
									</p>
								</span>
							</div>
						</div>
					</div>

					{/* ═══ THE TOOL PALETTE ═══ six tools, the app's own bar */}
					<div className={styles.palette}>
						<span
							className={`${styles.tool} ${styles.toolWand}`}
							data-t="wand"
							data-t-beat="timeline"
						>
							<Wand2 size={30} />
						</span>
						<span className={styles.tool}>
							<SplitSquareHorizontal size={30} />
						</span>
						<span className={styles.tool}>
							<Clock size={30} />
						</span>
						<span
							className={`${styles.tool} ${styles.toolComment}`}
							data-t="comment"
							data-t-beat="timeline"
						>
							<MessageSquare size={30} />
						</span>
						<span className={styles.tool}>
							<ZoomIn size={30} />
						</span>
						<span className={styles.tool}>
							<Crosshair size={30} />
						</span>
					</div>
				</div>

				<div className={styles.scene} aria-hidden="true">
					{/* ═══ THE COMPOSITE ═══ */}
					<div className={styles.card}>
						<div className={styles.cardClip}>
							<div className={styles.zoomer} data-shot-box>
								{CANVAS_BG.map((n) => (
									<img
										key={n}
										className={styles.bg}
										data-i={n - 1}
										src={`/img/walkthrough/canvas-bg-${n}.jpg`}
										alt=""
										loading={n === 1 ? undefined : "lazy"}
										decoding="async"
									/>
								))}

								{/* The recorded window. `--frame-scale` is a uniform scale, not an
								    inset: the page inside must not reflow while the padding moves. */}
								<div className={styles.frame}>
									<div className={styles.chrome}>
										<span className={styles.lights}>
											<span />
											<span />
											<span />
										</span>
										<span className={styles.omnibox}>fern.garden</span>
									</div>
									<div className={styles.viewport}>
										<div className={styles.page} data-shot-scroll>
											<div className={styles.pageNav}>
												<span className={styles.pageMark} />
												<span className={styles.pageBrand}>Fern</span>
												<span className={styles.pageLinks}>
													<span>Product</span>
													<span>Pricing</span>
													<span>Journal</span>
												</span>
												<span className={styles.pageSignIn}>Sign in</span>
											</div>
											<div className={styles.pageHero}>
												<h3>Grow smarter, water less.</h3>
												<p>
													Fern watches your plants&apos; soil, light and weather — and waters only
													when they ask for it.
												</p>
												<div className={styles.pageBtns}>
													<span className={styles.pageCta} data-shot="cta">
														Download the app
													</span>
													<span className={styles.pageGhost}>See how it works</span>
												</div>
											</div>
											<div className={styles.pageShot}>
												<img
													src="/img/walkthrough/canvas-poster.jpg"
													alt=""
													loading="lazy"
													decoding="async"
												/>
												<span className={styles.pageChip}>Live soil data</span>
											</div>
											{/* The social proof strip and the three feature cards, as the
											    design draws them. They were three empty boxes until now; the
											    take scrolls the page far enough to show them, so they were
											    the one part of the recorded window that read as unfinished. */}
											<div className={styles.pageProof}>
												<span className={styles.pageFaces}>
													<span data-face="a">LB</span>
													<span data-face="b">AK</span>
													<span data-face="c">JM</span>
												</span>
												<span>
													Loved by <strong>12,400</strong> gardeners
												</span>
												<span>
													<strong>38</strong> countries
												</span>
												<span>
													<strong>4.9</strong> avg rating
												</span>
											</div>

											<div className={styles.pageCards}>
												<article className={styles.pageCard}>
													<div className={`${styles.pageCardArt} ${styles.artDots}`}>
														{[
															[1, 1, 0, 1, 0, 0, 1],
															[0, 1, 0, 0, 1, 0, 0],
														].map((row, r) => (
															<span key={r}>
																{row.map((on, i) => (
																	<span key={i} data-on={on ? "" : undefined} />
																))}
															</span>
														))}
													</div>
													<div className={styles.pageCardBody}>
														<div>Auto schedules</div>
														<div>Every pot on its own rhythm.</div>
													</div>
												</article>

												<article className={styles.pageCard}>
													<div className={`${styles.pageCardArt} ${styles.artBars}`}>
														{[
															[34, 0.55],
															[58, 0.7],
															[44, 0.6],
															[62, 0.75],
														].map(([h, o]) => (
															<span key={h} style={{ height: `${h}%`, opacity: o }} />
														))}
													</div>
													<div className={styles.pageCardBody}>
														<div>Soil signals</div>
														<div>Moisture, light and heat, live.</div>
													</div>
												</article>

												<article className={styles.pageCard}>
													<div className={`${styles.pageCardArt} ${styles.artLines}`}>
														{[
															[82, 0.5],
															[64, 0.35],
															[74, 0.45],
														].map(([w, o]) => (
															<span key={w} style={{ width: `${w}%`, opacity: o }} />
														))}
													</div>
													<div className={styles.pageCardBody}>
														<div>Harvest notes</div>
														<div>A journal that writes itself.</div>
													</div>
												</article>
											</div>
										</div>

										{/* The app the recording opens, half-way through the take. Two
										    states crossfaded on the footage clock, under one title bar. */}
										<div className={styles.appWin} data-shot-win>
											<div className={styles.appBar} data-shot="app-bar">
												<span className={styles.appLights}>
													<span data-l="r" />
													<span data-l="y" />
													<span data-l="g" />
												</span>
												<span className={styles.appTitle}>Fern — Add a sensor</span>
												<span className={styles.appPad} />
											</div>

											<div className={styles.appSetup}>
												<div className={styles.appHead}>Pair a soil sensor</div>
												<div className={styles.appRow}>
													<span className={styles.appDot} />
													Fern Probe · FP-204
													<span className={styles.appMeta}>-42 dBm</span>
												</div>
												<div className={`${styles.appRow} ${styles.appRowIdle}`}>
													<span className={styles.appDot} />
													Searching nearby…
												</div>
												<span className={styles.appBtn} data-shot="app-go">
													Pair sensor
												</span>
											</div>

											<div className={styles.appDone}>
												<span className={styles.appTick}>
													<svg viewBox="0 0 24 24" aria-hidden="true">
														<path
															d="M20 6 9 17l-5-5"
															fill="none"
															stroke="#059669"
															strokeWidth="2.6"
															strokeLinecap="round"
															strokeLinejoin="round"
														/>
													</svg>
												</span>
												<div className={styles.appOk}>Sensor paired</div>
												<div className={styles.appSub}>Bed 3 — South garden is now live.</div>
											</div>
										</div>
									</div>
								</div>

								{/* The pointer inside the recording, from the captured telemetry —
								    which is what the Cursor panel restyles. */}
								<span className={styles.shotCursor} />
							</div>
						</div>

						<span className={styles.zoomBadge}>
							<span className={styles.zoomBadgeText}>{ZOOMS[1].label}</span>
						</span>

						{/* 16/10.5, not a circle. */}
						<span className={styles.webcam}>
							{/* No poster attribute: the driver sets one. `preload="none"` and a
							    src withheld until the reader is inside the band mean this
							    bordered, shadowed box paints EMPTY until the clip's first frame
							    decodes — just over a second on a 1.5 Mbps link. A poster in the
							    markup fixes that and bills 6.9 KB to every reader on every load,
							    phones included — the scene runs from 360px up — for a bubble
							    nobody sees before the band. */}
							<video
								ref={cam}
								className={styles.webcamVideo}
								muted
								playsInline
								preload="none"
								tabIndex={-1}
								disableRemotePlayback
							/>
						</span>
					</div>

					{/* ═══ THE FLOOR ═══ */}
					<div className={styles.floor}>
						<div className={styles.floorClip}>
							{/* Static positions, one transform. */}
							<div className={styles.rail}>
								<div className={styles.ruler}>
									{RULER.map((t) => {
										const major = Math.round(t * 2) % 4 === 0;
										return (
											<span
												key={t}
												className={major ? styles.tickMajor : styles.tick}
												style={{ left: x(t) }}
											>
												{major && t >= 0 ? fmt(t) : null}
											</span>
										);
									})}
								</div>

								{CLIPS.map((c) => (
									<div
										key={c.from}
										className={styles.clip}
										style={{ left: x(c.from), width: x(c.to - c.from) }}
									>
										<span className={styles.clipWave} />
									</div>
								))}

								{ZOOMS.map((z, i) => (
									<span
										key={z.label + z.from}
										className={styles.pillZoom}
										style={{
											left: x(z.from),
											width: x(z.to - z.from),
											["--i" as string]: i,
										}}
									>
										{z.label}
									</span>
								))}

								<span
									className={styles.pillSpeed}
									style={{ left: x(SPEED.from), width: x(SPEED.to - SPEED.from) }}
								>
									{SPEED.label}
								</span>

								{placed.map((c, i) => (
									<span
										key={`${c.label}-${c.from}`}
										className={styles.pillTrim}
										data-trim=""
										style={{
											left: x(c.from),
											width: x(c.to - c.from),
											["--i" as string]: i,
										}}
									>
										{c.label}
									</span>
								))}
							</div>
						</div>

						<span className={styles.playhead} style={{ left: `${PLAYHEAD * 100}%` }}>
							<span className={styles.playheadHead} />
						</span>
					</div>

					{/* The reader's pointer, over the editor. */}
					<span className={styles.uiCursor} />
				</div>
			</div>
		</section>
	);
}
