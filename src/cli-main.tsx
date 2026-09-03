// Point d'entrée du renderer pour les fenêtres CLI (`cli-export`, `cli-record`,
// `cli-sources`, `cli-captions`).
//
// POURQUOI IL EXISTE. `main.tsx` importe `App.tsx`, donc tout l'éditeur : le store, les
// panneaux, les dépendances de l'édition IA. Une fenêtre CLI n'affiche rien de tout ça —
// elle rend un `<div>` avec une ligne de texte pendant qu'un runner appelle le compositeur
// natif — mais elle en payait quand même le chargement, avant la première frame et donc
// DANS l'intervalle chronométré.
//
// Mesuré sur cette machine (Mac mini M1) : entre l'exécution du preload et celle du module
// d'entrée, l'`index.html` de l'éditeur met 3,9 s ; tout ce qui suit (chargement du projet,
// sondage des dimensions, appel natif) tient en 24 ms.
import React from "react";
import ReactDOM from "react-dom/client";

/// Monte le runner correspondant à `windowType` dans `root`.
///
/// Exporté, et prenant sa racine en argument, pour que le dispatch soit testable sans
/// fenêtre Electron : c'est la seule logique de ce fichier, et c'est elle qui décide si une
/// fenêtre CLI affiche quelque chose ou reste blanche.
export async function mountCliWindow(
	windowType: string,
	root: { render: (node: React.ReactNode) => void },
): Promise<void> {
	// Import dynamique et CIBLÉ : une fenêtre d'export ne charge pas le code d'enregistrement.
	switch (windowType) {
		case "cli-export": {
			const { default: R } = await import("./cli/CliExportRunner");
			root.render(
				<React.StrictMode>
					<R />
				</React.StrictMode>,
			);
			return;
		}
		case "cli-record": {
			const { default: R } = await import("./cli/CliRecordRunner");
			root.render(
				<React.StrictMode>
					<R />
				</React.StrictMode>,
			);
			return;
		}
		case "cli-sources": {
			const { default: R } = await import("./cli/CliSourcesRunner");
			root.render(
				<React.StrictMode>
					<R />
				</React.StrictMode>,
			);
			return;
		}
		case "cli-captions": {
			const { default: R } = await import("./cli/CliCaptionsRunner");
			root.render(
				<React.StrictMode>
					<R />
				</React.StrictMode>,
			);
			return;
		}
		default: {
			// Une fenêtre CLI sans type connu est un bug d'appel. Le dire DANS LE DOM, pas
			// seulement dans la console : `vite.config.ts` compile avec `drop_console: true`,
			// donc un `console.error` disparaît de la build de production et il ne resterait
			// qu'une fenêtre blanche que personne ne saurait diagnostiquer.
			const message = `openscreen: unexpected windowType ${JSON.stringify(windowType)}`;
			root.render(
				<pre style={{ color: "#f87171", padding: 16, font: "12px ui-monospace, monospace" }}>
					{message}
				</pre>,
			);
			throw new Error(message);
		}
	}
}

// Amorçage, conditionné à la présence de la racine : c'est ce qui rend le module importable
// par un test sans qu'il tente de monter dans un document vide.
const container = document.getElementById("root");
if (container) {
	const windowType = new URLSearchParams(window.location.search).get("windowType") || "";
	void mountCliWindow(windowType, ReactDOM.createRoot(container)).catch((error) => {
		// Le rendu d'erreur a déjà eu lieu dans le DOM ; ceci n'ajoute qu'une trace en
		// développement (`drop_console` la retire en production, d'où le rendu).
		console.error(error);
	});
}
