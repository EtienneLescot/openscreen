/**
 * The OpenScreen editor, redrawn in live DOM and walked through by the scroll.
 *
 * Six settings in two acts. Act one — background, padding, cursor — needs no
 * timeline to make sense, so it does not draw one: the composite gets the whole
 * stage and the inspector answers beside it. Act two — auto zoom, annotation,
 * transcript — is only meaningful against a timeline, so the timeline slides in
 * once, between the acts, and the composite gives up the height it borrowed.
 *
 * Every string, number and percentage comes from `generated.ts`, which
 * `scripts/gen-recreation.mjs` emits by reading the project document
 * (`fixture-slim.json`, schemaVersion 7), the app's locale files, and the app's
 * own `formatSec` / `effectiveZoomScale` / `buildClipSection`, imported and run.
 * The panels are the app's real panels: `PANELS` carries their titles and
 * `CONTROLS` carries every slider at this document's own setting, scaled and
 * suffixed the way `RightPanes.tsx` scales and suffixes it — cursor size is
 * `size * 10` with one decimal and no unit, which a hand-written panel gets
 * wrong in a way that looks completely plausible.
 *
 * ── ONE CLOCK ────────────────────────────────────────────────────────────────
 *
 * The scroll is the only clock. `scene.ts` turns scroll position into a `Frame`;
 * `driver.ts` writes that frame to custom properties on one element. There is no
 * media element and no second timebase, so nothing can drift out of step with
 * anything else: the playhead, the pill under it, the composite's magnification
 * and the transcript's cue are four readings of a single number.
 *
 * This file renders once and never again. It holds no state and reads no clock.
 *
 * ── ACCESSIBILITY ────────────────────────────────────────────────────────────
 *
 * No focusable node anywhere. The app's controls are real buttons and sliders;
 * recreated as controls they become tab stops that announce actions this page
 * will never perform — a lie told exclusively to the readers least able to check
 * it. Every swatch, slider and pill here is a `<span>`.
 *
 * One state, not a mutating one. What is exposed is the closing state and is
 * exposed from the first frame: the six claims, the panel titles and control
 * labels, the transcript's 103 words and 3 silence markers as real selectable
 * text, the five pill labels and the three lane hints. What moves is opacity and
 * transform, never the tree. Nothing is announced, nothing flips under a linear
 * reader, and there is no live region.
 *
 * Hidden from the accessibility tree: the wallpaper, the recorded page, both
 * pointers, the window chrome, the ruler, the waveform, the playhead and the
 * transport — pictures of an application, with nothing to read.
 */

import {
	ChevronRight,
	CircleHelp,
	MessageSquare,
	MousePointer2,
	Scissors,
	Wand2,
	ZoomIn,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { attachDriver, SCENE_QUERIES } from "./driver";
import {
	CONTROLS,
	INSPECTOR,
	LANES,
	META,
	PANELS,
	type RecreationPill,
	RULER,
	TRANSPORT,
	WAVEFORM,
	WORDS,
} from "./generated";
import { BEATS, NOTE_AT, NOTE_LEN, WALLPAPER_FROM, WALLPAPER_TO } from "./scene";
import styles from "./styles.module.css";

/* ── the copy ─────────────────────────────────────────────────────────────
 * One caption per beat, in the beats' own order. The `id` is what the driver
 * writes to `data-beat`, so the score and the words cannot fall out of order
 * without TypeScript noticing.
 */

const CAPTIONS: Record<
	(typeof BEATS)[number]["id"],
	{ kicker: string; claim: string; body: string; fact: string }
> = {
	background: {
		kicker: "Background",
		claim: "Swap what sits behind it.",
		body: "A recording is a rectangle on a desktop. Put a wallpaper, a colour or a gradient behind it and the composite re-renders as you pick — nothing is baked in until you export.",
		fact: `${PANELS.background.wallpaperCount} bundled wallpapers · or any image on disk`,
	},
	padding: {
		kicker: "Padding",
		claim: "Give the window room.",
		body: "One slider insets the whole composite, corners and shadow included. This document sits at 55%, and the frame you see is that number run through the app's own arithmetic rather than a number that looked about right.",
		fact: "padding · roundness · shadow · motion blur",
	},
	cursor: {
		kicker: "Cursor",
		claim: "Your pointer, at your size.",
		body: "The cursor is not burned into the recording — it is drawn from the captured telemetry, so its style, its size and how hard it smooths are all still yours after the take.",
		fact: "recorded as telemetry · restyled after the fact",
	},
	autozoom: {
		kicker: "Auto zoom",
		claim: "Zooms, placed for you.",
		body: "The wizard reads where the pointer actually went and lays zoom regions on the timeline. Each one carries its own scale, and the picture magnifies exactly while its region is under the playhead.",
		fact: "three regions · 1.80× to 2.20× · every one editable",
	},
	annotation: {
		kicker: "Annotation",
		claim: "Pin a note to the second.",
		body: "Press A and a note lands at the playhead, on its own lane. It travels with the clip: cut something ahead of it and the note moves with the frame it was about.",
		fact: "own lane · moves with the cut",
	},
	transcript: {
		kicker: "Transcript",
		claim: "Edit the video like text.",
		body: "The transcript is the timeline. Delete a word or a silence and the cut lands on the trim lane — this document's two cuts are both dead air the agent found at the ends, and neither one touched the file.",
		fact: `${INSPECTOR.wordCount} words · ${INSPECTOR.silenceCount} silences · nothing destructive`,
	},
};

/* ── the timeline's geometry ──────────────────────────────────────────────
 * One number: how many pixels a second of the document is worth. Every object
 * on the floor is placed with it, and the strip is translated by it, so the
 * whole timeline is one transform per frame rather than 400 repositioned nodes.
 */
const K = 48;
const DOC = META.assetDurationSec;
const x = (sec: number) => `${(sec * K).toFixed(1)}px`;

const RULER_LABELS = RULER.variants[0].labels;
/** The waveform's five opacity buckets; two of them are empty on this recording
 *  (it peaks at 0.4787, so the app's own `0.5 + amp*0.5` never reaches 0.8). */
const WAVE_PATHS = WAVEFORM.paths.filter((p) => p.bars > 0);

const WALLPAPERS = Array.from({ length: PANELS.background.wallpaperCount }, (_, i) => i + 1);
/** The ten cursor styles the app's picker offers. Colour is all the recreation
 *  needs: the glyph is the same arrow at every one of them. */
const CURSOR_STYLES = [
	"#ffffff",
	"#f9a8d4",
	"#475569",
	"#a78bfa",
	"#fbbf24",
	"#f87171",
	"#e2e8f0",
	"#4ade80",
	"#94a3b8",
	"#38bdf8",
];

/* ── small pieces ─────────────────────────────────────────────────────────── */

/** A slider at a value that never moves. The two the reader does move —
 *  Padding and Size — are written out longhand below with a `--pct` the driver
 *  drives, because only those two need a variable at all. */
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

/**
 * The reader's hand, on the control it is operating.
 *
 * It is a child of that control, so it needs no coordinates: the CSS that puts
 * a knob at `left: var(--pad-pct)` puts the hand there too, at every width, and
 * a panel that moves takes its pointer with it. Which one is showing is decided
 * by `data-beat` on the stage; nothing here knows what beat it is in.
 */
function Hand() {
	return (
		<span className={styles.hand} aria-hidden="true">
			<MousePointer2 size={17} fill="#ffffff" strokeWidth={1.6} />
		</span>
	);
}

function Toggle({ label, on }: { label: string; on: boolean }) {
	return (
		<span className={`${styles.control} ${styles.controlRow}`}>
			<span className={styles.controlLabel}>{label}</span>
			<span className={`${styles.switch} ${on ? styles.switchOn : ""}`} aria-hidden="true">
				<span className={styles.switchKnob} />
			</span>
		</span>
	);
}

/** Where a slider's knob sits, as a percentage of its own track — the app's
 *  ranges are not all 0–100, and Size starts at 5. */
const pctOf = (c: { value: number; min: number; max: number }) =>
	((c.value - c.min) / (c.max - c.min)) * 100;

function Pill({ pill, index }: { pill: RecreationPill; index: number }) {
	const trim = pill.lane === "trim";
	return (
		<span
			className={`${styles.pill} ${trim ? styles.pillTrim : styles.pillZoom}`}
			style={{
				left: x(pill.startSec),
				width: x(pill.endSec - pill.startSec),
				// Each pill compares one lane-wide count against its own index, so
				// fourteen objects arrive over the ride without a single DOM write.
				["--i" as string]: index,
			}}
		>
			{trim ? (
				<Scissors className={styles.pillGlyph} size={10} aria-hidden="true" />
			) : (
				<ZoomIn className={styles.pillGlyph} size={10} aria-hidden="true" />
			)}
			{pill.label}
		</span>
	);
}

/* ── the component ────────────────────────────────────────────────────────── */

export default function Recreation() {
	const band = useRef<HTMLElement | null>(null);
	const root = useRef<HTMLDivElement | null>(null);
	const padValue = useRef<HTMLSpanElement | null>(null);
	const sizeValue = useRef<HTMLSpanElement | null>(null);
	const zoomValue = useRef<HTMLSpanElement | null>(null);
	const timeValue = useRef<HTMLSpanElement | null>(null);
	const flow = useRef<HTMLParagraphElement | null>(null);

	useEffect(() => {
		const refs = {
			band: band.current,
			root: root.current,
			padValue: padValue.current,
			sizeValue: sizeValue.current,
			zoomValue: zoomValue.current,
			timeValue: timeValue.current,
			flow: flow.current,
		};
		if (Object.values(refs).some((el) => el === null)) return;
		const classes = { cue: styles.cue, struck: styles.struck };

		// The gate is not a one-time decision. A reader who opens the page in a
		// narrow window and then widens it past 901px gets the stage from CSS the
		// instant the media query flips; if the driver had checked once at mount
		// and given up, they would get it frozen at its resting frame, with the
		// scroll doing nothing, and no way back short of a reload.
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

	return (
		// The figcaption is a sibling of the band, not a child of it. Inside, it
		// would sit in flow directly after the sticky stage's own 100vh box — that
		// is, one viewport into a six-viewport band — and show through the stage
		// for the rest of the ride.
		<>
			<section className={styles.band} ref={band} data-recreation="">
				<div className={styles.stage} ref={root}>
					{/* ═══ THE CAPTION ═══ Real headings, in the beats' order. Where the
				    scene is off, these are all this section is: a plain list of six
				    claims in ordinary flow. */}
					<div className={styles.captions}>
						{BEATS.map(({ id }) => {
							const c = CAPTIONS[id];
							return (
								<article key={id} className={styles.cap} data-cap={id}>
									<p className={styles.capKicker}>{c.kicker}</p>
									<h3 className={styles.capClaim}>{c.claim}</h3>
									<p className={styles.capBody}>{c.body}</p>
									<p className={styles.capFact}>{c.fact}</p>
								</article>
							);
						})}
					</div>

					{/* ═══ THE SCENE ═══ Everything drawn, in one box, so the captions can
				    be a sibling of it rather than a layer inside it. That is what lets
				    a reduced-motion reader get both — the claims stacked in ordinary
				    flow, and the still editor underneath them. */}
					<div className={styles.scene}>
						{/* ── the inspector ── */}
						<div className={styles.panel}>
							<header className={styles.panelHead}>
								<h4 className={styles.panelTitle} data-pane="background">
									{PANELS.background.title}
								</h4>
								<h4 className={styles.panelTitle} data-pane="padding">
									{PANELS.effects.title}
								</h4>
								<h4 className={styles.panelTitle} data-pane="cursor">
									{PANELS.cursor.title}
								</h4>
								<h4 className={styles.panelTitle} data-pane="transcript">
									{INSPECTOR.title}
								</h4>
								<span className={styles.panelGlyphs} aria-hidden="true">
									<CircleHelp size={14} />
									<ChevronRight size={14} />
								</span>
							</header>

							<div className={styles.panelBody}>
								{/* ── Background ── */}
								<div className={styles.pane} data-pane="background">
									<span className={styles.tabs} aria-hidden="true">
										{PANELS.background.tabs.map((tab, i) => (
											<span key={tab} className={i === 0 ? styles.tabOn : styles.tab}>
												{tab}
											</span>
										))}
									</span>
									<span className={styles.upload}>{PANELS.background.uploadCustom}</span>
									<span className={styles.swatches}>
										{WALLPAPERS.map((n) => (
											<span
												key={n}
												className={styles.swatch}
												// The two the pointer moves between light their own ring
												// off `--bg`; the other sixteen have no ring at all.
												data-sel={
													n === WALLPAPER_FROM ? "from" : n === WALLPAPER_TO ? "to" : undefined
												}
											>
												<img
													src={`/img/walkthrough/wp-${String(n).padStart(2, "0")}.jpg`}
													alt={PANELS.background.swatchLabels[n - 1]}
													width={240}
													height={240}
													loading="lazy"
													decoding="async"
												/>
												{n === WALLPAPER_TO ? <Hand /> : null}
											</span>
										))}
									</span>
								</div>

								{/* ── Video Effects ── */}
								<div className={styles.pane} data-pane="padding">
									<span className={`${styles.control} ${styles.controlLive}`}>
										<span className={styles.controlHead}>
											<span className={styles.controlLabel}>{CONTROLS.padding.label}</span>
											<span className={styles.controlValue} ref={padValue}>
												{CONTROLS.padding.display}
											</span>
										</span>
										<span className={styles.track}>
											<span className={`${styles.trackFill} ${styles.trackFillPad}`} />
											<span className={`${styles.knob} ${styles.knobPad}`}>
												<Hand />
											</span>
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
									<span className={styles.cursorStyles} aria-hidden="true">
										{CURSOR_STYLES.map((colour, i) => (
											<span
												key={colour}
												className={styles.cursorStyle}
												data-sel={i === 0 ? "from" : i === 1 ? "to" : undefined}
												style={{ color: colour }}
											>
												<MousePointer2 size={14} fill="currentColor" />
												{i === 1 ? <Hand /> : null}
											</span>
										))}
									</span>
									<span className={`${styles.control} ${styles.controlLive}`}>
										<span className={styles.controlHead}>
											<span className={styles.controlLabel}>{CONTROLS.cursorSize.label}</span>
											<span className={styles.controlValue} ref={sizeValue}>
												{CONTROLS.cursorSize.display}
											</span>
										</span>
										<span className={styles.track}>
											<span className={`${styles.trackFill} ${styles.trackFillSize}`} />
											<span className={`${styles.knob} ${styles.knobSize}`}>
												<Hand />
											</span>
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
									<span className={styles.clipHead}>
										<span className={styles.clipBadge} aria-hidden="true">
											{INSPECTOR.indexBadge}
										</span>
										<span>
											<span className={styles.clipName}>{INSPECTOR.filename}</span>
											<span className={styles.clipRange}>{INSPECTOR.clipRange}</span>
										</span>
									</span>
									{/* The flow is translated under a fixed mask rather than
							    scrolled, so keeping the cue in view cannot fight the page's
							    own scrolling. `data-w` is the index into WORDS: the driver
							    addresses the cue by integer and never matches it by text. */}
									<span className={styles.flowMask}>
										<p className={styles.flow} ref={flow}>
											{WORDS.map((w) =>
												w.kind === "silence" ? (
													<span
														key={w.id}
														className={`${styles.sil} ${w.kept ? "" : styles.silCut}`}
														data-w={w.i}
													>
														{w.text}
													</span>
												) : (
													<span key={w.id} className={styles.word} data-w={w.i}>
														{w.text}{" "}
													</span>
												),
											)}
										</p>
									</span>
								</div>
							</div>
						</div>

						{/* ═══ THE TOOL PALETTE ═══ act two's two tools, in the app's own
				    floating bar. */}
						<div className={styles.palette} aria-hidden="true">
							<span className={`${styles.tool} ${styles.toolWand}`}>
								<Wand2 size={22} />
								<Hand />
							</span>
							<span className={`${styles.tool} ${styles.toolNote}`}>
								<MessageSquare size={22} />
								<Hand />
							</span>
						</div>

						{/* ═══ THE COMPOSITE ═══ */}
						<div className={styles.card} aria-hidden="true">
							<div className={styles.cardClip}>
								<div className={styles.zoomer}>
									<img className={styles.bg} src="/img/walkthrough/canvas-bg-a.jpg" alt="" />
									<img className={styles.bgSwap} src="/img/walkthrough/canvas-bg-b.jpg" alt="" />
									<div className={styles.frame}>
										<div className={styles.chrome}>
											<span className={styles.lights}>
												<span /> <span /> <span />
											</span>
											<span className={styles.omnibox}>bellrock.dev</span>
										</div>
										<div className={styles.viewport}>
											<img
												className={styles.page}
												src="/img/walkthrough/fixture-page.jpg"
												alt=""
												width={1024}
												height={1036}
											/>
										</div>
									</div>
									<MousePointer2 className={styles.shotCursor} size={22} fill="currentColor" />
								</div>
							</div>
							<span className={styles.zoomBadge}>
								<ZoomIn size={10} />
								<span ref={zoomValue} />
							</span>
						</div>

						{/* ═══ THE FLOOR ═══ */}
						<div className={styles.timeline} aria-hidden="true">
							<div className={styles.transport}>
								<span className={styles.time}>
									<span ref={timeValue}>0:00.0</span>
									<span className={styles.timeTotal}> / {TRANSPORT.total}</span>
								</span>
							</div>

							<div className={styles.floorClip}>
								{/* The beds and their hints belong to the viewport, not to the
						    document: an empty lane's shortcut hint stays where the eye
						    left it while 40 seconds of timeline slide underneath. */}
								<div className={styles.beds}>
									{LANES.map((lane) => (
										<div key={lane.id} className={styles.bed} data-lane={lane.id}>
											{lane.hint ? <span className={styles.laneHint}>{lane.hint}</span> : null}
										</div>
									))}
								</div>

								<div className={styles.strip} style={{ width: x(DOC) }}>
									<div className={styles.ruler}>
										{RULER_LABELS.map((label) => (
											<span key={label.sec} className={styles.tick} style={{ left: x(label.sec) }}>
												{label.text}
											</span>
										))}
									</div>

									{LANES.map((lane) => (
										<div key={lane.id} className={styles.lane} data-lane={lane.id}>
											{lane.pills.map((pill, i) => (
												<Pill key={pill.id} pill={pill} index={i} />
											))}
											{/* The note the reader places. The document holds no
									    annotation regions — which is exactly why this lane
									    still shows its "Press A" hint — so it is drawn here
									    rather than read out of `PILLS`. */}
											{lane.id === "annotation" ? (
												<span
													className={`${styles.pill} ${styles.pillNote}`}
													style={{ left: x(NOTE_AT), width: x(NOTE_LEN) }}
												>
													<MessageSquare className={styles.pillGlyph} size={10} />
													New annotation
												</span>
											) : null}
										</div>
									))}

									<div className={styles.clipCard}>
										<svg
											className={styles.wave}
											viewBox={WAVEFORM.viewBox}
											preserveAspectRatio="none"
											focusable="false"
										>
											{WAVE_PATHS.map((p) => (
												<path key={p.opacity} d={p.d} opacity={p.opacity} />
											))}
										</svg>
									</div>
								</div>
							</div>

							<span className={styles.playhead}>
								<span className={styles.playheadHead} />
							</span>
						</div>
					</div>
				</div>
			</section>

			<p className={styles.figcaption}>
				The editor above is redrawn in your browser from the same project file the photographs on
				this page were taken from, and from the design tokens the app ships. The picture inside the
				window is the page that was recorded; the camera track is off in this project, so there is
				no webcam bubble to draw.
			</p>
		</>
	);
}
