// Welcome view for the LM chat panel.
//
// Shown in the chat body when the chat has nothing it can talk to — see
// canSendChat() in chatAvailability.ts. It replaces the `chat.emptyState` hint
// (a dead end with no provider) only while the conversation is empty, so a user
// who disconnects mid-project keeps their history with the composer disabled.

import { ArrowRight, Info, Sparkles } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./NewEditorShell.module.css";

const FEATURE_KEYS = ["feature1", "feature2", "feature3"] as const;

interface ChatWelcomeProps {
	/** Open the provider settings modal so the user can pick + connect one. */
	onOpenProviderSettings: () => void;
}

export function ChatWelcome({ onOpenProviderSettings }: ChatWelcomeProps) {
	const t = useScopedT("editor");

	return (
		<div className={styles.chatWelcome}>
			<header className={styles.chatWelcomeHero}>
				<Sparkles size={20} className={styles.chatWelcomeIcon} aria-hidden="true" />
				<h2 className={styles.chatWelcomeTitle}>{t("chat.welcome.title")}</h2>
				<p className={styles.chatWelcomeSubtitle}>{t("chat.welcome.subtitle")}</p>
			</header>

			<ul className={styles.chatWelcomeFeatures}>
				{FEATURE_KEYS.map((key) => (
					<li key={key}>{t(`chat.welcome.${key}`)}</li>
				))}
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
