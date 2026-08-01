import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import {
	Apple,
	AppWindow,
	Download,
	FlaskConical,
	ShieldCheck,
	TerminalSquare,
} from "lucide-react";

import { type AssetKind, findAsset, formatSize, type LatestRelease } from "../lib/release";
import styles from "./download.module.css";

const REPO_URL = "https://github.com/getopenscreen/openscreen";
const RELEASES_URL = `${REPO_URL}/releases`;
const LATEST_URL = `${RELEASES_URL}/latest`;

type PlatformSpec = {
	id: string;
	name: string;
	icon: typeof Apple;
	/** One row per artifact the platform actually ships. */
	options: { kind: AssetKind; label: string; sublabel: string }[];
	footnote?: string;
};

const PLATFORMS: PlatformSpec[] = [
	{
		id: "macos",
		name: "macOS",
		icon: Apple,
		options: [
			{ kind: "macArm", label: "Apple Silicon", sublabel: "M1 and newer · .dmg" },
			{ kind: "macIntel", label: "Intel", sublabel: "x86_64 · .dmg" },
		],
		footnote: "Grant Screen Recording and Accessibility on first launch.",
	},
	{
		id: "windows",
		name: "Windows",
		icon: AppWindow,
		options: [{ kind: "windows", label: "Windows 10 & 11", sublabel: "Installer · .exe" }],
		footnote: "System audio is captured without extra drivers.",
	},
	{
		id: "linux",
		name: "Linux",
		icon: TerminalSquare,
		options: [
			{ kind: "deb", label: "Debian, Ubuntu, Pop!_OS", sublabel: "Package · .deb" },
			{ kind: "pacman", label: "Arch, Manjaro", sublabel: "Package · .pacman" },
			{ kind: "appImage", label: "Any distribution", sublabel: "Portable · .AppImage" },
		],
		footnote: "PipeWire is required for system audio.",
	},
];

export default function DownloadPage() {
	const { siteConfig } = useDocusaurusContext();
	const release = (siteConfig.customFields?.latestRelease ?? null) as LatestRelease;

	return (
		<Layout
			title="Download for Windows, macOS & Linux"
			description="Download OpenScreen free for Windows, macOS, and Linux — .dmg, .exe, .deb, .pacman, AppImage, and a Nix flake. Open source, no account, no watermark."
		>
			<header className={styles.hero}>
				<div className={styles.heroInner}>
					<span className={styles.badge}>
						{release ? `${release.tag} · MIT licensed` : "MIT licensed · free forever"}
					</span>
					<Heading as="h1" className={styles.title}>
						Download OpenScreen
					</Heading>
					<p className={styles.tagline}>
						A free, open-source screen recorder and video editor. No account, no watermark, no
						subscription.
					</p>
					{release?.published ? (
						<p className={styles.releaseMeta}>
							Latest stable release, published {release.published}
						</p>
					) : null}
				</div>
			</header>

			<section className={styles.platforms}>
				<div className={styles.platformsInner}>
					<div className={styles.grid}>
						{PLATFORMS.map(({ id, name, icon: Icon, options, footnote }) => (
							<article key={id} className={styles.card}>
								<div className={styles.cardHeader}>
									<Icon size={15} />
									<span>{name}</span>
								</div>
								<div className={styles.cardBody}>
									{options.map(({ kind, label, sublabel }) => {
										const asset = findAsset(release, kind);
										// No build-time asset data (rate-limited runner, or a
										// release that dropped this artifact) degrades to the
										// releases list rather than rendering a dead link.
										const size = asset ? formatSize(asset.size) : "";
										return (
											<a key={kind} className={styles.option} href={asset?.url ?? LATEST_URL}>
												<span className={styles.optionText}>
													<span className={styles.optionLabel}>{label}</span>
													<span className={styles.optionSub}>{sublabel}</span>
												</span>
												{size ? <span className={styles.optionSize}>{size}</span> : null}
												<Download size={14} className={styles.optionIcon} />
											</a>
										);
									})}
								</div>
								{footnote ? <p className={styles.cardFoot}>{footnote}</p> : null}
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
								<TerminalSquare size={14} />
								<span>Nix: run it without installing</span>
							</div>
							<pre className={styles.code}>
								<span className={styles.accentText}>nix</span> run github:getopenscreen/openscreen
							</pre>
							<p className={styles.panelFoot}>
								Per-distribution steps are in the{" "}
								<Link to="/docs/installation">installation guide</Link>.
							</p>
						</div>
					</div>

					{/* Release candidates ship between stable versions and are genuinely
					    ahead of what the cards above serve, so this is a real path and not
					    a footer link — kept visually quiet so it cannot be mistaken for
					    the recommended download. */}
					<aside className={styles.preRelease}>
						<FlaskConical size={16} className={styles.preReleaseIcon} />
						<div className={styles.preReleaseText}>
							<p className={styles.preReleaseTitle}>Want to test what is coming next?</p>
							<p className={styles.preReleaseBody}>
								Release candidates ship between stable versions, alongside older releases,
								checksums, and full release notes.
							</p>
						</div>
						<a className={styles.preReleaseCta} href={RELEASES_URL}>
							Browse all releases
						</a>
					</aside>
				</div>
			</section>
		</Layout>
	);
}
