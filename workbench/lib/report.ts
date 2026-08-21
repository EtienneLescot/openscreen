// ponytail: JSON for machines, Markdown for people, and a write barrier in
// front of both.
//
// Two things a report must carry or it is worse than useless:
//   • the RUN FINGERPRINT — the sha of the system message the model actually
//     received, the sha of the tool surface, the model id, the git sha. Both
//     shas moved the day `createAgent` replaced `createDeepAgent` (system
//     8742 → 2968 chars, tools 25 → 17), which is exactly the kind of change
//     that would otherwise get blamed on whatever prompt edit happened that
//     week. Reports either side of a fingerprint change are NOT comparable.
//   • the MINIMUM DETECTABLE EFFECT at the n that was actually run, printed
//     above the numbers rather than in a footnote.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { containsSecret } from "./env";
import type { CheckResult, ScoredRun } from "./score";
import {
	formatInterval,
	formatPercent,
	minDetectableEffect,
	type Proportion,
	wilson95,
} from "./stats";
import type { WireTranscript } from "./wire";

export interface RunFingerprint {
	/** sha256 of the system message as sent, all blocks concatenated. */
	systemSha256: string;
	systemChars: number;
	toolsSha256: string;
	toolNames: string[];
	model: string;
	gitSha: string;
	gitDirty: boolean;
	overlayId: string | null;
	reps: number;
}

export interface CheckStat {
	id: string;
	axis: "behaviour" | "dsl";
	weight: number;
	passed: number;
	/** Répétitions observées, indéterminées comprises. */
	total: number;
	/**
	 * Répétitions restées `indéterminé`.
	 *
	 * ponytail: `wilson` est calculé sur `total − indeterminate`, donc une
	 * abstention RÉTRÉCIT n et l'intervalle s'élargit — la conséquence
	 * statistique juste, et déjà lisible dans une colonne que le rapport
	 * imprime. Le compte est quand même écrit à part : un intervalle large se
	 * confond avec un petit n, et les deux se corrigent différemment.
	 */
	indeterminate: number;
	wilson: Proportion;
	expected: boolean;
	/** First distinct evidence strings, capped so a report stays readable. */
	evidence: string[];
}

export interface ScenarioReport {
	scenarioId: string;
	title: string;
	tags: string[];
	gate: number;
	reps: number;
	behaviour: Proportion;
	dsl: Proportion;
	/** Mean of `min(behaviour, dsl)` over repetitions. */
	gateScoreMean: number;
	/** Wilson interval on the pass rate against the gate. */
	passRate: Proportion;
	failureClasses: Record<string, number>;
	checks: CheckStat[];
	/** Axes dont le poids indéterminé dépasse le poids tranché sur au moins une
	 *  répétition : leur taux n'est pas une mesure de l'axe. */
	unmeasuredAxes: string[];
	msMean: number;
}

export interface WorkbenchReport {
	label: string;
	createdAt: string;
	fingerprint: RunFingerprint;
	minDetectableEffect: number;
	scenarios: ScenarioReport[];
	/** Baseline messages: regressions, fixes to harvest, entries to review. */
	notices: string[];
}

function gitInfo(): { sha: string; dirty: boolean } {
	try {
		const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
		const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
		return { sha, dirty: status.trim().length > 0 };
	} catch {
		return { sha: "unknown", dirty: false };
	}
}

/**
 * `wire` est celui de la PREMIÈRE répétition — l'empreinte est la même sur
 * toutes, c'est la définition d'une empreinte. Le paramètre est le transcript
 * lui-même et non la liste des répétitions, parce que la passe du juge
 * (`wb:judge`) n'a pas de répétitions : elle relit des tours sur disque, dont
 * l'empreinte a été écrite avec eux.
 */
export function fingerprintOf(options: {
	wire:
		| Pick<WireTranscript, "systemSha256" | "systemChars" | "toolsSha256" | "toolNames">
		| undefined;
	model: string;
	overlayId?: string | null;
	reps: number;
}): RunFingerprint {
	const wire = options.wire;
	const git = gitInfo();
	return {
		systemSha256: wire?.systemSha256 ?? "unknown",
		systemChars: wire?.systemChars ?? 0,
		toolsSha256: wire?.toolsSha256 ?? "unknown",
		toolNames: wire?.toolNames ?? [],
		model: options.model,
		gitSha: git.sha,
		gitDirty: git.dirty,
		overlayId: options.overlayId ?? null,
		reps: options.reps,
	};
}

const MAX_EVIDENCE = 3;

/**
 * `results` n'est typé que sur `scored` : c'est tout ce que ce résumé lit, et
 * l'écrire ainsi laisse la passe du juge — qui reconstruit un `ScoredRun` depuis
 * un tour sur disque et n'a ni `run` ni `context` à offrir — passer par ici
 * plutôt que par une seconde implémentation qui divergerait.
 */
export function summarizeScenario(options: {
	scenarioId: string;
	title: string;
	tags: string[];
	gate: number;
	results: Array<{ scored: ScoredRun }>;
}): ScenarioReport {
	const { results } = options;
	const n = results.length;
	const stats = new Map<string, CheckStat>();
	const register = (axis: "behaviour" | "dsl", result: CheckResult) => {
		const entry = stats.get(result.id) ?? {
			id: result.id,
			axis,
			weight: result.weight,
			passed: 0,
			total: 0,
			indeterminate: 0,
			wilson: wilson95(0, 0),
			expected: false,
			evidence: [],
		};
		entry.total += 1;
		if (result.indeterminate) entry.indeterminate += 1;
		if (result.ok) entry.passed += 1;
		if (result.expected) entry.expected = true;
		if (result.evidence && entry.evidence.length < MAX_EVIDENCE) {
			if (!entry.evidence.includes(result.evidence)) entry.evidence.push(result.evidence);
		}
		stats.set(result.id, entry);
	};
	for (const result of results) {
		for (const check of result.scored.behaviour.results) register("behaviour", check);
		for (const check of result.scored.dsl.results) register("dsl", check);
	}
	// Sur les répétitions TRANCHÉES. Un check indéterminé deux fois sur trois est
	// un 1/1, pas un 1/3 : l'intervalle doit dire « une seule observation », pas
	// « deux échecs ».
	for (const entry of stats.values()) {
		entry.wilson = wilson95(entry.passed, entry.total - entry.indeterminate);
	}

	const failureClasses: Record<string, number> = {};
	for (const result of results) {
		const key = result.scored.failureClass;
		failureClasses[key] = (failureClasses[key] ?? 0) + 1;
	}

	const mean = (values: number[]) =>
		values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
	const behaviourMean = mean(results.map((r) => r.scored.behaviour.score));
	const dslMean = mean(results.map((r) => r.scored.dsl.score));
	const passes = results.filter((r) => r.scored.passed).length;

	return {
		scenarioId: options.scenarioId,
		title: options.title,
		tags: options.tags,
		gate: options.gate,
		reps: n,
		// Axis scores are weighted means, not counts; Wilson is carried on the
		// pass counts and the rate field holds the weighted mean.
		behaviour: { ...wilson95(Math.round(behaviourMean * n), n), rate: behaviourMean },
		dsl: { ...wilson95(Math.round(dslMean * n), n), rate: dslMean },
		gateScoreMean: mean(results.map((r) => r.scored.gateScore)),
		passRate: wilson95(passes, n),
		failureClasses,
		checks: [...stats.values()].sort((a, b) => a.id.localeCompare(b.id)),
		unmeasuredAxes: [
			...new Set(
				results.flatMap((r) => [
					...(r.scored.behaviour.measured ? [] : ["comportement"]),
					...(r.scored.dsl.measured ? [] : ["DSL"]),
				]),
			),
		],
		msMean: mean(results.map((r) => r.scored.ms)),
	};
}

export function renderMarkdown(report: WorkbenchReport): string {
	const lines: string[] = [];
	lines.push(`# Workbench — ${report.label}`);
	lines.push("");
	lines.push(`Généré le ${report.createdAt}.`);
	lines.push("");
	lines.push(
		`> **Effet minimal détectable à n=${report.fingerprint.reps} : ` +
			`${formatPercent(report.minDetectableEffect)}.** Toute différence plus petite ` +
			"que cette valeur est indistinguable du bruit — lisez cette ligne avant tout chiffre.",
	);
	lines.push("");
	lines.push("## Empreinte du run");
	lines.push("");
	lines.push("| champ | valeur |");
	lines.push("| --- | --- |");
	lines.push(`| modèle | \`${report.fingerprint.model}\` |`);
	lines.push(
		`| message système | ${report.fingerprint.systemChars} car., sha ` +
			`\`${report.fingerprint.systemSha256.slice(0, 12)}\` |`,
	);
	lines.push(
		`| outils annoncés | ${report.fingerprint.toolNames.length}, sha ` +
			`\`${report.fingerprint.toolsSha256.slice(0, 12)}\` |`,
	);
	lines.push(
		`| git | \`${report.fingerprint.gitSha}\`${report.fingerprint.gitDirty ? " (dirty)" : ""} |`,
	);
	lines.push(`| overlay | ${report.fingerprint.overlayId ?? "aucun"} |`);
	lines.push("");

	if (report.notices.length > 0) {
		lines.push("## À traiter");
		lines.push("");
		for (const notice of report.notices) lines.push(`- ${notice}`);
		lines.push("");
	}

	for (const scenario of report.scenarios) {
		lines.push(`## ${scenario.scenarioId} — ${scenario.title}`);
		lines.push("");
		lines.push(
			`tags: ${scenario.tags.join(", ") || "—"} · n=${scenario.reps} · ` +
				`gate ${formatPercent(scenario.gate)} · ${Math.round(scenario.msMean)} ms/tour`,
		);
		lines.push("");
		lines.push(
			`**comportement ${formatPercent(scenario.behaviour.rate)} · ` +
				`DSL ${formatPercent(scenario.dsl.rate)} · ` +
				`porte min() ${formatPercent(scenario.gateScoreMean)} · ` +
				`taux de passage ${formatPercent(scenario.passRate.rate)} ` +
				`${formatInterval(scenario.passRate)}**`,
		);
		lines.push("");
		const classes = Object.entries(scenario.failureClasses)
			.map(([key, count]) => `${key}×${count}`)
			.join(" · ");
		lines.push(`classes de tour : ${classes}`);
		lines.push("");
		if (scenario.unmeasuredAxes.length > 0) {
			// ponytail: au-dessus du tableau, jamais en note de bas de page. Le taux
			// d'un axe majoritairement indéterminé n'est pas un résultat faible,
			// c'est l'absence de résultat, et le lire comme un chiffre est
			// précisément l'erreur que le troisième verdict existe pour empêcher.
			lines.push(
				`> **Axe non mesuré : ${scenario.unmeasuredAxes.join(", ")}.** Le poids indéterminé ` +
					"y dépasse le poids tranché — le taux affiché ne porte que sur les checks tranchés " +
					"et la porte ne peut pas être déclarée passée.",
			);
			lines.push("");
		}
		lines.push("| check | axe | poids | k/n | indét. | Wilson 95% | statut |");
		lines.push("| --- | --- | --- | --- | --- | --- | --- |");
		for (const check of scenario.checks) {
			const decided = check.total - check.indeterminate;
			const status =
				decided === 0
					? "INDÉTERMINÉ"
					: check.passed === decided
						? check.indeterminate > 0
							? "ok (partiel)"
							: "ok"
						: check.expected
							? "connu"
							: "ÉCHEC";
			lines.push(
				`| \`${check.id}\` | ${check.axis} | ${check.weight} | ` +
					`${check.passed}/${decided} | ${check.indeterminate} | ` +
					`${formatInterval(check.wilson)} | ${status} |`,
			);
		}
		lines.push("");
		const withEvidence = scenario.checks.filter((c) => c.evidence.length > 0);
		if (withEvidence.length > 0) {
			lines.push("<details><summary>Preuves</summary>");
			lines.push("");
			for (const check of withEvidence) {
				lines.push(`- \`${check.id}\``);
				for (const evidence of check.evidence) lines.push(`  - ${evidence.replace(/\n/g, " ")}`);
			}
			lines.push("");
			lines.push("</details>");
			lines.push("");
		}
	}
	return `${lines.join("\n")}\n`;
}

export function buildReport(options: {
	label: string;
	fingerprint: RunFingerprint;
	scenarios: ScenarioReport[];
	notices: string[];
	now?: Date;
}): WorkbenchReport {
	return {
		label: options.label,
		createdAt: (options.now ?? new Date()).toISOString(),
		fingerprint: options.fingerprint,
		minDetectableEffect: minDetectableEffect(options.fingerprint.reps),
		scenarios: options.scenarios,
		notices: options.notices,
	};
}

/**
 * ponytail: the write barrier. A report interpolates model text, tool
 * arguments and error strings — any of which can quote a header the workbench
 * proxied. Refuse rather than scrub: a scrubbed file hides that something
 * carried the key in the first place.
 */
export function writeReportFile(file: string, payload: string): void {
	if (containsSecret(payload)) {
		throw new Error(
			`refus d'écrire ${file} : le payload contient la clé API ou un en-tête d'autorisation`,
		);
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, payload, "utf8");
}

export function writeReport(options: {
	directory: string;
	basename: string;
	report: WorkbenchReport;
}): { json: string; markdown: string } {
	const json = `${options.directory}/${options.basename}.json`;
	const markdown = `${options.directory}/${options.basename}.md`;
	writeReportFile(json, `${JSON.stringify(options.report, null, "\t")}\n`);
	writeReportFile(markdown, renderMarkdown(options.report));
	return { json, markdown };
}
