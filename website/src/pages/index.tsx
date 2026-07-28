import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import {
	Apple,
	AppWindow,
	Captions,
	Cpu,
	Download,
	HeartHandshake,
	Monitor,
	Pause,
	Scissors,
	SkipBack,
	SkipForward,
	Terminal,
	TerminalSquare,
} from "lucide-react";

import styles from "./index.module.css";

// Static decorative waveform bars for the "multi-track editor" bento card —
// mirrors the real editor's per-clip waveform rendering (thin accent bars
// of varying height inside a rounded, bordered clip block).
const MINI_WAVEFORM_A = [30, 55, 80, 45, 65, 90, 50, 35, 70, 60, 40, 75, 55, 30];
const MINI_WAVEFORM_B = [45, 65, 35, 85, 55, 40, 70, 90, 50, 30, 60, 75, 45, 65, 35, 55];

export default function Home() {
	const { siteConfig } = useDocusaurusContext();

	return (
		<Layout
			title={siteConfig.title}
			description="A free, open-source screen recorder and editor for Windows, macOS, and Linux."
		>
			<header className={styles.hero}>
				<div className={styles.heroInner}>
					<span className={styles.badge}>Pre-release · work in progress</span>
					<Heading as="h1" className={styles.title}>
						OpenScreen
					</Heading>
					<p className={styles.tagline}>
						A free, open-source screen recorder and editor.
						<br />
						Native capture, local AI, no paywall.
					</p>
					<div className={styles.actions}>
						<a
							className={styles.primaryCta}
							href="https://github.com/getopenscreen/openscreen/releases"
						>
							<Download size={16} />
							Download
						</a>
						<Link className={styles.secondaryCta} to="/docs/intro">
							Read the docs
						</Link>
					</div>
					<p className={styles.note}>
						OpenScreen is <strong>not production-grade</strong>. Expect rough edges while we build
						in the open.
					</p>
				</div>
			</header>

			<section className={styles.visualSection}>
				<div className={styles.visual}>
					<div className={styles.visualTopbar}>
						<span className={styles.dots}>
							<span className={styles.dot} />
							<span className={styles.dot} />
							<span className={styles.dot} />
						</span>
						<span className={styles.divider} />
						<span className={styles.segmented}>
							<span>Media</span>
							<span className={styles.segmentedActive}>Edit</span>
							<span>Rec</span>
						</span>
						<span className={styles.savedIndicator}>
							<span className={styles.savedDot} />
							Saved
						</span>
					</div>

					<div className={styles.visualBody}>
						<aside className={styles.agentPanel}>
							<div className={styles.agentHeader}>
								<span>OpenScreen Agent</span>
								<span className={styles.contextBadge}>0% context</span>
							</div>
							<div className={styles.chatBubbleUser}>
								Clean up the intro — there&apos;s dead air while I read my notes.
							</div>
							<div className={styles.chatBubbleAssistant}>
								<div className={styles.chatMeta}>OpenScreen · 10:41</div>
								On it — scanning track 1 for silences now. I&apos;ll flag anything over 600ms.
							</div>
							<div className={styles.chipRow}>
								<span className={styles.chip}>Remove silences</span>
								<span className={styles.chip}>Add captions</span>
							</div>
						</aside>

						<div className={styles.stage}>
							<div className={styles.stageFrame}>
								<div className={styles.stagePreview}>
									<span className={styles.timeBadge}>00:00:12.4</span>
								</div>
								<div className={styles.transport}>
									<SkipBack size={13} />
									<span className={styles.playButton}>
										<Pause size={13} />
									</span>
									<SkipForward size={13} />
									<span className={styles.transportTime}>
										0:12.4<span className={styles.meta}> / </span>
										<span className={styles.muted}>7:03.6</span>
									</span>
								</div>
							</div>
							<div className={styles.timeline}>
								<div className={styles.timelineRuler}>
									<span>0:00</span>
									<span>1:00</span>
									<span>2:00</span>
								</div>
								<div className={styles.timelineTrack}>
									<span
										className={`${styles.pill} ${styles.pillAccent}`}
										style={{ left: "12%", width: "9%" }}
									>
										1.8×
									</span>
									<span
										className={`${styles.pill} ${styles.pillAnnotation}`}
										style={{ left: "55%", width: "10%" }}
									>
										Note
									</span>
								</div>
								<div className={styles.timelineTrack}>
									<span
										className={`${styles.pill} ${styles.pillDanger}`}
										style={{ left: "30%", width: "14%" }}
									>
										0:12.0
									</span>
								</div>
								<div className={styles.clipRow}>
									<div className={styles.clipActive} />
									<div className={styles.clip} />
								</div>
							</div>
						</div>
					</div>
				</div>
			</section>

			<section className={styles.features}>
				<div className={styles.featuresInner}>
					<div className={styles.sectionKicker}>Why OpenScreen</div>
					<Heading as="h2" className={styles.sectionTitle}>
						Recorder-first. AI, if you want it.
					</Heading>

					<div className={styles.bento}>
						<article className={`${styles.card} ${styles.bentoLarge}`}>
							<div className={styles.cardHeader}>
								<span className={styles.iconBadge}>
									<Scissors size={17} />
								</span>
								<h3>A real multi-track editor</h3>
							</div>
							<p>
								Trim, split, and layer clips on a proper timeline. Captions, cursor smoothing,
								zooms, and webcam picture-in-picture.
							</p>
							<div className={styles.miniTimeline}>
								<div className={styles.miniClipsRow}>
									<div className={styles.miniClip} style={{ flex: 5 }}>
										<div className={styles.miniWaveform}>
											{MINI_WAVEFORM_A.map((h, i) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: static decorative bars
												<span key={i} style={{ height: `${h}%` }} />
											))}
										</div>
									</div>
									<div className={styles.miniClip} style={{ flex: 6 }}>
										<div className={styles.miniWaveform}>
											{MINI_WAVEFORM_B.map((h, i) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: static decorative bars
												<span key={i} style={{ height: `${h}%` }} />
											))}
										</div>
									</div>
								</div>
								<div className={styles.miniTrack}>
									<span
										className={`${styles.miniRegion} ${styles.pillAccent}`}
										style={{ left: "10%", width: "16%" }}
									/>
									<span
										className={`${styles.miniRegion} ${styles.pillSpeed}`}
										style={{ left: "32%", width: "12%" }}
									/>
									<span
										className={`${styles.miniRegion} ${styles.pillAnnotation}`}
										style={{ left: "58%", width: "20%" }}
									/>
								</div>
							</div>
							<div className={styles.cardPills}>
								<span className={`${styles.pillStatic} ${styles.pillAccent}`}>Zoom</span>
								<span className={`${styles.pillStatic} ${styles.pillSpeed}`}>1.5×</span>
								<span className={`${styles.pillStatic} ${styles.pillAnnotation}`}>Caption</span>
							</div>
						</article>

						<article className={`${styles.card} ${styles.bentoAi}`}>
							<span className={styles.iconBadge}>
								<Cpu size={17} />
							</span>
							<h3>AI, opt-in</h3>
							<p>
								Whisper runs locally for captions — no upload, no cloud. Chat-based editing with
								your own LLM key is there if you want it, off unless you connect a provider.
							</p>
						</article>

						<article className={`${styles.card} ${styles.bentoNative}`}>
							<span className={styles.iconBadge}>
								<Monitor size={17} />
							</span>
							<h3>Native capture</h3>
							<p>
								ScreenCaptureKit on macOS, Windows Graphics Capture on Windows. No Electron
								screen-grab hacks.
							</p>
						</article>

						<article className={`${styles.card} ${styles.bentoFree}`}>
							<span className={styles.iconBadge}>
								<HeartHandshake size={17} />
							</span>
							<h3>MIT, free forever</h3>
							<p>
								No paywalls, no premium tier, no usage caps. Every feature ships free for personal
								and commercial use.
							</p>
						</article>

						<article className={`${styles.card} ${styles.bentoCaptions}`}>
							<span className={styles.iconBadge}>
								<Captions size={17} />
							</span>
							<div>
								<h3>Captions in 13 languages, on-device</h3>
								<p>
									Automatic transcription with local Whisper — no upload, works offline. Arabic,
									English, Spanish, French, Italian, Japanese, Korean, Portuguese, Russian, Turkish,
									Vietnamese, and both Chinese scripts.
								</p>
							</div>
						</article>
					</div>
				</div>
			</section>

			<section className={styles.quickStart}>
				<div className={styles.quickStartInner}>
					<div className={styles.sectionKicker}>Quick start</div>
					<Heading as="h2" className={styles.sectionTitleSm}>
						Download, or build from source
					</Heading>

					<div className={styles.terminal}>
						<div className={styles.terminalHeader}>
							<Terminal size={14} />
							<span>Linux (Debian / Ubuntu)</span>
						</div>
						<pre className={styles.terminalBody}>
							<span className={styles.meta}># download the .deb from Releases, then</span>
							{"\n"}
							<span className={styles.accentText}>sudo</span> apt install
							./Openscreen-Linux-latest.deb
						</pre>
					</div>

					<p className={styles.quickStartNote}>
						Also available for macOS (.dmg) and Windows (.exe) — see the{" "}
						<a href="https://github.com/getopenscreen/openscreen/releases">Releases page</a>.
					</p>
				</div>
			</section>

			<section className={styles.platformStrip}>
				<div className={styles.platformStripInner}>
					<div className={styles.platformCard}>
						<div className={styles.platformHeader}>
							<Apple size={16} />
							<span>macOS</span>
						</div>
						<p>ScreenCaptureKit native capture, real cursor + click effects, native webcam.</p>
					</div>
					<div className={styles.platformCard}>
						<div className={styles.platformHeader}>
							<AppWindow size={16} />
							<span>Windows</span>
						</div>
						<p>Windows Graphics Capture, system audio out of the box, native webcam.</p>
					</div>
					<div className={styles.platformCard}>
						<div className={styles.platformHeader}>
							<TerminalSquare size={16} />
							<span>Linux</span>
						</div>
						<p>
							.deb, .pacman, AppImage, and Nix. Browser-pipeline capture; needs PipeWire for system
							audio.
						</p>
					</div>
				</div>
			</section>
		</Layout>
	);
}
