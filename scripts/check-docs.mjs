#!/usr/bin/env node
// Docs lint for technical-documentation/: relative links resolve, no legacy
// identifiers are presented as current, and every expected file is real.
// ponytail: three regex passes over ~30 files, no deps. Run: node scripts/check-docs.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = join(ROOT, "technical-documentation");

// Names of components / docs that no longer exist on this branch. A doc may only
// mention them inside a "removed / superseded" note, which lives in decisions.md.
const LEGACY = [
	"TimelinePane",
	"RightPanelStack",
	"Bottombar",
	"Titlebar",
	"TranscriptEditor",
	"ai-edition-roadmap",
	"ai-edition-collision-analysis",
	"openscreen-inventory",
	"axcut-inventory",
	"main-vs-ai-edition",
	"ai-edition-remediation",
	"v4-design-parity",
	"stt-whispercpp-migration-plan",
	"stt-whispercpp-dtw-poc-plan",
	"rendering-architecture.md",
	"timeline-coordinate-refactor",
	"cursor-feature-inventory",
	"provider-parity-plan",
	"github-actions-workflows",
	"ux-ui-spec",
];
const LEGACY_ALLOWED = new Set(["architecture/decisions.md"]);

const REQUIRED = [
	"README.md",
	"architecture/overview.md",
	"architecture/document-model.md",
	"architecture/timeline-model.md",
	"architecture/editor-shell.md",
	"architecture/preview.md",
	"architecture/native-compositor.md",
	"architecture/export-pipeline.md",
	"architecture/recording.md",
	"architecture/native-bridge.md",
	"architecture/transcription-and-captions.md",
	"architecture/ai-agent.md",
	"architecture/llm-providers.md",
	"architecture/cursor.md",
	"architecture/decisions.md",
	"engineering/rendering-performance.md",
	"engineering/build-and-packaging.md",
	"engineering/ci-workflows.md",
	"engineering/release-and-secrets.md",
	"testing/writing-tests.md",
	"testing/manual-e2e-checklist.md",
	"testing/native-cursor-diagnostics.md",
];

// `--only a.md,b/c.md` limits both checks to those docs-relative paths, so a
// task that owns a slice of the tree can gate on its slice alone.
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;
const owned = (rel) => !only || only.has(rel);

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "_harvest") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".md")) out.push(full);
	}
	return out;
}

const errors = [];
const files = walk(DOCS);

for (const abs of REQUIRED) {
	if (!owned(abs)) continue;
	const full = join(DOCS, abs);
	let lines = -1;
	try {
		lines = readFileSync(full, "utf8").split("\n").length;
	} catch {
		errors.push(`missing: technical-documentation/${abs}`);
		continue;
	}
	if (lines < 30) errors.push(`stub (${lines} lines): technical-documentation/${abs}`);
}

for (const file of files) {
	const rel = relative(DOCS, file).replaceAll("\\", "/");
	if (!owned(rel)) continue;
	const text = readFileSync(file, "utf8");

	// Relative markdown links must resolve.
	for (const [, target] of text.matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)/g)) {
		// `foo.ts:42` is the repo's source-anchor convention — the file must exist,
		// the line number is not part of the path.
		const resolved = resolve(dirname(file), target.replace(/:\d+$/, ""));
		try {
			statSync(resolved);
		} catch {
			// Scoped runs tolerate links to docs another task still owes.
			const pending = relative(DOCS, resolved).replaceAll("\\", "/");
			if (only && REQUIRED.includes(pending)) continue;
			errors.push(`${rel}: broken link → ${target}`);
		}
	}

	// No stale `docs/` path prefix.
	for (const [match] of text.matchAll(/(?<![\w/-])docs\/(?:architecture|engineering|testing|tests)\//g)) {
		errors.push(`${rel}: stale path prefix "${match}" (tree is technical-documentation/)`);
	}

	if (LEGACY_ALLOWED.has(rel)) continue;
	for (const name of LEGACY) {
		if (text.includes(name)) errors.push(`${rel}: mentions removed "${name}"`);
	}
}

if (errors.length) {
	console.error(`check-docs: ${errors.length} problem(s)\n`);
	for (const e of errors) console.error(`  ${e}`);
	process.exit(1);
}
console.log(`check-docs: OK (${files.length} files)`);
