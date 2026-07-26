// Le fond d'un bloc de texte : un booléen côté utilisateur, une couleur côté rendu.
//
// Tous les moteurs de rendu (compositeur natif, exporteur canvas, aperçu DOM) lisent
// `style.backgroundColor` et traitent `"transparent"` comme « pas de fond ». Éteindre le fond
// écrase donc la couleur choisie, et le rallumer n'avait plus rien à restaurer : il revenait
// toujours au noir. `lastBackgroundColor` conserve cette couleur, ce qui rend la bascule
// réversible sans donner un second sens à `backgroundColor`.

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";

type AnnotationStyle = AxcutAnnotationRegion["style"];

/** Couleur d'un premier allumage, quand l'annotation n'a jamais eu de fond. */
export const DEFAULT_TEXT_BACKGROUND = "#000000";

export function hasTextBackground(style: AnnotationStyle): boolean {
	const color = style.backgroundColor;
	return !!color && color !== "transparent";
}

/**
 * Couleur à afficher dans le sélecteur, fond allumé ou éteint : éteint, on montre la couleur
 * mémorisée plutôt qu'un noir qui ne veut rien dire — c'est bien celle que le rallumage rendra.
 */
export function textBackgroundColor(style: AnnotationStyle): string {
	if (hasTextBackground(style)) return style.backgroundColor;
	const remembered = style.lastBackgroundColor;
	return remembered && remembered !== "transparent" ? remembered : DEFAULT_TEXT_BACKGROUND;
}

/** Style résultant de la bascule du fond, la couleur conservée dans les deux sens. */
export function toggleTextBackground(style: AnnotationStyle, next: boolean): AnnotationStyle {
	const remembered = textBackgroundColor(style);
	return {
		...style,
		backgroundColor: next ? remembered : "transparent",
		lastBackgroundColor: remembered,
	};
}

/**
 * Style résultant du choix d'une couleur de fond. Choisir une couleur allume le fond : c'est ce
 * que le geste veut dire, et laisser le fond éteint donnerait un sélecteur sans effet visible.
 */
export function setTextBackgroundColor(style: AnnotationStyle, color: string): AnnotationStyle {
	return { ...style, backgroundColor: color, lastBackgroundColor: color };
}
