/**
 * Regroupe les mises à jour continues d'un geste (glissement d'un sélecteur de couleur, d'un
 * slider) à **une par frame**.
 *
 * Pourquoi c'est nécessaire ici : `updateAnnotationLive` remplace le document dans le store, ce
 * qui fait reconstruire ET re-sérialiser toute la scène avant de la pousser au compositeur natif.
 * C'est le bon prix à payer une fois par image ; à la cadence d'un `<input type="color">`, qui
 * émet un `change` par pixel de déplacement, ça sature le thread et le contrôle devient
 * inutilisable — le symptôme rapporté comme « le sélecteur de couleur lague ».
 *
 * Seule la DERNIÈRE valeur d'une frame est appliquée : les intermédiaires ne seraient de toute
 * façon jamais affichées, puisqu'aucune image ne s'intercale entre elles.
 */
export function rafCoalesce<A extends unknown[]>(
	fn: (...args: A) => void,
): {
	(...args: A): void;
	/** Applique tout de suite ce qui est en attente — à appeler en fin de geste, avant de
	 *  committer, pour que la valeur enregistrée soit bien la dernière saisie. */
	flush: () => void;
	cancel: () => void;
} {
	let handle: number | null = null;
	let pending: A | null = null;

	const run = () => {
		handle = null;
		const args = pending;
		pending = null;
		if (args) fn(...args);
	};

	const schedule = (...args: A) => {
		pending = args;
		if (handle !== null) return;
		// `requestAnimationFrame` absent (tests, worker) : on applique directement plutôt que de
		// perdre la mise à jour.
		if (typeof requestAnimationFrame !== "function") {
			run();
			return;
		}
		handle = requestAnimationFrame(run);
	};

	schedule.flush = () => {
		if (handle !== null && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(handle);
		}
		handle = null;
		run();
	};
	schedule.cancel = () => {
		if (handle !== null && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(handle);
		}
		handle = null;
		pending = null;
	};
	return schedule;
}
