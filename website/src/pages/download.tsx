import Link from "@docusaurus/Link";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import { Apple, AppWindow, Download, Package, ShieldCheck, TerminalSquare } from "lucide-react";

import styles from "./download.module.css";

const REPO_URL = "https://github.com/getopenscreen/openscreen";

// Every published asset carries the version in its filename
// (Openscreen-Mac-arm64-1.7.0.dmg), so there is no stable per-asset URL to deep
// link to. A build-time lookup of the current release would go stale silently:
// the docs workflow only fires on website/** changes, so a new app release
// would not rebuild this page and it would keep advertising the previous
// version. /releases/latest is resolved by GitHub on every click instead, which
// is always correct at the cost of one extra hop.
const LATEST = `${REPO_URL}/releases/latest`;

const PLATFORMS = [
	{
		id: "macos",
		name: "macOS",
		icon: Apple,
		artifact: ".dmg",
		blurb:
			"Separate builds for Apple Silicon and Intel. Native ScreenCaptureKit capture, real cursor and click effects, native webcam.",
		notes: [
			"Apple Silicon: Openscreen-Mac-arm64",
			"Intel: Openscreen-Mac-x64",
			"Grant Screen Recording and Accessibility in System Settings on first launch",
		],
	},
	{
		id: "windows",
		name: "Windows",
		icon: AppWindow,
		artifact: ".exe",
		blurb:
			"One installer, nothing to configure. Windows Graphics Capture, system audio out of the box, native webcam.",
		notes: [
			"Run the installer and launch — no terminal step",
			"System audio captured without extra drivers",
		],
	},
	{
		id: "linux",
		name: "Linux",
		icon: TerminalSquare,
		artifact: ".deb · .pacman · AppImage",
		blurb:
			"Four ways to install, including a Nix flake. Browser-pipeline capture; PipeWire is needed for system audio.",
		notes: [
			"Debian, Ubuntu, Pop!_OS: .deb",
			"Arch, Manjaro: .pacman",
			"Any distro: AppImage",
			"NixOS: flake",
		],
	},
] as const;

export default function DownloadPage() {
	return (
		<Layout
			title="Download for Windows, macOS & Linux"
			description="Download OpenScreen free for Windows, macOS, and Linux — .dmg, .exe, .deb, .pacman, AppImage, and a Nix flake. Open source, no account, no watermark."
		>
			<header className={styles.hero}>
				<div className={styles.heroInner}>
					<span className={styles.badge}>MIT licensed · free forever</span>
					<Heading as="h1" className={styles.title}>
						Download OpenScreen
					</Heading>
					<p className={styles.tagline}>
						A free, open-source screen recorder and video editor for Windows, macOS, and Linux. No
						account, no watermark, no subscription.
					</p>
					<div className={styles.actions}>
						<a className={styles.primaryCta} href={LATEST}>
							<Download size={16} />
							Get the latest release
						</a>
						<Link className={styles.secondaryCta} to="/docs/installation">
							Installation guide
						</Link>
					</div>
					<p className={styles.note}>
						OpenScreen is <strong>not production-grade</strong>. Expect rough edges while we build
						in the open.
					</p>
				</div>
			</header>

			<section className={styles.platforms}>
				<div className={styles.platformsInner}>
					<div className={styles.grid}>
						{PLATFORMS.map(({ id, name, icon: Icon, artifact, blurb, notes }) => (
							<article key={id} className={styles.card}>
								<div className={styles.cardHeader}>
									<Icon size={15} />
									<span>{name}</span>
									<span className={styles.artifactChip}>{artifact}</span>
								</div>
								<div className={styles.cardBody}>
									<p className={styles.cardBlurb}>{blurb}</p>
									<ul className={styles.noteList}>
										{notes.map((n) => (
											<li key={n}>{n}</li>
										))}
									</ul>
								</div>
								<a className={styles.cardCta} href={LATEST}>
									<Download size={14} />
									Download for {name}
								</a>
							</article>
						))}
					</div>

					<div className={styles.panels}>
						<div className={styles.panel}>
							<div className={styles.panelHeader}>
								<ShieldCheck size={14} />
								<span>macOS: if Gatekeeper blocks the app</span>
							</div>
							<pre className={styles.code}>
								<span className={styles.accentText}>xattr</span> -rd com.apple.quarantine
								/Applications/Openscreen.app
							</pre>
							<p className={styles.panelFoot}>
								Give your terminal Full Disk Access in System Settings first, then run it.
							</p>
						</div>

						<div className={styles.panel}>
							<div className={styles.panelHeader}>
								<Package size={14} />
								<span>Linux: install without downloading</span>
							</div>
							<pre className={styles.code}>
								<span className={styles.meta}># run it straight from the flake</span>
								{"\n"}
								<span className={styles.accentText}>nix</span> run github:getopenscreen/openscreen
							</pre>
							<p className={styles.panelFoot}>
								Package manager commands for .deb, .pacman, and AppImage are in the{" "}
								<Link to="/docs/installation">installation guide</Link>.
							</p>
						</div>
					</div>

					<p className={styles.footNote}>
						Every artifact for every release — including checksums and release notes — is on the{" "}
						<a href={`${REPO_URL}/releases`}>Releases page</a>. Source is on{" "}
						<a href={REPO_URL}>GitHub</a> under the MIT license.
					</p>
				</div>
			</section>
		</Layout>
	);
}
