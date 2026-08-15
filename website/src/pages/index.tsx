import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import { Apple, AppWindow, Cpu, Download, HeartHandshake, Monitor, TerminalSquare } from "lucide-react";

import Walkthrough from "../components/Walkthrough";
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
					<span className={styles.badge}>Pre-release · work in progress</span>
					{/* The descriptor sits inside the h1 rather than in the paragraph
					    below it: the brand name alone gave the page's only h1 no
					    subject. Rendered as a block at the old tagline's size, so the
					    visual hierarchy is unchanged — big wordmark, descriptor under it. */}
					<Heading as="h1" className={styles.title}>
						OpenScreen
						<span className={styles.titleTagline}>
							A free, open-source screen recorder and video editor
						</span>
					</Heading>
					<p className={styles.tagline}>Native capture, local AI, no paywall.</p>
					<div className={styles.actions}>
						<Link className={styles.primaryCta} to="/download">
							<Download size={16} />
							Download
						</Link>
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

			<Walkthrough />

			<section className={styles.features}>
				<div className={styles.featuresInner}>
					<div className={styles.sectionKicker}>Also true</div>
					<Heading as="h2" className={styles.sectionTitle}>
						Three things a clip can&apos;t show.
					</Heading>

					<div className={styles.bento}>
						<article className={styles.card}>
							<span className={styles.iconBadge}>
								<HeartHandshake size={17} />
							</span>
							<h3>MIT, free forever</h3>
							<p>
								No paywalls, no premium tier, no usage caps. Every feature ships free for personal
								and commercial use.
							</p>
						</article>

						<article className={styles.card}>
							<span className={styles.iconBadge}>
								<Cpu size={17} />
							</span>
							<h3>Nothing is uploaded</h3>
							<p>
								Recording, transcription and rendering all happen on your machine. The chat panel is
								the only part that talks to a network, and only with a key you supply.
							</p>
						</article>

						<article className={styles.card}>
							<span className={styles.iconBadge}>
								<Monitor size={17} />
							</span>
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
					<Heading as="h2" className={styles.sectionTitleSm}>
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
