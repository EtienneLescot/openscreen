// Welcome view for the LM chat panel.
//
// Shown in the chat body when the chat has nothing it can talk to — see
// canSendChat() in chatAvailability.ts for the exact condition. It explains
// what the chat can do, then routes the user to the provider settings dialog
// with a single CTA. A small disclaimer under the button makes it clear that,
// once a provider IS connected, the video's transcript will be sent to it.
//
// It replaces the `chat.emptyState` hint (which would be a dead end with no
// provider), but only while the conversation is empty: a user who disconnects
// mid-project keeps their history on screen, with the composer disabled.

import { ArrowRight, Info, Sparkles } from "lucide-react";
import { useId } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./NewEditorShell.module.css";

interface ChatWelcomeProps {
	/** Open the provider settings modal so the user can pick + connect one. */
	onOpenProviderSettings: () => void;
}

export function ChatWelcome({ onOpenProviderSettings }: ChatWelcomeProps) {
	const t = useScopedT("editor");
	const titleId = useId();

	return (
		<div className={styles.chatWelcome} role="region" aria-labelledby={titleId}>
			<header className={styles.chatWelcomeHero}>
				<span className={styles.chatWelcomeIcon} aria-hidden="true">
					<Sparkles size={20} />
				</span>
				<h2 className={styles.chatWelcomeTitle} id={titleId}>
					{t("chat.welcome.title")}
				</h2>
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

			<button type="button" className={styles.chatWelcomeCta} onClick={onOpenProviderSettings}>
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
