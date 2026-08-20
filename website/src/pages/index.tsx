import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import { Apple, AppWindow, ArrowDown, CircleCheck, Download, TerminalSquare } from "lucide-react";

import Editor from "../components/Editor";
import Showcase from "../components/Showcase";
import { jsonLd, softwareApplicationLd } from "../lib/structured-data";
import styles from "./index.module.css";

export default function Home() {
	return (
		<Layout
			title="Free open-source screen recorder & video editor"
			description="OpenScreen is a free, open-source screen recorder and video editor for Windows, macOS, and Linux — native capture, on-device captions, no watermarks."
		>
			<Head>
				{/* The product entity, distinct from the Organization/WebSite pair
				    emitted site-wide from docusaurus.config.ts. */}
				<script type="application/ld+json">{jsonLd(softwareApplicationLd())}</script>
			</Head>
			<header className={styles.hero}>
				<div className={styles.heroInner}>
					<p className={styles.badgeRow}>
						<span className={styles.badgeNew}>NEW</span>
						<span className={styles.badgeText}>Export faster</span>
					</p>
					{/* The product's name, not a claim about it. The design opens on
					    "Screen Recording / Reimagined", which is the one line on a page
					    that spends its whole length proving specific things — the editor
					    runs live, the model is 264 MB, every edit is undoable — that
					    proves nothing. It also left the strongest on-page signal there is
					    without the word people search once they have heard of us. */}
					<Heading as="h1" className={styles.title}>
						OpenScreen
						<span className={styles.titleTagline}>
							A free, open-source screen recorder and video editor
						</span>
					</Heading>
					<p className={styles.tagline}>Native capture, local AI, no paywall.</p>
					<div className={styles.actions}>
						{/* Not "Download for macOS". This page's own trio says Windows, macOS
						    and Linux, and /download offers a .dmg, an .exe, a .deb, an .rpm, a
						    .pacman, an AppImage and a Nix flake. The label is static, so it was
						    not adapting to the reader either: it simply told two of the three
						    platforms that the page's main action was not for them. */}
						<Link className={styles.primaryCta} to="/download">
							<Download size={16} />
							Download
						</Link>
						<Link className={styles.secondaryCta} to="/docs/intro">
							Read the docs
						</Link>
					</div>
				</div>

				{/* An affordance, not a claim. It said "the scrollbar is the timeline",
				    which is true and is still the wrong job for this line: what a
				    reader needs at the fold is to know there is more below, and a
				    sentence is a worse signal for that than an arrow. The design pins
				    it to the bottom of the screen with a down arrow beside it, which
				    is also what makes it read as an edge rather than as a caption. */}
				<p className={styles.scrollHint}>
					<ArrowDown size={15} strokeWidth={2} />
					Scroll down
				</p>
			</header>

			{/* The argument, immediately after the hero. */}
			<Editor />

			{/* The claims the editor cannot make on its own. */}
			<Showcase />

			<section className={styles.features}>
				<div className={styles.featuresInner}>
					<div className={styles.sectionKicker}>Also true</div>
					{/* Capabilities are the section above; these three are properties,
					    and no screenshot of the application can establish any of them —
					    which is why they get one repeated tick instead of three
					    illustrations pretending to show something. */}
					<Heading as="h2" className={styles.sectionTitle}>
						Three things a screenshot can&apos;t show.
					</Heading>

					<div className={styles.trio}>
						<article className={styles.trioItem}>
							<CircleCheck className={styles.trioTick} size={21} />
							<h3>MIT, free forever</h3>
							<p>
								No paywalls, no premium tier, no usage caps. Every feature ships free for personal
								and commercial use.
							</p>
						</article>

						<article className={styles.trioItem}>
							<CircleCheck className={styles.trioTick} size={21} />
							<h3>Nothing is uploaded</h3>
							<p>
								Recording, transcription and rendering all happen on your machine, and your video
								never leaves it. Text leaves only when you ask: the chat panel and caption
								translation, each with a key you supply. Transcription downloads its 264 MB Whisper
								model once, on first run.
							</p>
						</article>

						<article className={styles.trioItem}>
							<CircleCheck className={styles.trioTick} size={21} />
							<h3>Windows, macOS, Linux</h3>
							<p>
								One source tree, native capture on each. A .dmg, an .exe, a .deb, a .rpm, a .pacman,
								an AppImage and a Nix flake.
							</p>
						</article>
					</div>
				</div>
			</section>

			<section className={styles.quickStart} id="download-install">
				<div className={styles.quickStartInner}>
					<div className={styles.sectionKicker}>Quick start</div>
					<Heading as="h2" className={styles.sectionTitle}>
						Download and install
					</Heading>

					{/* One pane per platform, same chrome and same weight. An earlier
					    version showed only the Linux command with the other two in a
					    footnote, which read at a glance as "Linux only". */}
					<div className={styles.installGrid}>
						<div className={styles.terminal}>
							<div className={styles.terminalHeader}>
								<Apple size={14} />
								<span>macOS</span>
								<span className={styles.artifactChip}>.dmg</span>
							</div>
							<pre className={styles.terminalBody}>
								<span className={styles.meta}># drag OpenScreen to Applications, then</span>
								{"\n"}
								<span className={styles.accentText}>xattr</span> -rd com.apple.quarantine
								/Applications/Openscreen.app
							</pre>
							<p className={styles.paneFoot}>
								ScreenCaptureKit native capture, real cursor + click effects, native webcam.
							</p>
						</div>

						<div className={styles.terminal}>
							<div className={styles.terminalHeader}>
								<AppWindow size={14} />
								<span>Windows</span>
								<span className={styles.artifactChip}>.exe</span>
							</div>
							<pre className={styles.terminalBody}>
								<span className={styles.meta}># run the installer</span>
								{"\n"}
								<span className={styles.plainAction}>Nothing to type — double-click and go.</span>
							</pre>
							<p className={styles.paneFoot}>
								Windows Graphics Capture, system audio out of the box, native webcam.
							</p>
						</div>

						<div className={styles.terminal}>
							<div className={styles.terminalHeader}>
								<TerminalSquare size={14} />
								<span>Linux</span>
								<span className={styles.artifactChip}>.deb</span>
							</div>
							<pre className={styles.terminalBody}>
								<span className={styles.meta}># download the .deb from Releases, then</span>
								{"\n"}
								<span className={styles.accentText}>sudo</span> apt install ./Openscreen-Linux-*.deb
							</pre>
							<p className={styles.paneFoot}>
								Browser-pipeline capture; needs PipeWire for system audio.
							</p>
						</div>
					</div>

					<p className={styles.quickStartNote}>
						The macOS line is only needed if Gatekeeper blocks the app. Linux also ships{" "}
						<code>.rpm</code>, <code>.pacman</code>, an AppImage, and a Nix flake — every artifact
						is on the{" "}
						<a href="https://github.com/getopenscreen/openscreen/releases">Releases page</a>, and{" "}
						<Link to="/docs/installation">Installation</Link> has the full steps.
					</p>
				</div>
			</section>
		</Layout>
	);
}
