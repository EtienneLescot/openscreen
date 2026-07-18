/**
 * Petit store global de la vue native active. `NativeCompositorOverlay` crée la vue et
 * enregistre son id ici ; n'importe quel contrôle (inspector, transport…) peut alors
 * pousser un paramètre via `setNativeParam` sans connaître l'overlay. No-op tant qu'aucune
 * vue n'est active (flag `VITE_NATIVE_COMPOSITOR` off ou addon absent).
 */
import {
	setCompositorParam,
	setCompositorPlaying,
	setCompositorScene,
	setCompositorTime,
} from "./compositorViewClient";
import type { CompositorParamValue } from "./contracts";

let currentViewId: number | null = null;
const listeners = new Set<() => void>();
/** Derniers params poussés, par clé — rejoués à l'activation d'une vue (voir plus bas). */
const lastParams = new Map<string, CompositorParamValue>();

/** Appelé par l'overlay quand la vue native est créée (id) ou détruite (null). */
export function setCurrentNativeViewId(id: number | null): void {
	if (currentViewId === id) {
		return;
	}
	currentViewId = id;
	// Rejoue les params connus sur la vue qui vient de s'activer. Rend la synchro
	// indépendante de l'ordre de montage : une valeur poussée avant l'existence de la vue
	// (memoïsée par setNativeParam) est appliquée ici, pas seulement les changements futurs.
	if (id !== null) {
		for (const [key, value] of lastParams) {
			setCompositorParam(id, key, value).catch(() => {});
		}
	}
	for (const l of listeners) {
		l();
	}
}

export function getCurrentNativeViewId(): number | null {
	return currentViewId;
}

/** True quand une vue native est montée — pour n'appeler `setNativeParam` que si utile. */
export function isNativeCompositorActive(): boolean {
	return currentViewId !== null;
}

/** Pousse un paramètre à la vue native active, ET le mémorise pour rejeu à l'activation
 *  d'une (nouvelle) vue. No-op sur l'envoi si aucune vue ; la valeur reste mémorisée. */
export function setNativeParam(key: string, value: CompositorParamValue): void {
	lastParams.set(key, value);
	if (currentViewId === null) {
		return;
	}
	setCompositorParam(currentViewId, key, value).catch((error: unknown) => {
		console.warn(`[compositor-view] setNativeParam(${key}) failed:`, error);
	});
}

/** Seek la vue native active au temps `seconds` (playhead de l'app). No-op si aucune vue.
 *  Transitoire (position de lecture) → non mémorisé/rejoué, contrairement à setNativeParam. */
export function setNativeTime(seconds: number): void {
	if (currentViewId === null) {
		return;
	}
	setCompositorTime(currentViewId, seconds).catch((error: unknown) => {
		console.warn("[compositor-view] setNativeTime failed:", error);
	});
}

/** Pousse la scène de l'app (JSON `SceneDescription`) à la vue native active — layout preset
 *  etc. pilotent le rendu au lieu de la fixture. No-op si aucune vue. */
export function setNativeScene(sceneJson: string): void {
	if (currentViewId === null) {
		return;
	}
	setCompositorScene(currentViewId, sceneJson).catch((error: unknown) => {
		console.warn("[compositor-view] setNativeScene failed:", error);
	});
}

/** Play/pause de la vue native active (lecture libre côté natif). No-op si aucune vue. */
export function setNativePlaying(playing: boolean): void {
	if (currentViewId === null) {
		return;
	}
	setCompositorPlaying(currentViewId, playing).catch((error: unknown) => {
		console.warn("[compositor-view] setNativePlaying failed:", error);
	});
}

/** S'abonner à l'activité de la vue native (React: via useSyncExternalStore). */
export function subscribeNativeCompositor(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
