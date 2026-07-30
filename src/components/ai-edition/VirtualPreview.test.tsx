import "@testing-library/jest-dom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentNativeViewId } from "@/native";
import { VirtualPreview } from "./VirtualPreview";

// Un seul clip, un seul asset : tout seek reste dans le même clip et le même <video> (pas
// de switch d'asset), donc `seekToVirtualTime` retombe sur le chemin simple et appelle
// `onTimeChange` — l'observable qui nous dit qu'un seek a bien été appliqué au <video>.
const clips = [
	{
		id: "clip_a",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 30,
		timelineStartSec: 0,
		timelineEndSec: 30,
		wordRefs: [],
		origin: "user" as const,
		reason: "",
	},
];
const videoSources = [{ id: "asset_1", src: "blob:test", label: "Screen" }];

function renderPreview(onTimeChange: (t: number) => void, requestId: number) {
	return render(
		<VirtualPreview
			videoSources={videoSources}
			clips={clips}
			seekTarget={{ timeSec: 0, isSource: false, requestId }}
			onTimeChange={onTimeChange}
		/>,
	);
}

describe("VirtualPreview throttle le seek du <video> pendant un scrub natif en pause", () => {
	let nowMs = 10_000;

	beforeEach(() => {
		nowMs = 10_000;
		vi.useFakeTimers();
		// Horloge du throttle sous contrôle : sinon la fenêtre de 66 ms dépendrait du temps
		// réel écoulé entre deux `rerender`, ce qui rendrait le test non déterministe.
		vi.spyOn(performance, "now").mockImplementation(() => nowMs);
	});

	afterEach(() => {
		cleanup();
		setCurrentNativeViewId(null);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("coalesce des seeks rapprochés et pose quand même la position finale (bord de fuite)", () => {
		setCurrentNativeViewId(1); // vue native active → le <video> est occulté
		const onTimeChange = vi.fn();
		// jsdom : `<video>.paused` vaut true par défaut → la condition « en pause » est remplie.
		const { rerender } = renderPreview(onTimeChange, 1);
		// Premier pas : rien n'a encore été appliqué (lastAppliedMs=0), donc il passe tout de suite.
		const seeksAfterFirst = onTimeChange.mock.calls.length;
		expect(seeksAfterFirst).toBeGreaterThanOrEqual(1);

		// Trois pas rapprochés DANS la fenêtre de throttle : aucun ne doit être appliqué
		// immédiatement — ils sont coalescés en attente du bord de fuite.
		for (const [i, timeSec] of [2, 3, 4].entries()) {
			nowMs += 10; // < 66 ms cumulés
			act(() => {
				rerender(
					<VirtualPreview
						videoSources={videoSources}
						clips={clips}
						seekTarget={{ timeSec, isSource: false, requestId: 2 + i }}
						onTimeChange={onTimeChange}
					/>,
				);
			});
		}
		expect(onTimeChange.mock.calls.length).toBe(seeksAfterFirst);

		// Le bord de fuite s'exécute et applique la DERNIÈRE cible (4), pas une intermédiaire.
		nowMs += 100;
		act(() => {
			vi.runOnlyPendingTimers();
		});
		expect(onTimeChange.mock.calls.length).toBe(seeksAfterFirst + 1);
		expect(onTimeChange).toHaveBeenLastCalledWith(expect.closeTo(4, 1));
	});

	it("sans vue native, chaque seek est appliqué immédiatement (le <video> EST la preview)", () => {
		setCurrentNativeViewId(null); // pas de natif → chemin immédiat, comme avant
		const onTimeChange = vi.fn();
		const { rerender } = renderPreview(onTimeChange, 1);
		const base = onTimeChange.mock.calls.length;

		for (const [i, timeSec] of [2, 3, 4].entries()) {
			nowMs += 10;
			act(() => {
				rerender(
					<VirtualPreview
						videoSources={videoSources}
						clips={clips}
						seekTarget={{ timeSec, isSource: false, requestId: 2 + i }}
						onTimeChange={onTimeChange}
					/>,
				);
			});
		}
		// Trois seeks supplémentaires → trois applications immédiates, aucune coalescence.
		expect(onTimeChange.mock.calls.length).toBe(base + 3);
	});
});
