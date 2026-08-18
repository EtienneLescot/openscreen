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
 * ramp are a composed demonstration, not a recording. The figcaption says so.
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
	K,
	LANES,
	PLAYHEAD,
	SPEED,
	TOKENS,
	trims,
	WALLPAPER_COUNT_SHOWN,
	ZOOMS,
} from "./scene";
import styles from "./styles.module.css";

/* ── geometry helpers ─────────────────────────────────────────────────────── */

/** Rail positions are static; only the rail itself is translated. */
const x = (sec: number) => `${(sec * K).toFixed(1)}px`;

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
	const timeValue = useRef<HTMLSpanElement | null>(null);
	const cutsValue = useRef<HTMLSpanElement | null>(null);
	const flow = useRef<HTMLParagraphElement | null>(null);

	useEffect(() => {
		const refs = {
			band: band.current,
			root: root.current,
			cam: cam.current,
			padValue: padValue.current,
			sizeValue: sizeValue.current,
			timeValue: timeValue.current,
			cutsValue: cutsValue.current,
			flow: flow.current,
		};
		if (Object.values(refs).some((el) => el === null)) return;
		const classes = { struck: styles.struck, cue: styles.cue };

		// The gate is re-checked, not decided once: a reader who opens the page
		// narrow and widens it past 901px gets the stage from CSS the instant the
		// query flips, and a driver that had given up at mount would leave it
		// frozen at its resting frame with the scroll doing nothing.
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
		<>
			<section className={styles.band} ref={band} data-recreation="">
				<div className={styles.stage} ref={root}>
					{/* ═══ THE CAPTIONS ═══ The section's real copy. Above the gate they
					    share one box and take turns; below it they stack. */}
					<div className={styles.captions}>
						{BEATS.map((b) => (
							<article key={b.id} className={styles.cap} data-cap={b.id}>
								<p className={styles.capKicker}>{b.kicker}</p>
								<h3 className={styles.capTitle}>{b.title}</h3>
								<p className={styles.capSub}>{b.sub}</p>
							</article>
						))}
					</div>

					<div className={styles.scene} aria-hidden="true">
						{/* ═══ THE INSPECTOR ═══ */}
						<div className={styles.panel}>
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
									<span className={styles.swatches}>
										{WALLPAPERS.slice(0, WALLPAPER_COUNT_SHOWN).map((n, i) => (
											<span
												key={n}
												className={styles.swatch}
												data-t={i < 4 ? `th-${i}` : undefined}
												style={{ ["--i" as string]: i }}
											>
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
							<span className={`${styles.tool} ${styles.toolWand}`} data-t="wand">
								<Wand2 size={30} />
							</span>
							<span className={styles.tool}>
								<SplitSquareHorizontal size={30} />
							</span>
							<span className={styles.tool}>
								<Clock size={30} />
							</span>
							<span className={`${styles.tool} ${styles.toolComment}`} data-t="comment">
								<MessageSquare size={30} />
							</span>
							<span className={styles.tool}>
								<ZoomIn size={30} />
							</span>
							<span className={styles.tool}>
								<Crosshair size={30} />
							</span>
						</div>

						{/* ═══ THE COMPOSITE ═══ */}
						<div className={styles.card}>
							<div className={styles.cardClip}>
								<div className={styles.zoomer}>
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
											<div className={styles.page}>
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
														<span className={styles.pageCta}>Download the app</span>
														<span className={styles.pageGhost} data-shot="see">
															See how it works
														</span>
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
												<div className={styles.pageCards}>
													<span />
													<span />
													<span />
												</div>
											</div>

											{/* The app the recording opens, half-way through the take. */}
											<div className={styles.appWin}>
												<div className={styles.appSetup}>
													<span className={styles.appLine} />
													<span className={styles.appLine} />
													<span className={styles.appBtn}>Pair sensor</span>
												</div>
												<div className={styles.appDone}>
													<span className={styles.appTick} />
													<span className={styles.appOk}>Sensor paired</span>
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

							<div className={styles.transport}>
								<span className={styles.time} ref={timeValue}>
									0:00.0
								</span>
								<span className={styles.cuts} ref={cutsValue} />
							</div>
						</div>

						{/* The reader's pointer, over the editor. */}
						<span className={styles.uiCursor} />
					</div>
				</div>
			</section>

			<p className={styles.figcaption}>
				The editor above is drawn live in your browser from the design tokens the application ships:
				the panel titles, every slider&apos;s range and units, the wallpapers and the ten cursor
				packs are read out of its source rather than typed here. The session it is editing is a
				staged demonstration, not a recording of one.
			</p>
		</>
	);
}
