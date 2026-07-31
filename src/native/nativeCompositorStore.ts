/**
 * Petit store global de la vue native active. `NativeCompositorOverlay` crée la vue et
 * enregistre son id ici ; n'importe quel contrôle (inspector, transport…) peut alors
 * pousser un paramètre via `setNativeParam` sans connaître l'overlay. No-op tant qu'aucune
 * vue n'est active (pas encore de document/asset chargé, ou addon absent).
 */

import type { EditorSettingsSnapshot } from "@/lib/ai-edition/store/editorSettings";
import {
	setCompositorParam,
	setCompositorPlaying,
	setCompositorScene,
	setCompositorTime,
} from "./compositorViewClient";
import type { CompositorParamValue } from "./contracts";
import { NATIVE_SCREEN_BASE_RADIUS_PX, NATIVE_WEBCAM_BASE_PCT } from "./paramUnits";

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
			setCompositorParam(id, key, value).catch(() => {
				// no-op : rejeu au mieux-effort, une vue tout juste (re)créée peut ignorer
				// un param encore invalide sans que ce soit une erreur à remonter.
			});
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

/** Seek la vue native au temps SOURCE du clip actif. La conversion depuis la playhead timeline
 *  est faite par `useNativePlaybackSync`. Transitoire → non mémorisé/rejoué. */
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

/**
 * Pushes EVERY param the addon understands, from a settings snapshot.
 *
 * WHY THIS EXISTS. Until this function, each group of params was pushed only by
 * the mount effect of the panel that owns it — VideoEffectsPane, LayoutPane,
 * CursorPane. The inspector renders exactly ONE panel at a time
 * (FloatingInspector's if/else on `facet`, defaulting to "effects"), so on load
 * the cursor and layout panels have never mounted and their params sit at the
 * addon's compiled-in defaults. That is the whole bug: a project with cursor
 * size 3.0 previewed at 1.0 until the user opened the cursor panel, at which
 * point it snapped to the right value and looked like the panel had "enabled"
 * something.
 *
 * The `lastParams` replay above is not a substitute: it can only replay keys
 * that were pushed at least once, and a key owned by a panel that never mounted
 * was never pushed at all.
 *
 * UNITS. The values here are RAW, matching what the old mount effects sent and
 * NOT what the sliders send. `SliderCell` displays `cursor.size * 10` and its
 * handler divides by 10 again on the way out; the same asymmetry applies to
 * clickBounce (x10) and to smoothing/motionBlur (x100). Sending a slider-space
 * value from here would scale the whole preview by 10 or 100 on load.
 */
export function pushAllNativeParams(settings: EditorSettingsSnapshot): void {
	setNativeParam("backgroundBlur", settings.showBlur);
	setNativeParam("motionBlur", settings.motionBlurAmount);
	setNativeParam("shadow", settings.shadowIntensity);
	setNativeParam("roundness", settings.borderRadius / NATIVE_SCREEN_BASE_RADIUS_PX);
	setNativeParam("padding", settings.padding / 100);
	// Only a literal colour is a param; a gradient or an image wallpaper travels
	// in the scene instead, and pushing its name here would be meaningless.
	if (settings.wallpaper.startsWith("#")) {
		setNativeParam("backgroundColor", settings.wallpaper);
	}

	setNativeParam("webcamSize", settings.webcamSizePreset / NATIVE_WEBCAM_BASE_PCT);
	setNativeParam("webcamMirror", settings.webcamMirrored);
	setNativeParam("webcamShape", settings.webcamMaskShape);

	setNativeParam("cursorShow", settings.cursorShow);
	setNativeParam("cursorSize", settings.cursor.size);
	setNativeParam("cursorClickBounce", settings.cursor.clickBounce);
	setNativeParam("cursorSmoothing", settings.cursor.smoothing);
	setNativeParam("cursorMotionBlur", settings.cursor.motionBlur);
}
