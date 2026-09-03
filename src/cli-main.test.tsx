// @vitest-environment jsdom
//
// Le dispatch de `cli-main.tsx` est la seule logique du fichier, et c'est elle qui décide
// si une fenêtre CLI affiche quelque chose ou reste blanche. Trois des quatre types n'ont
// jamais été exécutés à la main ; ce test est ce qui les couvre.
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

/** Le nom du composant effectivement monté, en descendant à travers `React.StrictMode`. */
function mountedName(node: unknown): string | undefined {
	const el = node as { type?: unknown; props?: { children?: unknown } } | null;
	if (!el || typeof el !== "object") return undefined;
	const type = el.type as { name?: string } | string | undefined;
	if (typeof type === "function" && type.name) return type.name;
	if (el.props?.children) return mountedName(el.props.children);
	return typeof type === "string" ? type : undefined;
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
			// Le composant mocké rend son propre nom : l'appeler prouve que c'est le bon.
			const name = mountedName(root.rendered[0]);
			expect(name).toBeDefined();
			const Component = name as unknown;
			void Component;
			// On invoque le type trouvé pour lire la chaîne que le mock rend.
			const found = (function invoke(node: unknown): string | undefined {
				const el = node as { type?: unknown; props?: { children?: unknown } } | null;
				if (!el || typeof el !== "object") return undefined;
				if (typeof el.type === "function") return (el.type as () => string)();
				return invoke(el.props?.children);
			})(root.rendered[0]);
			expect(found).toBe(expected);
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
