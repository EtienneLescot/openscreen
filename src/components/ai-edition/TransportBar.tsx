import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { memo, useCallback, useEffect, useRef } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { setUiProbeScrubbing } from "@/lib/ai-edition/perf/uiFrameProbe";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { formatSec } from "@/lib/ai-edition/timeline/format";
import styles from "./NewEditorShell.module.css";

interface TransportBarProps {
	playing: boolean;
	/** Live scrub position while a timeline drag is in flight; null = follow the store. */
	overrideTimeSec: number | null;
	clips: AxcutClip[];
	onTogglePlay: () => void;
	onPrevClip: () => void;
	onNextClip: () => void;
	onSeek: (sec: number) => void;
}

// ponytail: lives in the timeline header now (not under the preview canvas)
// so the header row covers both timeline tools and playback in one line.
export const TransportBar = memo(function TransportBar({
	playing,
	overrideTimeSec,
	clips,
	onTogglePlay,
	onPrevClip,
	onNextClip,
	onSeek,
}: TransportBarProps) {
	const te = useScopedT("editor");
	// Same reason as PlayheadOverlay (see V4Timeline.tsx): the timecode and the
	// scrub thumb are animated during playback, so they subscribe to the playhead
	// directly instead of forcing V4Timeline — and the whole editor shell above it —
	// to re-render once per frame to hand it down as a prop.
	const storeTimeSec = useProjectStore((s) => s.currentTimeSec);
	const currentTimeSec = overrideTimeSec ?? storeTimeSec;
	const virtualDurationSec = clips.reduce(
		(acc, c) => acc + (c.timelineEndSec - c.timelineStartSec),
		0,
	);
	// ponytail: mirrors Preview's old clamp so the CSS thumb and the native
	// range thumb stay in sync when there's no clip yet.
	const inputMax = virtualDurationSec || 1;
	const inputValue = Math.min(Math.max(currentTimeSec, 0), inputMax);
	const progress = (inputValue / inputMax) * 100;

	// ── Drag de la barre : même cadence que le drag de la timeline ──────────────────
	//
	// L'`onChange` d'un `<input type="range">` se déclenche à la cadence du POINTEUR — 125 à
	// 1000 Hz selon la souris — et appelait `onSeek` à chacun. Or `onSeek` est `handleSeek`,
	// qui écrit au store ET repose un `seekTarget` neuf dans l'état de `NewEditorShell`, la
	// racine : chaque appel re-rend tout l'éditeur et fait poser `<video>.currentTime`, un
	// vrai seek média.
	//
	// La timeline fait exactement les mêmes appels, mais les coalesce en rAF — donc ~60 fois
	// par seconde au lieu de jusqu'à 1000. C'est cette seule différence de cadence qui
	// sépare les deux chemins, et elle explique l'écart de fluidité remonté en usage.
	//
	// On ne fait donc rien de plus que rétablir la parité : même travail, cadence d'écran.
	// Délibérément PAS « ne poser le seekTarget qu'au relâchement » — ce serait un
	// comportement différent de la timeline, où le `<video>` suit pendant le drag, et
	// divergence entre deux chemins censés faire la même chose est précisément ce qui a
	// produit les bugs de cette zone.
	const rafRef = useRef(0);
	const pendingRef = useRef<number | null>(null);
	const draggingRef = useRef(false);
	// Remplissage et curseur de la barre, écrits DIRECTEMENT pendant un drag.
	//
	// Même patron que `playheadElRef` dans V4Timeline, et pour la même raison : la position
	// que l'utilisateur voit ne doit pas attendre un rendu React. Ces deux éléments étaient
	// positionnés uniquement depuis `progress`, dérivé du store — donc en retard d'un commit
	// à chaque mouvement, alors que la tête de lecture de la timeline, elle, colle au
	// pointeur. C'est la dernière différence de parité entre les deux chemins que j'aie pu
	// identifier dans le code.
	//
	// React continue de les positionner hors drag (et au rendu suivant pendant le drag, avec
	// une valeur au pire vieille d'une frame puisque le rAF écrit au store à 60 Hz) : les
	// deux écritures convergent au lieu de se contredire.
	const progressElRef = useRef<HTMLDivElement | null>(null);
	const thumbElRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		return () => {
			if (rafRef.current !== 0) {
				cancelAnimationFrame(rafRef.current);
			}
		};
	}, []);

	const handleInputChange = useCallback(
		(value: number) => {
			// Hors drag (flèches du clavier, clic simple sur la piste) : rien à coalescer,
			// c'est un saut unique et il doit prendre effet tout de suite.
			if (!draggingRef.current) {
				onSeek(value);
				return;
			}
			pendingRef.current = value;
			// Visuel d'abord, sans passer par React : latence nulle, comme la tête de lecture
			// de la timeline. `inputMax` est déjà borné à 1 minimum, pas de division par zéro.
			const pct = Math.min(100, Math.max(0, (value / inputMax) * 100));
			if (progressElRef.current) {
				progressElRef.current.style.width = `${pct}%`;
			}
			if (thumbElRef.current) {
				thumbElRef.current.style.left = `${pct}%`;
			}
			if (rafRef.current !== 0) {
				return;
			}
			rafRef.current = requestAnimationFrame(() => {
				rafRef.current = 0;
				const pending = pendingRef.current;
				if (pending !== null) {
					onSeek(pending);
				}
			});
		},
		[onSeek, inputMax],
	);

	const endDrag = useCallback(() => {
		if (!draggingRef.current) {
			return;
		}
		draggingRef.current = false;
		setUiProbeScrubbing(false, "bar");
		if (rafRef.current !== 0) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = 0;
		}
		// Pose la dernière position : sans ce commit, le mouvement compris entre le dernier
		// rAF et le relâchement serait perdu et la tête s'arrêterait un cran avant le doigt.
		const pending = pendingRef.current;
		if (pending !== null) {
			pendingRef.current = null;
			onSeek(pending);
		}
	}, [onSeek]);

	return (
		<div className={styles.transport} role="toolbar" aria-label={te("transport.playbackControls")}>
			<button
				type="button"
				className={`${styles.tbtn} ${styles.play}`}
				title={te("transport.playPauseTitle")}
				aria-label={te("transport.playPause")}
				data-playing={playing}
				onClick={onTogglePlay}
			>
				{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
			</button>
			<button
				type="button"
				className={styles.tbtn}
				title={te("transport.previousClip")}
				aria-label={te("transport.previousClip")}
				onClick={onPrevClip}
			>
				<SkipBack size={13} />
			</button>
			<button
				type="button"
				className={styles.tbtn}
				title={te("transport.nextClip")}
				aria-label={te("transport.nextClip")}
				onClick={onNextClip}
			>
				<SkipForward size={13} />
			</button>
			<span className={styles.time}>
				<span>{formatSec(currentTimeSec)}</span>
				<span className={styles.sep}>/</span>
				<span className={styles.total}>{formatSec(virtualDurationSec)}</span>
			</span>
			<div className={styles.scrubBar}>
				<div className={styles.scrubTrack}>
					<div
						ref={progressElRef}
						className={styles.scrubProgress}
						style={{ width: `${progress}%` }}
					/>
				</div>
				<input
					type="range"
					min={0}
					max={inputMax}
					step={0.01}
					value={inputValue}
					onChange={(e) => handleInputChange(Number(e.target.value))}
					onPointerDown={() => {
						draggingRef.current = true;
						// Sonde de fluidité (diagnostic) : marque la fenêtre de drag comme
						// venant de la BARRE, pour ne pas la confondre avec un drag de
						// timeline — les deux empruntent des chemins de code différents.
						setUiProbeScrubbing(true, "bar");
					}}
					onPointerUp={endDrag}
					// `pointercancel` et `blur` ferment aussi le drag : un pointeur capturé
					// puis interrompu (geste système, perte de focus) ne produit pas de
					// `pointerup`, et la dernière position resterait alors non confirmée.
					onPointerCancel={endDrag}
					onBlur={endDrag}
					className={styles.scrubInput}
					aria-label={te("transport.seekVideo")}
				/>
				<div
					ref={thumbElRef}
					className={styles.scrubThumb}
					style={{
						left: `${progress}%`,
					}}
				/>
			</div>
		</div>
	);
});
