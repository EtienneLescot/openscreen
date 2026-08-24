// Shown over the preview when the decode clock gave up on the mounted source
// (issue #395). Deliberately an overlay, not a replacement: the native
// compositor keeps painting the last composed frame underneath, and that frame
// is the evidence the project is intact — which is exactly what the old
// behaviour (collapsing to the "add a video to get started" empty state)
// destroyed along with the user's confidence.
//
// The copy does not claim to know WHY: the two causes we know of — a file that
// moved and a file still being written — are indistinguishable from here
// without a filesystem round trip, and guessing wrong is how an error message
// sends someone re-importing media that was never gone.

import { AlertCircle, RotateCcw } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./NewEditorShell.module.css";

interface PreviewErrorCardProps {
	/** The MediaError, formatted — kept on screen because it is the one thing
	 *  that makes a user's bug report actionable (see mediaError.ts). */
	detail: string;
	onRetry: () => void;
}

export function PreviewErrorCard({ detail, onRetry }: PreviewErrorCardProps) {
	const t = useScopedT("editor");

	return (
		<div className={styles.previewFailure} role="alert" data-testid="preview-error-card">
			<div className={styles.previewFailureCard}>
				<div className={styles.previewFailureIconRing}>
					<AlertCircle className={styles.previewFailureIcon} />
				</div>
				<h2 className={styles.previewFailureTitle}>{t("preview.mediaError.title")}</h2>
				<p className={styles.previewFailureDescription}>{t("preview.mediaError.description")}</p>
				<button type="button" onClick={onRetry} className={styles.previewEmptyPrimaryButton}>
					<RotateCcw className={styles.previewEmptyButtonIcon} />
					{t("preview.mediaError.retry")}
				</button>
				{detail ? (
					<p className={styles.previewFailureDetail}>
						{t("preview.mediaError.detail", { detail })}
					</p>
				) : null}
			</div>
		</div>
	);
}
