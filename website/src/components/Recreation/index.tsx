/**
 * The OpenScreen editor, recreated — live DOM chrome around real footage of the
 * recording being edited.
 *
 * Every string, number and percentage below comes from `generated.ts`, which
 * `scripts/gen-recreation.mjs` emits by reading the project document
 * (`fixture-slim.json`, schemaVersion 7), the app's own locale files, and the
 * app's own `formatSec` / `effectiveZoomScale` / `buildClipSection`, imported
 * and run. Nothing here is typed by hand. If the document is re-cut, the
 * generator moves the pills, the transcript, the ruler and the agent's
 * timecodes together, and `--check` fails the build if they have drifted.
 *
 * ── THE TWO CLOCKS ───────────────────────────────────────────────────────────
 *
 * MEDIA CLOCK  → `driver.ts`. `video.currentTime` owns the transport digits,
 *                the playhead, the transport rail, the cue underline, the
 *                pointer, the zoom lane's lift and the play glyph.
 * SCROLL CLOCK → `styles.module.css`. The view-timeline `--os-cam` owns the
 *                camera and the presence of the edit-history objects.
 *
 * This file renders once and never again. It holds no state, sets no state,
 * and reads neither clock: it hands eight refs to the driver and gets out of
 * the way. React is not in the frame loop.
 *
 * ── ACCESSIBILITY ────────────────────────────────────────────────────────────
 *
 * No `role="img"`: browsers apply `role="presentation"` to every descendant of
 * an element with the img role, which would make 433 nodes semantically
 * identical to the JPEG they replace, at ten times the markup and none of the
 * compression. There is no middle setting.
 *
 * No focusable node, anywhere. The app's silence marker is a real `<button>`
 * with `title="Trim silence (2.2s)"`; recreated as a control it becomes a tab
 * stop that announces an action this page will never perform — a lie told
 * exclusively to the readers least able to check it. Every marker, glyph, pill
 * and composer here is a `<span>`.
 *
 * One state, not a mutating one. The tree is fixed at the CLOSING, post-agent
 * state: two trims applied, the reply present, two markers struck. The
 * pre-agent elements the animation shows first (`emptyChat`) are `aria-hidden`
 * for their whole lifetime; the elements that arrive are exposed from the
 * start. What moves is opacity, not the tree. No live region, nothing
 * announced, nothing flipping under a linear reader.
 *
 * Exposed: the transcript (103 words + 3 silence markers, real selectable
 * text), its heading and clip range, both chat messages with their author
 * labels, the applied line, the five pill labels, the three lane hints, and
 * all five claims. Hidden: the toolbar, transport, ruler, lane backgrounds,
 * clip card, waveform, playhead, nav strip, facet rail, composer, wallpaper,
 * pointer and the `<video>`.
 */

import { useEffect, useRef } from "react";

import {
	Captions,
	ChevronRight,
	Clock,
	Copy,
	Crosshair,
	FileText,
	Film,
	Image,
	Maximize2,
	MessageSquare,
	MousePointer2,
	PanelLeftClose,
	PanelTop,
	Pause,
	Pencil,
	Play,
	Scissors,
	SendHorizontal,
	SkipBack,
	SkipForward,
	SlidersHorizontal,
	SplitSquareHorizontal,
	Trash2,
	Wand2,
	ZoomIn,
} from "lucide-react";

import { BANDS } from "../Walkthrough/bands";
import { attachDriver } from "./driver";
import {
	CHAT,
	INSPECTOR,
	LANES,
	LOOP,
	PILLS,
	RULER,
	STAGE,
	TOOLBAR,
	TRANSPORT,
	WAVEFORM,
	WORDS,
	type RecreationPill,
} from "./generated";
import styles from "./styles.module.css";

/* ── the copy, from the one file the section keeps its words in ───────────── */

const BAND = Object.fromEntries(BANDS.map((band) => [band.id, band]));

/** The four acts that quote a band, in the order the camera visits them. */
const ACTS = [
	{ cls: styles.act1, band: BAND["band-captions"] },
	{ cls: styles.act2, band: BAND["band-record"] },
	{ cls: styles.act3, band: BAND["band-agent"] },
	{ cls: styles.act4, band: BAND["band-timeline"] },
] as const;

/** The one silence the agent left alone, and the two it cut — both read off
 *  the document rather than typed, so the closing sentence cannot outlive the
 *  edit it describes. */
const SILENCES = WORDS.filter((w) => w.kind === "silence");
const CUT_SILENCES = SILENCES.filter((w) => !w.kept);
const KEPT_SILENCE = SILENCES.find((w) => w.kept);
const KEPT_SILENCE_SEC = KEPT_SILENCE
	? (KEPT_SILENCE.endSec - KEPT_SILENCE.startSec).toFixed(1)
	: "0.0";

const CLOSING = `Same panel, one scroll later. ${
	CUT_SILENCES.length === 2 ? "Two" : String(CUT_SILENCES.length)
} spans struck out — and the ${KEPT_SILENCE_SEC}s gap left exactly where it was, because nothing under a second qualified.`;

const FIGCAPTION =
	`OpenScreen 1.9 — the editor redrawn in your browser from the project file the photograph above was taken from. ` +
	`The picture in the canvas and the pointer's path are the recording; the camera track is off in this project, so there is no webcam bubble to draw.`;

/* ── the ruler ────────────────────────────────────────────────────────────── */

const RULER_NARROW = RULER.variants[0];
const RULER_WIDE = RULER.variants[1];
/** The 20 odd-second labels the 1s step adds at >=3043px. The 21 even ones are
 *  shared with the 2s step, so only these are conditional. */
const ODD_LABELS = RULER_WIDE.labels.filter((label) => label.sec % 2 === 1);

/* ── the waveform ─────────────────────────────────────────────────────────── */

/** Two of the five buckets are empty — this recording peaks at 0.4787, so the
 *  app's own `0.5 + amp*0.5` never reaches 0.8. Skipping them costs nothing and
 *  keeps the bucket table honest about why. */
const WAVE_PATHS = WAVEFORM.paths.filter((p) => p.bars > 0);

/* ── the chat ─────────────────────────────────────────────────────────────── */

type ReplyBlock = (typeof CHAT.agentReply)[number];

/** Consecutive `li` blocks become one `<ul>`; everything else is a `<p>`. */
function groupReply(blocks: readonly ReplyBlock[]): Array<{ list: boolean; items: ReplyBlock[] }> {
	const out: Array<{ list: boolean; items: ReplyBlock[] }> = [];
	for (const block of blocks) {
		const list = block.kind === "li";
		const tail = out[out.length - 1];
		if (tail && tail.list === list && list) tail.items.push(block);
		else out.push({ list, items: [block] });
	}
	return out;
}

/** A plain run is a text node, not a `<span>`: eight of the reply's thirteen
 *  runs carry no emphasis, and a wrapper that styles nothing is eight elements
 *  of load cost for nothing. */
function Runs({ block }: { block: ReplyBlock }) {
	return <>{block.runs.map((run, i) => (run.strong ? <strong key={i}>{run.text}</strong> : run.text))}</>;
}

/* ── pills ────────────────────────────────────────────────────────────────── */

function Pill({ pill }: { pill: RecreationPill }) {
	const trim = pill.lane === "trim";
	return (
		<span
			className={`${styles.pill} ${trim ? styles.pillTrim : ""}`}
			style={{ left: `${pill.leftPct}%`, width: `${pill.widthPct}%` }}
		>
			{/* The glyph's own <svg> carries the class — a wrapper span around an
			    element that is already one node is one node too many, five times
			    over. */}
			{trim ? (
				<Scissors className={styles.pillGlyph} size={11} aria-hidden="true" />
			) : (
				<ZoomIn className={styles.pillGlyph} size={11} aria-hidden="true" />
			)}
			{pill.label}
		</span>
	);
}

/* ── the component ────────────────────────────────────────────────────────── */

export default function Recreation() {
	const band = useRef<HTMLElement | null>(null);
	const video = useRef<HTMLVideoElement | null>(null);
	const timeReadout = useRef<HTMLSpanElement | null>(null);
	const transport = useRef<HTMLDivElement | null>(null);
	const playhead = useRef<HTMLSpanElement | null>(null);
	const scrubFill = useRef<HTMLSpanElement | null>(null);
	const cursor = useRef<SVGSVGElement | null>(null);
	const zoomLane = useRef<HTMLDivElement | null>(null);
	const flow = useRef<HTMLParagraphElement | null>(null);

	useEffect(() => {
		const refs = {
			band: band.current,
			video: video.current,
			timeReadout: timeReadout.current,
			transport: transport.current,
			playhead: playhead.current,
			scrubFill: scrubFill.current,
			cursor: cursor.current as unknown as HTMLElement | null,
			zoomLane: zoomLane.current,
			flow: flow.current,
		};
		if (Object.values(refs).some((el) => el === null)) return;
		return attachDriver(refs as Parameters<typeof attachDriver>[0], {
			cue: styles.cue,
			lift: styles.laneLift,
		});
	}, []);

	return (
		<section className={styles.band} ref={band} data-recreation="">
			<div className={styles.stage}>
				<div className={styles.world}>
					{/* ═══ THE SCENE ═══ */}
					<div className={styles.scene}>
						{/* ── chat column ── */}
						<div className={styles.chat}>
							<div className={styles.chatStrip} aria-hidden="true">
								<span className={styles.chatTitle}>{CHAT.conversationTitle}</span>
								<span className={styles.stripActions}>
									<span>
										<PanelLeftClose size={13} />
									</span>
									<span>
										<Trash2 size={13} />
									</span>
								</span>
							</div>

							<div className={styles.chatScroll}>
								{/* The app's real empty state, and the only pre-agent element
								    in the scene. `aria-hidden` for its whole lifetime: it is
								    what the panel looked like before, and a linear reader must
								    not meet both it and the reply. */}
								<p className={styles.emptyChat} aria-hidden="true">
									{CHAT.emptyState}
								</p>

								<div className={`${styles.msg} ${styles.msgUser}`}>
									<div className={styles.msgHead}>
										<span className={styles.msgAuthor}>{CHAT.authorUser}</span>
									</div>
									<div className={styles.msgBubble}>
										<p>{CHAT.userPrompt}</p>
									</div>
								</div>

								<div className={`${styles.msg} ${styles.msgAgent}`}>
									<div className={styles.msgHead}>
										<span className={styles.msgAuthor}>{CHAT.authorAssistant}</span>
										<span className={styles.stripActions} aria-hidden="true">
											<span>
												<Copy size={12} />
											</span>
										</span>
									</div>
									<div className={styles.msgBubble}>
										{groupReply(CHAT.agentReply).map((group, gi) =>
											group.list ? (
												<ul key={gi}>
													{group.items.map((block, i) => (
														<li key={i}>
															<Runs block={block} />
														</li>
													))}
												</ul>
											) : (
												<p key={gi}>
													<Runs block={group.items[0]} />
												</p>
											),
										)}
									</div>
								</div>

								<p className={styles.applied}>{CHAT.applied}</p>
							</div>

							<div className={styles.composer} aria-hidden="true">
								<span className={styles.composerBox}>{CHAT.composerPlaceholder}</span>
								<div className={styles.composerRow}>
									<span className={styles.modelChip}>{CHAT.modelChip}</span>
									<span className={styles.sendGlyph}>
										<SendHorizontal size={16} />
									</span>
								</div>
							</div>
						</div>

						{/* ── the stage: wallpaper, recording, pointer, inspector ── */}
						<div className={styles.stageCol}>
							<div className={styles.frame} aria-hidden="true">
								<span className={styles.wallpaper} />
								<div className={styles.screen}>
									{/*
									  The recording, pre-cropped to zoomRanges[1]'s own 2.20x
									  framing, so the picture, the 2.20x pill and the playhead
									  are three renderings of one fact and no frame can
									  contradict the chrome around it.

									  No `src`: the driver sets it, and only once the band is
									  within a viewport of the screen. With `preload="none"` and
									  a poster, a reader with no JavaScript — and a phone, where
									  the band is `display: none` — fetches zero video bytes and
									  sees a real frame of the recording at t = 17.5 s.
									*/}
									<video
										ref={video}
										className={styles.clip}
										poster={LOOP.poster}
										width={LOOP.width}
										height={LOOP.height}
										muted
										loop
										playsInline
										preload="none"
										aria-hidden="true"
										tabIndex={-1}
										disableRemotePlayback
									/>
									{/* Positioned by the media clock from the recording's own
									    cursor telemetry. See driver.ts. */}
									<svg
										ref={cursor}
										className={styles.cursor}
										viewBox="0 0 24 24"
										width="22"
										height="22"
										aria-hidden="true"
										focusable="false"
									>
										<path
											d="M5.5 3.2 19 12.4l-5.9.7 3 6.3-2.5 1.2-3-6.4-4.1 4.3z"
											fill="#f5f7fa"
											stroke="#101318"
											strokeWidth="1.4"
											strokeLinejoin="round"
										/>
									</svg>
								</div>
							</div>

							<div className={styles.inspectorWrap}>
								<div className={styles.inspector}>
									<div className={styles.inspectorHead}>
										<h3 className={styles.inspectorTitle}>{INSPECTOR.title}</h3>
										<span className={styles.inspectorChevron} aria-hidden="true">
											<ChevronRight size={14} />
										</span>
									</div>
									<div className={styles.inspectorBody}>
										<div className={styles.clipHead}>
											<span className={styles.clipBadge} aria-hidden="true">
												{INSPECTOR.indexBadge}
											</span>
											<span>
												<span className={styles.clipName}>{INSPECTOR.filename}</span>
												<span className={styles.clipRange}>{INSPECTOR.clipRange}</span>
											</span>
										</div>

										{/* 103 words and 3 silence markers, in the order
										    `buildClipSection` produced them. `data-w` is the index
										    into WORDS, so the cue is addressed by integer and never
										    matched by text. */}
										<p className={styles.flow} ref={flow}>
											{WORDS.map((w) =>
												w.kind === "silence" ? (
													<span
														key={w.id}
														className={`${styles.sil} ${w.kept ? "" : styles.silCut}`}
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
									</div>
								</div>

								{/* `FloatingInspector.tsx`'s six facets, plus the edit-clip
								    button that sits under them — seven glyphs, which is what
								    `editor-1560.jpg` shows. */}
								<div className={styles.facetRail} aria-hidden="true">
									<span className={styles.facet}>
										<Image size={17} />
									</span>
									<span className={styles.facet}>
										<SlidersHorizontal size={17} />
									</span>
									<span className={styles.facet}>
										<PanelTop size={17} />
									</span>
									<span className={styles.facet}>
										<MousePointer2 size={17} />
									</span>
									<span className={styles.facet}>
										<Captions size={17} />
									</span>
									<span className={`${styles.facet} ${styles.facetOn}`}>
										<FileText size={17} />
									</span>
									<span className={styles.facet}>
										<Pencil size={17} />
									</span>
								</div>
							</div>
						</div>
					</div>

					{/* ═══ THE FLOOR ═══ */}
					<div className={styles.floor}>
						<div className={styles.toolbar} aria-hidden="true">
							<span className={styles.tools}>
								<span className={styles.tool}>
									<Wand2 size={15} />
								</span>
								<span className={styles.toolSep} />
								<span className={styles.tool}>
									<SplitSquareHorizontal size={15} />
								</span>
								<span className={styles.tool}>
									<MessageSquare size={15} />
								</span>
								<span className={styles.tool}>
									<Clock size={15} />
								</span>
								<span className={styles.tool}>
									<ZoomIn size={15} />
								</span>
								<span className={`${styles.tool} ${styles.toolOn}`}>
									<Crosshair size={15} />
								</span>
								<span className={styles.tool}>
									<Maximize2 size={15} />
								</span>
								<span className={styles.toolSep} />
							</span>
							<span className={styles.aspect}>{TOOLBAR.aspectRatio}</span>

							<div className={styles.transport} ref={transport} data-playing="false">
								<span className={styles.playBtn}>
									<Play size={13} fill="currentColor" />
									<Pause size={13} fill="currentColor" />
								</span>
								<span className={styles.skip}>
									<SkipBack size={14} />
								</span>
								<span className={styles.skip}>
									<SkipForward size={14} />
								</span>
								<span className={styles.time}>
									<span ref={timeReadout}>{TRANSPORT.restCurrent}</span>
									<span className={styles.timeTotal}> / {TRANSPORT.total}</span>
								</span>
								<span className={styles.scrubRail}>
									<span className={styles.scrubFill} ref={scrubFill}>
										<span className={styles.scrubKnob} />
									</span>
								</span>
							</div>

							<span className={styles.kbdHints}>
								<span className={styles.kbdHint}>
									<span className={styles.kbd}>{TOOLBAR.panKbd}</span> {TOOLBAR.panLabel}
								</span>
								<span className={styles.kbdHint}>
									<span className={styles.kbd}>{TOOLBAR.zoomKbd}</span> {TOOLBAR.zoomLabel}
								</span>
							</span>
						</div>

						<div className={styles.floorBody}>
							<div className={styles.rulerRow} aria-hidden="true">
								{/* The minor ticks are the element's own background gradient.
								    Only the 21 major labels are nodes. */}
								<div className={styles.ruler}>
									{RULER_NARROW.labels.map((label) => (
										<span
											key={label.sec}
											className={styles.tickLabel}
											style={{ left: `${label.leftPct}%` }}
										>
											{label.text}
										</span>
									))}
									{ODD_LABELS.map((label) => (
										<span
											key={label.sec}
											className={`${styles.tickLabel} ${styles.tickOdd}`}
											style={{ left: `${label.leftPct}%` }}
										>
											{label.text}
										</span>
									))}
								</div>
							</div>

							<div className={styles.tracks}>
								{LANES.map((lane) => (
									<div
										key={lane.id}
										className={styles.lane}
										ref={lane.id === "zoom" ? zoomLane : undefined}
									>
										{lane.hint ? <span className={styles.laneHint}>{lane.hint}</span> : null}
										{lane.pills.map((pill) => (
											<Pill key={pill.id} pill={pill} />
										))}
									</div>
								))}

								<div className={styles.clipRow} aria-hidden="true">
									<div className={styles.clipCard}>
										<span className={styles.clipChip}>
											<span className={styles.clipChipIcon}>
												<Film size={11} />
											</span>
											<span className={styles.clipChipName}>{TOOLBAR.clipLabel}</span>
										</span>
										<svg
											className={styles.wave}
											viewBox={WAVEFORM.viewBox}
											preserveAspectRatio="none"
											aria-hidden="true"
											focusable="false"
										>
											{WAVE_PATHS.map((p) => (
												<path key={p.opacity} d={p.d} opacity={p.opacity} />
											))}
										</svg>
									</div>
								</div>
							</div>

							<div className={styles.playheadLayer} aria-hidden="true">
								<span className={styles.playhead} ref={playhead}>
									<span className={styles.playheadHead} />
								</span>
							</div>
						</div>

						<div className={styles.nav} aria-hidden="true">
							<span className={styles.navTrack} />
							<span className={styles.navWindow} />
						</div>
					</div>
				</div>
			</div>

			{/* ═══ THE COPY ═══
			    Ordinary flow content that becomes a pinned, cross-fading overlay
			    only where the scroll clock exists. Nothing below is gated by the
			    scroll: it is synchronised to it. */}
			<div className={styles.script}>
				{ACTS.map(({ cls, band: b }) => (
					<article key={b.id} className={`${styles.act} ${cls}`}>
						<p className={styles.actKicker}>{b.kicker}</p>
						<h3 className={styles.actClaim}>{b.claim}</h3>
						<p className={styles.actBody}>{b.body}</p>
						<p className={styles.actFact}>{b.fact}</p>
					</article>
				))}

				<article className={`${styles.act} ${styles.act5}`}>
					<p className={styles.actKicker}>the cut</p>
					<h3 className={styles.actClaim}>{CLOSING}</h3>
					<p className={styles.actFact}>
						{STAGE.aspectRatio} · {LOOP.zoomScale.toFixed(2)}× · {PILLS.length} regions ·{" "}
						{INSPECTOR.wordCount} words
					</p>
				</article>

				<p className={styles.figcaption}>{FIGCAPTION}</p>
			</div>
		</section>
	);
}
