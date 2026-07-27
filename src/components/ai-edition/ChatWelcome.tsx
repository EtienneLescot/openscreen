// Welcome view for the LM chat panel.
//
// Shown in the chat body when no LLM provider is connected (whether the user
// has just installed the app, or used to have a provider and removed all
// credentials). It explains what the chat can do, then routes the user to the
// provider settings dialog with a single CTA. A small disclaimer under the
// button makes it clear that, once a provider IS connected, the video's
// transcript will be sent to it.
//
// We deliberately do NOT keep the prior "no messages yet" placeholder in this
// branch — without a provider there is no way to send a first message, so the
// hint would be a dead end. The regular `chat.emptyState` line still appears
// for the brief window where a provider is connected but no messages have
// been exchanged yet.

import { ArrowRight, Info, Sparkles } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./NewEditorShell.module.css";

interface ChatWelcomeProps {
	/** Open the provider settings modal so the user can pick + connect one. */
	onOpenProviderSettings: () => void;
}

export function ChatWelcome({ onOpenProviderSettings }: ChatWelcomeProps) {
	const t = useScopedT("editor");

	return (
		<div className={styles.chatWelcome} role="region" aria-label={t("chat.welcome.title")}>
			<header className={styles.chatWelcomeHero}>
				<span className={styles.chatWelcomeIcon} aria-hidden="true">
					<Sparkles size={20} />
				</span>
				<h2 className={styles.chatWelcomeTitle}>{t("chat.welcome.title")}</h2>
				<p className={styles.chatWelcomeSubtitle}>{t("chat.welcome.subtitle")}</p>
			</header>

			<ul className={styles.chatWelcomeFeatures}>
				<li className={styles.chatWelcomeFeature}>
					<span className={styles.chatWelcomeFeatureDot} aria-hidden="true" />
					<span>{t("chat.welcome.feature1")}</span>
				</li>
				<li className={styles.chatWelcomeFeature}>
					<span className={styles.chatWelcomeFeatureDot} aria-hidden="true" />
					<span>{t("chat.welcome.feature2")}</span>
				</li>
				<li className={styles.chatWelcomeFeature}>
					<span className={styles.chatWelcomeFeatureDot} aria-hidden="true" />
					<span>{t("chat.welcome.feature3")}</span>
				</li>
			</ul>

			<button
				type="button"
				className={styles.chatWelcomeCta}
				onClick={onOpenProviderSettings}
				data-testid="chat-welcome-cta"
			>
				{t("chat.welcome.cta")}
				<ArrowRight size={14} />
			</button>

			<p className={styles.chatWelcomeDisclaimer}>
				<Info size={12} className={styles.chatWelcomeDisclaimerIcon} aria-hidden="true" />
				<span>{t("chat.welcome.disclaimer")}</span>
			</p>
		</div>
	);
}
