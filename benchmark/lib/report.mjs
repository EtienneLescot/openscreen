/**
 * Turning a results document into something a person can act on.
 *
 * The design rule here is that nothing is allowed to look like a clean win when it isn't. A
 * row whose output failed verification, or whose driver could not apply the scenario, carries
 * that on its face — an app that renders fewer effects is not faster, and an app that wrote a
 * 720p file has not competed at all.
 */
import { mad, median } from "./measure.mjs";

const fmtMs = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(2)} s`);
const fmtMB = (b) => (b == null ? "—" : `${(b / 1048576).toFixed(1)} MB`);

/** Statistics over the scoring runs only — the warm-up is kept in the data but not the table. */
export function summarise(appResult) {
	const scoring = (appResult.runs ?? []).filter((r) => !r.warmup && r.ok);
	const attempted = (appResult.runs ?? []).filter((r) => !r.warmup);
	const times = scoring.map((r) => r.exportMs).filter((x) => x != null);
	const warmup = (appResult.runs ?? []).find((r) => r.warmup);

	return {
		app: appResult.app,
		displayName: appResult.displayName ?? appResult.app,
		version: appResult.version ?? null,
		automation: appResult.automation ?? null,
		kind: appResult.kind ?? null,
		skipped: !!appResult.skipped,
		reason: appResult.reason ?? null,
		fidelity: appResult.fidelity ?? null,
		n: scoring.length,
		attempted: attempted.length,
		medianMs: median(times),
		madMs: mad(times),
		minMs: times.length ? Math.min(...times) : null,
		maxMs: times.length ? Math.max(...times) : null,
		warmupMs: warmup?.exportMs ?? null,
		realtimeFactor: median(scoring.map((r) => r.realtimeFactor).filter(Boolean)),
		framesPerSecond: median(scoring.map((r) => r.framesPerSecond).filter(Boolean)),
		cpuSeconds: median(scoring.map((r) => r.cpuSeconds).filter((x) => x != null)),
		peakRssMiB: Math.max(0, ...scoring.map((r) => r.peakRssMiB ?? 0)) || null,
		outputSizeBytes: median(scoring.map((r) => r.outputSizeBytes).filter(Boolean)),
		foreignCpuPercent: median(scoring.map((r) => r.foreignCpuPercent).filter((x) => x != null)),
		outputProbe: scoring[0]?.outputProbe ?? attempted[0]?.outputProbe ?? null,
		visual: scoring[0]?.visual ?? attempted[0]?.visual ?? null,
		failures: attempted
			.filter((r) => !r.ok)
			.map((r) => ({
				run: r.run,
				error: r.error ?? null,
				verifyReasons: r.verifyReasons ?? [],
			})),
		notes: appResult.notes ?? [],
	};
}

function fidelityLabel(f) {
	if (!f) return "—";
	if (f.full) return "full";
	return `partial (${Math.round(f.score * 100)}% — missing ${f.missing.join(", ")})`;
}

export function renderReport(doc) {
	const rows = (doc.results ?? []).map(summarise);
	const ran = rows.filter((r) => !r.skipped && r.medianMs != null);
	const floor = rows.find((r) => r.app === "ffmpeg-baseline");
	// Full-fidelity rows are ranked against each other; a partial row did less work and is
	// listed after them so the table cannot be read as "this app is faster".
	const ranked = [...ran].sort((a, b) => {
		const af = a.fidelity?.full ? 0 : 1;
		const bf = b.fidelity?.full ? 0 : 1;
		return af !== bf ? af - bf : a.medianMs - b.medianMs;
	});

	const m = doc.machine ?? {};
	const src = doc.fixture?.probe?.video ?? {};

	/* ------------------------------------------------------------------ markdown ---------- */
	const md = [];
	md.push(`# Export benchmark — ${doc.scenario?.label ?? doc.scenario?.id}`);
	md.push("");
	md.push(
		`**Run** \`${doc.runId}\` · started ${doc.startedAt}${doc.finishedAt ? ` · finished ${doc.finishedAt}` : " · **incomplete**"}`,
	);
	md.push("");
	md.push(
		`**Machine** ${m.chip} · ${m.cpuCount} cores (${m.performanceCores}P/${m.efficiencyCores}E) · ${m.memoryGiB} GiB · ${m.osProduct} ${m.osVersion} (${m.osBuild})`,
	);
	md.push("");
	md.push(
		`**Source** ${src.width}×${src.height} @ ${src.fps} fps · ${doc.fixture?.probe?.durationSec}s · ${src.nbFrames} frames · sha256 \`${doc.fixture?.sha256?.slice(0, 16)}\``,
	);
	md.push("");
	md.push(
		`**Target output** ${doc.scenario?.output?.width}×${doc.scenario?.output?.height} @ ${doc.scenario?.output?.fps} fps ${doc.scenario?.output?.videoCodec}/${doc.scenario?.output?.container} — every app pinned to the same thing.`,
	);
	md.push("");
	md.push(
		`**Repetitions** ${doc.repetitions}${doc.discardFirst ? " scoring runs, after one discarded warm-up" : " (no warm-up discarded)"} · ${doc.cooldownSec}s cooldown between runs.`,
	);
	md.push("");

	md.push("## Results");
	md.push("");
	md.push(
		"| # | App | Version | Export (median) | ×realtime | Render fps | vs floor | CPU·s | Peak RSS | Output | Fidelity | How it was driven |",
	);
	md.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
	for (const [i, r] of ranked.entries()) {
		const vsFloor =
			floor?.medianMs && r.medianMs ? `${(r.medianMs / floor.medianMs).toFixed(2)}×` : "—";
		md.push(
			`| ${i + 1} | **${r.displayName}** | ${r.version ?? "—"} | ${fmtMs(r.medianMs)}${r.madMs ? ` ±${(r.madMs / 1000).toFixed(2)}` : ""} | ${r.realtimeFactor ?? "—"}× | ${r.framesPerSecond ?? "—"} | ${vsFloor} | ${r.cpuSeconds ?? "—"} | ${r.peakRssMiB ? `${r.peakRssMiB} MiB` : "—"} | ${r.foreignCpuPercent != null ? `${r.foreignCpuPercent}%` : "—"} | ${fmtMB(r.outputSizeBytes)} | ${fidelityLabel(r.fidelity)} | \`${r.automation ?? "—"}\` |`,
		);
	}
	const notRun = rows.filter((r) => r.skipped || r.medianMs == null);
	if (notRun.length) {
		md.push("");
		md.push("### Not measured");
		md.push("");
		for (const r of notRun) {
			md.push(
				`- **${r.displayName}** — ${r.reason ?? "no successful scoring run"}${
					r.failures.length
						? `; failures: ${r.failures
								.map((f) => f.error ?? f.verifyReasons.join(", "))
								.join(" | ")
								.slice(0, 400)}`
						: ""
				}`,
			);
		}
	}

	md.push("");
	md.push("## Reading this table");
	md.push("");
	md.push(
		"- **Export (median)** is wall-clock from the instant the export is committed to the moment the last byte lands in the output file. Warm-up, project loading and app launch are excluded for every app alike; `±` is the median absolute deviation across scoring runs.",
	);
	md.push("- **×realtime** is output duration ÷ export time. Above 1 means faster than playback.");
	md.push(
		'- **vs floor** compares against `ffmpeg (re-encode floor)`, a plain transcode with no compositing. It separates "this encoder is slow on this machine" from "this app\'s pipeline is slow".',
	);
	md.push(
		"- **Fidelity** is how much of the scenario the app actually applied. A `partial` row did less work and its time is not comparable — it is shown for reference, not ranking.",
	);
	md.push(
		"- **How it was driven** records the automation rung: `cli` is scripted headlessly, `menu` is System Events driving named menu items, `menu+coords` means some step needed pixel clicking and is the least reproducible.",
	);
	md.push("");

	for (const r of rows.filter((x) => x.notes?.length || x.failures?.length)) {
		md.push(`### ${r.displayName}`);
		md.push("");
		for (const n of r.notes ?? []) md.push(`- ${n}`);
		for (const f of r.failures ?? []) {
			md.push(
				`- run ${f.run} failed: ${f.error ?? ""} ${f.verifyReasons.length ? `(output: ${f.verifyReasons.join("; ")})` : ""}`.trim(),
			);
		}
		if (r.outputProbe) {
			const p = r.outputProbe;
			md.push(
				`- produced ${p.video?.width}×${p.video?.height} @ ${p.video?.fps} fps, ${p.video?.codec}, ${p.durationSec?.toFixed(2)}s, ${fmtMB(p.sizeBytes)}`,
			);
		}
		md.push("");
	}

	/* -------------------------------------------------------------------- summary --------- */
	const winner = ranked.find((r) => r.fidelity?.full);
	const os = ranked.find((r) => r.app === "openscreen-cli");
	const summaryText = ranked.length
		? [
				`${ranked.length} apps measured.`,
				winner
					? `Fastest at full fidelity: ${winner.displayName} at ${fmtMs(winner.medianMs)} (${winner.realtimeFactor}× realtime).`
					: "",
				os && winner && os.app !== winner.app
					? `OpenScreen (CLI): ${fmtMs(os.medianMs)} — ${(os.medianMs / winner.medianMs).toFixed(2)}× the leader.`
					: "",
			]
				.filter(Boolean)
				.join(" ")
		: "No app produced a measurable, verified export.";

	return {
		markdown: md.join("\n"),
		html: renderHtml(doc, rows, ranked, floor, summaryText),
		summaryText,
		rows,
	};
}

/* ------------------------------------------------------------------------ html ----------- */

const escapeHtml = (s) =>
	String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);

function renderHtml(doc, rows, ranked, floor, summaryText) {
	const m = doc.machine ?? {};
	const src = doc.fixture?.probe?.video ?? {};
	const maxMs = Math.max(1, ...ranked.map((r) => r.medianMs ?? 0));

	const bars = ranked
		.map((r) => {
			const pct = ((r.medianMs ?? 0) / maxMs) * 100;
			const partial = !r.fidelity?.full;
			return `<div class="bar-row">
        <div class="bar-label">${escapeHtml(r.displayName)}${partial ? '<span class="tag">partial</span>' : ""}</div>
        <div class="bar-track"><div class="bar-fill${partial ? " partial" : ""}" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="bar-value">${fmtMs(r.medianMs)} <span class="muted">${r.realtimeFactor ?? "—"}×</span></div>
      </div>`;
		})
		.join("\n");

	const tableRows = ranked
		.map((r, i) => {
			const vsFloor =
				floor?.medianMs && r.medianMs ? `${(r.medianMs / floor.medianMs).toFixed(2)}×` : "—";
			return `<tr>
        <td class="num">${i + 1}</td>
        <td><strong>${escapeHtml(r.displayName)}</strong><br><span class="muted">${escapeHtml(r.version ?? "")}</span></td>
        <td class="num">${fmtMs(r.medianMs)}${r.madMs ? `<br><span class="muted">±${(r.madMs / 1000).toFixed(2)}</span>` : ""}</td>
        <td class="num">${r.realtimeFactor ?? "—"}×</td>
        <td class="num">${r.framesPerSecond ?? "—"}</td>
        <td class="num">${vsFloor}</td>
        <td class="num">${r.cpuSeconds ?? "—"}</td>
        <td class="num">${r.peakRssMiB ? `${r.peakRssMiB}` : "—"}</td>
        <td class="num">${fmtMB(r.outputSizeBytes)}</td>
        <td>${r.fidelity?.full ? '<span class="ok">full</span>' : `<span class="warn">${escapeHtml(fidelityLabel(r.fidelity))}</span>`}</td>
        <td><code>${escapeHtml(r.automation ?? "—")}</code></td>
      </tr>`;
		})
		.join("\n");

	const notRun = rows
		.filter((r) => r.skipped || r.medianMs == null)
		.map(
			(r) =>
				`<li><strong>${escapeHtml(r.displayName)}</strong> — ${escapeHtml(r.reason ?? "no successful scoring run")}</li>`,
		)
		.join("\n");

	return `<title>Export Benchmark</title>
<style>
  :root {
    --bg:#ffffff; --fg:#16181d; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb;
    --accent:#3b5bdb; --accent-soft:#dbe4ff; --ok:#0f7b3f; --warn:#9a5b00;
  }
  :root:not([data-theme="light"]) { }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#0e1014; --fg:#e6e8ec; --muted:#9aa3b2; --line:#242833; --card:#161a21;
      --accent:#8ba4ff; --accent-soft:#22304f; --ok:#5ddc9a; --warn:#f0b64c;
    }
  }
  :root[data-theme="dark"] {
    --bg:#0e1014; --fg:#e6e8ec; --muted:#9aa3b2; --line:#242833; --card:#161a21;
    --accent:#8ba4ff; --accent-soft:#22304f; --ok:#5ddc9a; --warn:#f0b64c;
  }
  body { background:var(--bg); color:var(--fg); font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; margin:0; padding:2.5rem 1.25rem 4rem; }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size:1.75rem; letter-spacing:-0.02em; margin:0 0 .35rem; }
  h2 { font-size:1.1rem; margin:2.5rem 0 .75rem; letter-spacing:-0.01em; }
  .sub { color:var(--muted); margin:0 0 2rem; }
  .facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:.75rem; margin:0 0 2rem; }
  .fact { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:.7rem .85rem; }
  .fact dt { color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; margin:0 0 .2rem; }
  .fact dd { margin:0; font-weight:600; font-size:.9rem; }
  .bar-row { display:grid; grid-template-columns:minmax(150px,210px) 1fr minmax(120px,auto); gap:.85rem; align-items:center; margin:.4rem 0; }
  .bar-label { font-size:.88rem; font-weight:600; }
  .bar-track { background:var(--card); border:1px solid var(--line); border-radius:6px; height:22px; overflow:hidden; }
  .bar-fill { background:var(--accent); height:100%; border-radius:5px 0 0 5px; }
  .bar-fill.partial { background:repeating-linear-gradient(45deg,var(--accent-soft),var(--accent-soft) 6px,var(--card) 6px,var(--card) 12px); border-right:2px solid var(--accent); }
  .bar-value { font-variant-numeric:tabular-nums; font-size:.85rem; text-align:right; }
  .tag { background:var(--accent-soft); color:var(--fg); font-size:.62rem; text-transform:uppercase; letter-spacing:.05em; padding:.1rem .35rem; border-radius:4px; margin-left:.4rem; vertical-align:middle; }
  .scroll { overflow-x:auto; border:1px solid var(--line); border-radius:10px; }
  table { border-collapse:collapse; width:100%; font-size:.83rem; }
  th, td { padding:.5rem .6rem; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
  th { background:var(--card); font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); white-space:nowrap; }
  tr:last-child td { border-bottom:0; }
  td.num { font-variant-numeric:tabular-nums; white-space:nowrap; }
  .muted { color:var(--muted); font-size:.8em; }
  .ok { color:var(--ok); font-weight:600; }
  .warn { color:var(--warn); }
  code { background:var(--card); border:1px solid var(--line); border-radius:4px; padding:.05rem .3rem; font-size:.85em; }
  ul { padding-left:1.1rem; }
  li { margin:.3rem 0; }
  .note { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:0 8px 8px 0; padding:.8rem 1rem; margin:1rem 0; font-size:.88rem; }
</style>
<main>
  <h1>Export benchmark</h1>
  <p class="sub">${escapeHtml(doc.scenario?.label ?? "")} · run <code>${escapeHtml(doc.runId ?? "")}</code></p>

  <div class="facts">
    <dl class="fact"><dt>Machine</dt><dd>${escapeHtml(m.chip ?? "?")} · ${m.memoryGiB} GiB</dd></dl>
    <dl class="fact"><dt>macOS</dt><dd>${escapeHtml(m.osVersion ?? "?")} (${escapeHtml(m.osBuild ?? "")})</dd></dl>
    <dl class="fact"><dt>Source</dt><dd>${src.width}×${src.height} @ ${src.fps} · ${doc.fixture?.probe?.durationSec}s</dd></dl>
    <dl class="fact"><dt>Target</dt><dd>${doc.scenario?.output?.width}×${doc.scenario?.output?.height} @ ${doc.scenario?.output?.fps} ${escapeHtml(doc.scenario?.output?.videoCodec ?? "")}</dd></dl>
    <dl class="fact"><dt>Repetitions</dt><dd>${doc.repetitions}${doc.discardFirst ? " + warm-up" : ""}</dd></dl>
  </div>

  <div class="note">${escapeHtml(summaryText)}</div>

  <h2>Export time — lower is better</h2>
  ${bars || "<p class='muted'>Nothing measured.</p>"}

  <h2>Full results</h2>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>#</th><th>App</th><th>Export (median)</th><th>×RT</th><th>Render fps</th>
        <th>vs floor</th><th>CPU·s</th><th>Peak MiB</th><th>Output</th><th>Fidelity</th><th>Driven by</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>

  ${notRun ? `<h2>Not measured</h2><ul>${notRun}</ul>` : ""}

  <h2>Method</h2>
  <ul>
    <li>The clock starts the instant the export is committed and stops when the output file stops growing — the same stopwatch for the CLI apps and the ones driven through their menus.</li>
    <li>Every output is re-probed and checked against the pinned target; a file that is the wrong size, rate or length is failed, not counted as a fast run.</li>
    <li><strong>Fidelity</strong> marks how much of the scenario each app could express. Hatched bars did less work, so their time is a reference, not a ranking.</li>
    <li>Source clip is generated from a seeded spec, not shipped — the sha256 above is what makes two machines comparable.</li>
  </ul>
</main>`;
}
