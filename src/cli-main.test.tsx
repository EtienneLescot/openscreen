// @vitest-environment jsdom
//
// Le dispatch de `cli-main.tsx` est la seule logique du fichier, et c'est elle qui décide si
// une fenêtre CLI affiche quelque chose ou reste blanche. Trois des quatre types n'avaient
// jamais été exécutés quand ce fichier est né ; ce test est ce qui les couvre.
import type React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./cli/CliExportRunner", () => ({ default: () => "EXPORT" }));
vi.mock("./cli/CliRecordRunner", () => ({ default: () => "RECORD" }));
vi.mock("./cli/CliSourcesRunner", () => ({ default: () => "SOURCES" }));
vi.mock("./cli/CliCaptionsRunner", () => ({ default: () => "CAPTIONS" }));

import { mountCliWindow } from "./cli-main";

/** Une racine factice : on veut savoir CE QUI a été rendu, pas le rendre vraiment. */
function fakeRoot() {
	const rendered: React.ReactNode[] = [];
	return { rendered, render: (node: React.ReactNode) => rendered.push(node) };
}

/** Tous les composants de l'arbre rendu, du plus externe au plus interne. */
function chain(node: unknown): Array<() => unknown> {
	const out: Array<() => unknown> = [];
	(function walk(n: unknown) {
		const el = n as { type?: unknown; props?: { children?: unknown } } | null;
		if (!el || typeof el !== "object") return;
		if (typeof el.type === "function") out.push(el.type as () => unknown);
		if (el.props?.children) walk(el.props.children);
	})(node);
	return out;
}

describe("mountCliWindow", () => {
	for (const [windowType, expected] of [
		["cli-export", "EXPORT"],
		["cli-record", "RECORD"],
		["cli-sources", "SOURCES"],
		["cli-captions", "CAPTIONS"],
	] as const) {
		it(`monte le runner de ${windowType}`, async () => {
			const root = fakeRoot();
			await mountCliWindow(windowType, root);
			expect(root.rendered).toHaveLength(1);
			// Le composant le plus INTERNE est le runner ; les mocks rendent leur propre nom,
			// donc l'invoquer prouve que le bon a été choisi.
			const components = chain(root.rendered[0]);
			expect(components.length).toBeGreaterThan(0);
			expect(components[components.length - 1]()).toBe(expected);
		});

		// C'est le test qui aurait attrapé le défaut que la première version de ce fichier a
		// laissé passer : aucun runner n'appelle `useI18n`, mais `CliRecordRunner` passe par
		// `useScreenRecorder` qui en dépend. Sans le fournisseur, `openscreen record` se
		// bloquait indéfiniment — le processus principal attendait une requête que le
		// renderer, mort sur « useI18n must be used within <I18nProvider> », ne demandait
		// jamais.
		//
		// L'assertion est STRUCTURELLE : elle vérifie que le fournisseur enveloppe le runner,
		// pas que chaque runner s'affiche. Monter les runners pour de vrai tirerait tout leur
		// graphe de dépendances ; les quatre commandes ont donc aussi été exécutées à la main.
		it(`enveloppe ${windowType} dans I18nProvider`, async () => {
			const root = fakeRoot();
			await mountCliWindow(windowType, root);
			const names = chain(root.rendered[0]).map((c) => c.name);
			expect(names).toContain("I18nProvider");
		});
	}

	it("rend une erreur VISIBLE sur un windowType inconnu, et la signale", async () => {
		const root = fakeRoot();
		// `drop_console: true` retire les `console.*` de la build de production : le seul
		// signal qui survit est ce qui est rendu. C'est ça que ce test verrouille.
		await expect(mountCliWindow("cli-nonexistent", root)).rejects.toThrow(/unexpected windowType/);
		expect(root.rendered).toHaveLength(1);
		expect(JSON.stringify(root.rendered[0])).toContain("cli-nonexistent");
	});
});
