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

type BaseState =
	| "repos"
	| "preview"
	| "scrub-tl"
	| "scrub-tl+preview"
	| "scrub-bar"
	| "scrub-bar+preview";
/** L'état porte le suffixe `@N` = nombre de bascules de clip déjà vues. Voir
 *  `noteUiProbeClipSwitch` : sans cette séparation, deux mesures ne sont pas comparables. */
type ProbeState = string;

interface Bucket {
	intervals: number[];
}

const buckets = new Map<ProbeState, Bucket>();
let running = false;
let rafHandle = 0;
let lastTs = 0;
/** Frames de preview peintes depuis le dernier tick — dit si la preview travaille. */
let previewFramesSinceTick = 0;
/**
 * D'OÙ vient le scrub en cours.
 *
 * Les deux chemins n'ont rien à voir : la timeline écrit la tête de lecture directement
 * dans le DOM et coalesce son écriture au store en rAF ; la barre de progression, elle,
 * écrit au store à chaque événement ET repose un `seekTarget` — un état de la RACINE de
 * l'éditeur — ce qui re-render tout et déclenche un seek du `<video>` par mouvement de
 * souris. Les mélanger sous une même étiquette `scrub` reviendrait à moyenner deux
 * populations différentes, exactement le biais que cette sonde existe pour éviter.
 */
type ScrubSource = "timeline" | "bar";

let scrubbing: ScrubSource | null = null;
/** Bascules de clip vues depuis le démarrage de la sonde. Sépare les états. */
let clipSwitches = 0;

/** Appelé par le hook de preview à chaque frame effectivement livrée. */
export function noteUiProbePreviewFrame(): void {
	if (running) {
		previewFramesSinceTick++;
	}
}

/** Appelé par la timeline à l'entrée et à la sortie d'un drag de tête de lecture. */
export function setUiProbeScrubbing(active: boolean, source: ScrubSource = "timeline"): void {
	scrubbing = active ? source : null;
}

/**
 * Appelé quand la preview bascule sur un autre clip.
 *
 * Existe parce qu'une comparaison a déjà été faussée par cette variable : un run où le
 * scrub restait dans un seul clip donnait 8,8 % de frames en retard, un autre où il
 * franchissait une frontière en donnait 21 %, et on a attribué l'écart à un changement de
 * code qui n'y était pour rien. Tant que « avant » et « après » ne sont pas séparés, deux
 * mesures ne sont pas comparables — donc la sonde le fait elle-même plutôt que de compter
 * sur la discipline de celui qui teste.
 */
export function noteUiProbeClipSwitch(fromClipId: string | null, toClipId: string): void {
	if (!running) {
		return;
	}
	clipSwitches++;
	clipSwitchLog.push({ t: performance.now(), from: fromClipId ?? "-", to: toClipId });
}

/** Horodatage et destination de chaque bascule — pour distinguer une oscillation rapide
 *  (aller-retour au voisinage d'une frontière) d'un étalement normal. Les deux n'appellent
 *  pas le même remède : un anti-rebond pour la première, une correction de la logique de
 *  résolution de clip pour la seconde. */
const clipSwitchLog: { t: number; from: string; to: string }[] = [];

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
	// La source du scrub fait partie de l'étiquette : `scrub-tl` et `scrub-bar` sont deux
	// chemins de code distincts, les confondre masquerait précisément l'écart qu'on cherche.
	const base: BaseState = scrubbing
		? previewActive
			? `scrub-${scrubbing === "timeline" ? "tl" : "bar"}+preview`
			: `scrub-${scrubbing === "timeline" ? "tl" : "bar"}`
		: previewActive
			? "preview"
			: "repos";
	return `${base}@${clipSwitches}`;
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
	// Trié par état puis par nombre de bascules, pour que « avant / après le 1er
	// changement de clip » se lisent l'un sous l'autre.
	const states = [...buckets.keys()].sort((a, b) => {
		const order = [
			"repos",
			"preview",
			"scrub-tl",
			"scrub-tl+preview",
			"scrub-bar",
			"scrub-bar+preview",
		];
		const [ba, na] = a.split("@");
		const [bb, nb] = b.split("@");
		return order.indexOf(ba) - order.indexOf(bb) || Number(na) - Number(nb);
	});
	for (const state of states) {
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
			`${state.padEnd(18)} n=${String(s.length).padStart(5)}  ` +
				`p50=${q(50).toFixed(1)}  p90=${q(90).toFixed(1)}  p99=${q(99).toFixed(1)}  ` +
				`max=${s[s.length - 1].toFixed(1)}  ` +
				`>25ms=${((late / s.length) * 100).toFixed(1)}%  >40ms=${((veryLate / s.length) * 100).toFixed(1)}%`,
		);
	}
	// Nombre d'éléments `<video>` vivants. Le `<video>` de la preview est keyé sur l'id du
	// clip : React le remonte à chaque bascule. Si ce compte grimpe, des éléments média
	// orphelins survivent avec leur décodeur — ce qui expliquerait une dégradation qui
	// PERSISTE après un franchissement au lieu d'être un coût transitoire.
	const videos = document.querySelectorAll("video").length;
	console.warn(
		`[ui-probe] intervalles rAF en ms — ${clipSwitches} bascule(s) de clip, ${videos} <video> vivants\n${rows.join("\n")}`,
	);
	summarizeClipSwitches();
}

/**
 * Caractérise les bascules de clip : rafale ou étalement ?
 *
 * Une même manipulation a produit 2 changements voulus par l'utilisateur et 30 bascules
 * réelles. Reste à savoir si elles arrivent groupées — un aller-retour au voisinage d'une
 * frontière, qui appelle un anti-rebond — ou réparties, ce qui désignerait plutôt la
 * résolution de clip elle-même. On mesure donc l'écart entre bascules consécutives.
 */
function summarizeClipSwitches() {
	if (clipSwitchLog.length < 2) {
		return;
	}
	const gaps: number[] = [];
	for (let i = 1; i < clipSwitchLog.length; i++) {
		gaps.push(clipSwitchLog[i].t - clipSwitchLog[i - 1].t);
	}
	const burst = gaps.filter((g) => g < 500).length;
	const sorted = [...gaps].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)];
	// Un aller-retour = la destination d'une bascule redevient la source de la suivante.
	let flapping = 0;
	for (let i = 2; i < clipSwitchLog.length; i++) {
		if (clipSwitchLog[i].to === clipSwitchLog[i - 2].to) {
			flapping++;
		}
	}
	console.warn(
		`[ui-probe] bascules : ${clipSwitchLog.length} au total, ` +
			`${burst} à moins de 500 ms de la précédente, écart médian ${median.toFixed(0)} ms, ` +
			`${flapping} aller-retours (A→B→A)\n` +
			`  dernières : ${clipSwitchLog
				.slice(-8)
				.map((s) => `${s.from.slice(-4)}→${s.to.slice(-4)}`)
				.join("  ")}`,
	);
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
	clipSwitches = 0;
	clipSwitchLog.length = 0;
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
