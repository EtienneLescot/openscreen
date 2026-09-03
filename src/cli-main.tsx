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

const windowType = new URLSearchParams(window.location.search).get("windowType") || "";

async function mount() {
	const root = ReactDOM.createRoot(document.getElementById("root")!);
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
		default:
			// Une fenêtre CLI sans type est un bug d'appel, pas un cas à rendre : le dire
			// plutôt que d'afficher une page vide que personne ne saura diagnostiquer.
			console.error(`[cli] windowType inattendu : ${JSON.stringify(windowType)}`);
	}
}

void mount();
