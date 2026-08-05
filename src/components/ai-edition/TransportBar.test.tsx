// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { TransportBar } from "./TransportBar";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: {} },
}));

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

const noop = vi.fn();

describe("TransportBar reads the playhead from the store", () => {
	beforeEach(() => {
		useProjectStore.setState({ currentTimeSec: 0 });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// The counterpart to useTimeline.test.ts's "not re-rendered by playhead ticks":
	// now that the editor shell no longer subscribes to the playhead, the pieces that
	// DO display it have to pick it up themselves. Nothing here re-renders the parent
	// — the store write alone must move the timecode.
	it("updates the timecode on a store write, with no parent re-render", () => {
		let parentRenders = 0;
		function Parent() {
			parentRenders++;
			return (
				<TransportBar
					playing={false}
					overrideTimeSec={null}
					clips={clips}
					onTogglePlay={noop}
					onPrevClip={noop}
					onNextClip={noop}
					onSeek={noop}
				/>
			);
		}

		render(
			<I18nProvider>
				<Parent />
			</I18nProvider>,
		);
		const rendersAfterMount = parentRenders;
		expect(screen.getByText("0:00.0")).toBeInTheDocument();

		act(() => {
			useProjectStore.getState().setCurrentTime(12.3);
		});

		expect(screen.getByText("0:12.3")).toBeInTheDocument();
		expect(parentRenders).toBe(rendersAfterMount);
	});

	// A timeline scrub drag writes the store on a rAF, so for the frame in between the
	// pointer position is only in `overrideTimeSec` — it has to win over the store.
	it("prefers the live scrub override over the store value", () => {
		useProjectStore.setState({ currentTimeSec: 12.3 });
		render(
			<I18nProvider>
				<TransportBar
					playing={false}
					overrideTimeSec={4.5}
					clips={clips}
					onTogglePlay={noop}
					onPrevClip={noop}
					onNextClip={noop}
					onSeek={noop}
				/>
			</I18nProvider>,
		);
		expect(screen.getByText("0:04.5")).toBeInTheDocument();
	});
});

describe("le drag de la barre de progression est coalescé en rAF", () => {
	beforeEach(() => {
		useProjectStore.setState({ currentTimeSec: 0 });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	/** rAF piloté à la main : les callbacks ne partent que sur `flush()`, ce qui permet de
	 *  compter ce qui se passe DANS une frame — impossible avec le vrai rAF en test. */
	function stubRaf() {
		const pending: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			pending.push(cb);
			return pending.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {
			// rien à annuler : `flush()` ne rejoue que ce qui reste en attente
		});
		return () => {
			const due = pending.splice(0, pending.length);
			for (const cb of due) cb(0);
		};
	}

	// C'est LE défaut que ce chemin avait : `onChange` d'un `<input type="range">` se
	// déclenche à la cadence du pointeur (jusqu'à 1000 Hz) et appelait `onSeek` à chaque
	// fois. Or `onSeek` repose un `seekTarget` dans l'état de la racine de l'éditeur, donc
	// re-rend tout et fait poser `<video>.currentTime`. La timeline fait les mêmes appels
	// mais une fois par frame ; ce test verrouille cette parité.
	it("n'émet qu'un seul seek par frame, quel que soit le nombre d'événements", () => {
		const flush = stubRaf();
		const onSeek = vi.fn();
		render(
			<I18nProvider>
				<TransportBar
					playing={false}
					overrideTimeSec={null}
					clips={clips}
					onTogglePlay={noop}
					onPrevClip={noop}
					onNextClip={noop}
					onSeek={onSeek}
				/>
			</I18nProvider>,
		);
		const input = screen.getByLabelText(/seek/i) as HTMLInputElement;

		act(() => {
			fireEvent.pointerDown(input);
		});
		// Dix mouvements dans la même frame : un seul seek doit en sortir, et c'est le
		// DERNIER qui compte — sans quoi la tête accuserait un retard permanent.
		act(() => {
			for (const value of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
				fireEvent.change(input, { target: { value: String(value) } });
			}
		});
		expect(onSeek).not.toHaveBeenCalled();

		act(() => flush());
		expect(onSeek).toHaveBeenCalledTimes(1);
		expect(onSeek).toHaveBeenLastCalledWith(10);
	});

	// Le mouvement compris entre le dernier rAF et le relâchement serait perdu sans commit
	// final : la tête s'arrêterait un cran avant le doigt.
	it("pose la dernière position au relâchement", () => {
		stubRaf();
		const onSeek = vi.fn();
		render(
			<I18nProvider>
				<TransportBar
					playing={false}
					overrideTimeSec={null}
					clips={clips}
					onTogglePlay={noop}
					onPrevClip={noop}
					onNextClip={noop}
					onSeek={onSeek}
				/>
			</I18nProvider>,
		);
		const input = screen.getByLabelText(/seek/i) as HTMLInputElement;

		act(() => {
			fireEvent.pointerDown(input);
			fireEvent.change(input, { target: { value: "7" } });
			fireEvent.pointerUp(input);
		});
		expect(onSeek).toHaveBeenCalledWith(7);
	});

	// Hors drag il n'y a rien à coalescer : une flèche du clavier est un saut unique et
	// doit prendre effet immédiatement, sans attendre une frame.
	it("applique immédiatement un changement hors drag", () => {
		stubRaf();
		const onSeek = vi.fn();
		render(
			<I18nProvider>
				<TransportBar
					playing={false}
					overrideTimeSec={null}
					clips={clips}
					onTogglePlay={noop}
					onPrevClip={noop}
					onNextClip={noop}
					onSeek={onSeek}
				/>
			</I18nProvider>,
		);
		const input = screen.getByLabelText(/seek/i) as HTMLInputElement;

		act(() => {
			fireEvent.change(input, { target: { value: "3" } });
		});
		expect(onSeek).toHaveBeenCalledTimes(1);
		expect(onSeek).toHaveBeenCalledWith(3);
	});

	// Le remplissage et le curseur étaient positionnés uniquement par React depuis le store,
	// donc en retard d'un commit à chaque mouvement — alors que la tête de lecture de la
	// timeline, elle, est écrite directement dans le DOM et colle au pointeur. Ce test
	// verrouille la parité : le visuel bouge AVANT le rAF, donc sans attendre React.
	it("déplace le curseur dans le DOM avant tout rendu React", () => {
		stubRaf();
		const onSeek = vi.fn();
		const { container } = render(
			<I18nProvider>
				<TransportBar
					playing={false}
					overrideTimeSec={null}
					clips={clips}
					onTogglePlay={noop}
					onPrevClip={noop}
					onNextClip={noop}
					onSeek={onSeek}
				/>
			</I18nProvider>,
		);
		const input = screen.getByLabelText(/seek/i) as HTMLInputElement;
		// Les deux éléments décorés : le remplissage (largeur) et le curseur (position).
		const styled = Array.from(container.querySelectorAll("div")).filter(
			(el) => el.style.width !== "" || el.style.left !== "",
		);
		expect(styled.length).toBeGreaterThanOrEqual(2);

		act(() => {
			fireEvent.pointerDown(input);
			// La moitié de la durée (clip de 30 s) → 50 %.
			fireEvent.change(input, { target: { value: "15" } });
		});

		// Aucun rAF n'a été vidé, donc aucune écriture au store et aucun rendu React : ce qui
		// a bougé ne peut venir que de l'écriture DOM directe.
		expect(onSeek).not.toHaveBeenCalled();
		const moved = styled.filter((el) => el.style.width === "50%" || el.style.left === "50%");
		expect(moved.length).toBeGreaterThanOrEqual(2);
	});
});
