import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rafCoalesce } from "./rafCoalesce";

describe("rafCoalesce", () => {
	let frames: Array<() => void>;

	beforeEach(() => {
		frames = [];
		vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
			frames.push(cb);
			return frames.length;
		});
		vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
			frames[handle - 1] = () => {};
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const runFrame = () => {
		const due = frames;
		frames = [];
		for (const cb of due) cb();
	};

	it("applies one call per frame, keeping the last value", () => {
		// Le cas du sélecteur de couleur : des dizaines d'événements entre deux images, dont un
		// seul sera visible. Appliquer les intermédiaires ne fait que du travail jeté.
		const fn = vi.fn();
		const coalesced = rafCoalesce(fn);
		coalesced("#111111");
		coalesced("#222222");
		coalesced("#333333");
		expect(fn).not.toHaveBeenCalled();
		runFrame();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("#333333");
	});

	it("schedules a fresh frame for values arriving after one flushed", () => {
		const fn = vi.fn();
		const coalesced = rafCoalesce(fn);
		coalesced("a");
		runFrame();
		coalesced("b");
		runFrame();
		expect(fn.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
	});

	it("flush applies the pending value immediately", () => {
		// C'est ce qui garantit qu'un commit en fin de geste enregistre la DERNIÈRE couleur et non
		// l'avant-dernière : sans ça, la frame en vol serait perdue.
		const fn = vi.fn();
		const coalesced = rafCoalesce(fn);
		coalesced("final");
		coalesced.flush();
		expect(fn).toHaveBeenCalledWith("final");
		// et la frame déjà programmée ne doit pas rejouer la valeur
		runFrame();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("flush with nothing pending does nothing", () => {
		const fn = vi.fn();
		const coalesced = rafCoalesce(fn);
		coalesced.flush();
		expect(fn).not.toHaveBeenCalled();
	});

	it("cancel drops the pending value", () => {
		const fn = vi.fn();
		const coalesced = rafCoalesce(fn);
		coalesced("dropped");
		coalesced.cancel();
		runFrame();
		expect(fn).not.toHaveBeenCalled();
	});

	it("applies synchronously when requestAnimationFrame is unavailable", () => {
		// Tests et workers n'ont pas de rAF : mieux vaut appliquer tout de suite que perdre la
		// mise à jour.
		vi.stubGlobal("requestAnimationFrame", undefined);
		const fn = vi.fn();
		const coalesced = rafCoalesce(fn);
		coalesced("direct");
		expect(fn).toHaveBeenCalledWith("direct");
	});
});
