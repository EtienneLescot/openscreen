/**
 * Sonde de fluidité de l'UI — DIAGNOSTIC, à retirer une fois la question tranchée.
 *
 * La question : quand la preview tourne, l'UI est-elle réellement en retard, et de combien ?
 * L'observation qui la motive est empirique — quand la fenêtre de preview disparaît, le
 * curseur redevient fluide — mais aucune mesure ne l'a jamais confirmée.
 *
 * Ce qu'elle corrige par rapport aux mesures précédentes :
 *
 *   - **Elle segmente par état** au lieu de moyenner. Une moyenne sur une fenêtre dont on
 *     ignore le taux d'activité ne dit rien : 45 s dont 15 s de scrub donnent un chiffre
 *     dilué par 30 s d'inactivité, et on l'attribue quand même au scrub. Ici chaque
 *     intervalle est rangé dans l'état où il a été mesuré.
 *   - **Elle compte les frames LONGUES** plutôt que de rapporter une moyenne. Une UI rugueuse
 *     n'a pas une moyenne haute, elle a des retards épisodiques : à 60 Hz, un p50 à 16,7 ms
 *     peut coexister avec 5 % de frames à 50 ms, et ce sont ces 5 % qu'on ressent.
 *   - **Elle refuse de mesurer une fenêtre cachée**, qui est throttlée par Chromium et
 *     rendrait tout inadmissible.
 *
 * Activation : `window.__uiProbe.start()` depuis la console du renderer. Rien ne tourne tant
 * qu'on ne le demande pas — aucun coût en usage normal.
 */

type ProbeState = "repos" | "preview" | "scrub" | "scrub+preview";

interface Bucket {
	intervals: number[];
}

const buckets = new Map<ProbeState, Bucket>();
let running = false;
let rafHandle = 0;
let lastTs = 0;
/** Frames de preview peintes depuis le dernier tick — dit si la preview travaille. */
let previewFramesSinceTick = 0;
let scrubbing = false;

/** Appelé par le hook de preview à chaque frame effectivement livrée. */
export function noteUiProbePreviewFrame(): void {
	if (running) {
		previewFramesSinceTick++;
	}
}

/** Appelé par la timeline à l'entrée et à la sortie d'un drag de tête de lecture. */
export function setUiProbeScrubbing(active: boolean): void {
	scrubbing = active;
}

function bucketFor(state: ProbeState): Bucket {
	let b = buckets.get(state);
	if (!b) {
		b = { intervals: [] };
		buckets.set(state, b);
	}
	return b;
}

function currentState(): ProbeState {
	const previewActive = previewFramesSinceTick > 0;
	if (scrubbing && previewActive) return "scrub+preview";
	if (scrubbing) return "scrub";
	if (previewActive) return "preview";
	return "repos";
}

function tick(ts: number) {
	rafHandle = requestAnimationFrame(tick);
	if (lastTs !== 0) {
		bucketFor(currentState()).intervals.push(ts - lastTs);
	}
	lastTs = ts;
	previewFramesSinceTick = 0;
}

function summarize() {
	const rows: string[] = [];
	for (const state of ["repos", "preview", "scrub", "scrub+preview"] as ProbeState[]) {
		const b = buckets.get(state);
		if (!b || b.intervals.length < 10) {
			continue;
		}
		const s = [...b.intervals].sort((a, x) => a - x);
		const q = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
		// Une frame « en retard » = au-delà d'un vsync et demi à 60 Hz. C'est le seuil à
		// partir duquel un mouvement suivi à l'œil commence à accrocher.
		const late = s.filter((x) => x > 25).length;
		const veryLate = s.filter((x) => x > 40).length;
		rows.push(
			`${state.padEnd(14)} n=${String(s.length).padStart(5)}  ` +
				`p50=${q(50).toFixed(1)}  p90=${q(90).toFixed(1)}  p99=${q(99).toFixed(1)}  ` +
				`max=${s[s.length - 1].toFixed(1)}  ` +
				`>25ms=${((late / s.length) * 100).toFixed(1)}%  >40ms=${((veryLate / s.length) * 100).toFixed(1)}%`,
		);
	}
	console.warn(`[ui-probe] intervalles rAF en ms\n${rows.join("\n")}`);
}

/**
 * Tâches longues (> 50 ms) observées pendant la mesure, avec leur attribution.
 *
 * Les intervalles rAF disent QU'IL Y A un retard ; ils ne disent pas d'où il vient. Un
 * blocage de 833 ms n'est ni une peinture ni une composition — c'est du JS synchrone ou un
 * GC. `longtask` est la seule API qui donne la durée ET une attribution sans profilage
 * manuel, donc c'est par là qu'on nomme le coupable.
 */
const longTasks: { duration: number; name: string; container: string }[] = [];
let longTaskObserver: PerformanceObserver | null = null;

function summarizeLongTasks() {
	if (longTasks.length === 0) {
		console.warn(
			"[ui-probe] aucune tâche longue (>50 ms) — le blocage n'est pas du JS attribuable.",
		);
		return;
	}
	const byKey = new Map<string, { n: number; total: number; max: number }>();
	for (const t of longTasks) {
		const key = `${t.name} / ${t.container}`;
		const e = byKey.get(key) ?? { n: 0, total: 0, max: 0 };
		e.n++;
		e.total += t.duration;
		e.max = Math.max(e.max, t.duration);
		byKey.set(key, e);
	}
	const rows = [...byKey.entries()]
		.sort((a, b) => b[1].total - a[1].total)
		.slice(0, 10)
		.map(
			([k, v]) =>
				`  ${k.padEnd(40)} n=${String(v.n).padStart(4)} total=${v.total.toFixed(0)}ms max=${v.max.toFixed(0)}ms`,
		);
	console.warn(`[ui-probe] tâches longues (>50 ms), pires d'abord\n${rows.join("\n")}`);
}

export function startUiProbe(reportEverySec = 10): void {
	if (running) {
		return;
	}
	if (document.hidden) {
		console.warn("[ui-probe] fenêtre cachée — mesure refusée (Chromium throttle un onglet caché).");
		return;
	}
	running = true;
	buckets.clear();
	longTasks.length = 0;
	lastTs = 0;
	rafHandle = requestAnimationFrame(tick);
	try {
		longTaskObserver = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				const attribution = (
					entry as PerformanceEntry & {
						attribution?: {
							containerType?: string;
							containerName?: string;
							containerSrc?: string;
						}[];
					}
				).attribution?.[0];
				longTasks.push({
					duration: entry.duration,
					name: entry.name,
					container: attribution
						? `${attribution.containerType ?? "?"}:${attribution.containerName || attribution.containerSrc || "?"}`
						: "-",
				});
			}
		});
		longTaskObserver.observe({ entryTypes: ["longtask"] });
	} catch {
		console.warn("[ui-probe] longtask indisponible — seuls les intervalles rAF seront rapportés.");
	}
	const timer = window.setInterval(() => {
		summarize();
		summarizeLongTasks();
	}, reportEverySec * 1000);
	stopUiProbe = () => {
		running = false;
		cancelAnimationFrame(rafHandle);
		window.clearInterval(timer);
		longTaskObserver?.disconnect();
		longTaskObserver = null;
		summarize();
		summarizeLongTasks();
	};
	console.warn("[ui-probe] démarré. Scrube, lis, laisse au repos — un rapport toutes les 10 s.");
}

/** Remplacé par `startUiProbe`. Avant tout démarrage, arrêter est légitimement un no-op. */
export let stopUiProbe: () => void = () => {
	// rien à arrêter tant que la sonde n'a pas démarré
};

// Exposé sur `window` pour être piloté depuis la console du renderer sans recompiler.
if (typeof window !== "undefined") {
	(window as unknown as { __uiProbe: unknown }).__uiProbe = {
		start: startUiProbe,
		stop: () => stopUiProbe(),
		report: summarize,
	};
}
