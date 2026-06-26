import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";

import styles from "./index.module.css";

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
							Download
						</a>
						<a className={styles.secondaryCta} href="/openscreen/docs/intro">
							Read the docs
						</a>
					</div>
					<p className={styles.note}>
						OpenScreen is <strong>not production-grade</strong>. Expect rough edges while we build
						in the open.
					</p>
				</div>
			</header>

			<section className={styles.features}>
				<div className={styles.featuresInner}>
					<article className={styles.feature}>
						<h3>Native capture</h3>
						<p>
							ScreenCaptureKit on macOS, Windows Graphics Capture on Windows. No Electron hacks, no
							ffmpeg screen grab.
						</p>
					</article>
					<article className={styles.feature}>
						<h3>Real editor</h3>
						<p>
							Multi-track timeline, captions, cursor smoothing, webcam compositing — built on
							Pixi.js.
						</p>
					</article>
					<article className={styles.feature}>
						<h3>AI opt-in</h3>
						<p>
							Whisper runs locally for transcription. Bring your own LLM key if you want captions or
							summaries.
						</p>
					</article>
				</div>
			</section>
		</Layout>
	);
}
