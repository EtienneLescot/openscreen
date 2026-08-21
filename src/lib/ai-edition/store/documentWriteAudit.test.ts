// Every path that can reach the undo stack, pinned.
//
// #433 has now produced three rounds of the SAME defect: a write the user never
// made recording itself as the thing their next Ctrl+Z reverses. Each round the
// fix was aimed at the instance.
//
//   1. `setDocument` was the only writer that recorded, so nothing the user did
//      was on the stack at all.
//   2. `probeAndCorrectClip` -- a background duration probe -- recorded, because
//      `history` defaulted to `true` and the probe said nothing. Making the option
//      REQUIRED was supposed to end it: omitting it is now a compile error.
//   3. It did not. `projectStore.replaceTimeline(intervals, reason)` hardcoded
//      `{ history: true }` INSIDE itself, so the option never appeared in the
//      signature its callers see and no compile error could reach them. Its one
//      caller is the unattended recording import that runs on editor mount, so a
//      user landed in a brand-new project with `past.length === 1` and their first
//      Ctrl+Z emptied the timeline.
//
// The compiler can force a DIRECT call site to decide. It cannot see that the
// function doing the deciding had no business deciding. That is a judgement about
// who triggered the write, and the only place to record a judgement is next to the
// code, in a table somebody has to edit.
//
// So: this file is the table. A new write, a moved one, or a changed `history`
// value fails here with a diff, and the only way to make it pass is to write down
// what triggers it. `recordHistory` is unreachable except through the two writers
// enumerated below, which the last two tests pin as well -- so the table is the
// whole surface, not a sample of it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = resolve(ROOT, "src");

/** What made this write happen. The judgement the compiler cannot make. */
type Trigger =
	/** The user did something. Records an undo step. */
	| "gesture"
	/** Nobody asked: a probe, a background job, an auto-import, a persist that
	 *  follows an undo, or the optimistic half of an optimistic-then-save pair.
	 *  Records nothing. */
	| "automatic"
	/** A wrapper. Hands its caller's option straight through, so the decision stays
	 *  with whoever knows the answer. `forwarded` is checked structurally: the
	 *  identifier passed on must be a PARAMETER of the enclosing function. */
	| "forwarded";

interface WritePath {
	file: string;
	/** Nearest named function around the call. */
	fn: string;
	writer: "saveDocument" | "setDocument";
	trigger: Trigger;
}

// ---------------------------------------------------------------------------
// The table. Sorted by file, then function, then writer — same order the scan
// produces, so a failure reads as a plain diff.
// ---------------------------------------------------------------------------

const DECLARED: WritePath[] = [
	// Dropping the legacy auto-caption annotations is a button in the captions pane.
	w(
		"src/components/ai-edition/CaptionsPane.tsx",
		"clearLegacyCaptionAnnotations",
		"save",
		"gesture",
	),

	// The persist that follows an undo. Recording it would undo the undo.
	w("src/components/ai-edition/NewEditorShell.tsx", "NewEditorShell", "save", "automatic"),
	// "Save" on the unsaved-changes prompt.
	w("src/components/ai-edition/NewEditorShell.tsx", "handleConfirmUnsaved", "save", "gesture"),
	// The probed duration folded into the document when the <video> loads. Twice:
	// the first clip seed, and the backfill for clips still on a placeholder length.
	w("src/components/ai-edition/NewEditorShell.tsx", "handleLoadedMetadata", "save", "automatic"),
	w("src/components/ai-edition/NewEditorShell.tsx", "handleLoadedMetadata", "save", "automatic"),
	// Renaming the project from the title field.
	w("src/components/ai-edition/NewEditorShell.tsx", "handleRenameProject", "save", "gesture"),
	// Ctrl+S / File > Save.
	w("src/components/ai-edition/NewEditorShell.tsx", "handleSave", "save", "gesture"),
	// "Save" chosen on the way out of Ctrl+N and Ctrl+O.
	w("src/components/ai-edition/NewEditorShell.tsx", "onKey", "save", "gesture"),
	w("src/components/ai-edition/NewEditorShell.tsx", "onKey", "save", "gesture"),
	// Ctrl+V of a copied region: zoom, annotation, or a legacy span.
	w("src/components/ai-edition/NewEditorShell.tsx", "pasteRegion", "save", "gesture"),
	w("src/components/ai-edition/NewEditorShell.tsx", "pasteRegion", "save", "gesture"),
	w("src/components/ai-edition/NewEditorShell.tsx", "pasteRegion", "save", "gesture"),
	// The window is closing and the user answered "save".
	w("src/components/ai-edition/NewEditorShell.tsx", "unsubSaveBeforeClose", "save", "gesture"),

	// The agent's document. The optimistic write is not the edit — the save is, and
	// it names the pre-agent document as what Ctrl+Z returns to.
	w(
		"src/lib/ai-edition/store/agentDocumentApply.ts",
		"applyAgentDocumentIfCurrent",
		"save",
		"gesture",
	),
	w(
		"src/lib/ai-edition/store/agentDocumentApply.ts",
		"applyAgentDocumentIfCurrent",
		"set",
		"automatic",
	),

	// Linking the camera track found next to a newly added asset. Part of the
	// import, not an edit of its own.
	w("src/lib/ai-edition/store/projectStore.ts", "addAsset", "save", "automatic"),
	// THE round-3 fix. This is the shape that defeated round 2: a store action that
	// writes on someone else's behalf. It forwards now, so its callers decide.
	w("src/lib/ai-edition/store/projectStore.ts", "replaceTimeline", "save", "forwarded"),

	// A transcription verdict remembered on the asset, and a transcript arriving
	// from a background whisper job. Neither is an edit.
	w(
		"src/lib/ai-edition/store/transcriptionStore.ts",
		"persistPermanentFailure",
		"save",
		"automatic",
	),
	w("src/lib/ai-edition/store/transcriptionStore.ts", "runJob", "save", "automatic"),

	// Caption settings. Every pair is one optimistic `setDocument` (automatic) plus
	// the save that is the actual edit and names the pre-edit document.
	w("src/lib/ai-edition/store/useCaptions.ts", "commit", "save", "gesture"),
	w("src/lib/ai-edition/store/useCaptions.ts", "deleteTranslation", "save", "gesture"),
	w("src/lib/ai-edition/store/useCaptions.ts", "deleteTranslation", "set", "automatic"),
	w("src/lib/ai-edition/store/useCaptions.ts", "saveTranslation", "save", "gesture"),
	w("src/lib/ai-edition/store/useCaptions.ts", "saveTranslation", "set", "automatic"),
	w("src/lib/ai-edition/store/useCaptions.ts", "set", "save", "gesture"),
	w("src/lib/ai-edition/store/useCaptions.ts", "set", "set", "automatic"),
	// A slider mid-drag: sixty of these a second, one undo step for the lot, opened
	// by the commit above.
	w("src/lib/ai-edition/store/useCaptions.ts", "setLive", "set", "automatic"),

	// Editor settings — same live/commit split, same reasoning.
	w("src/lib/ai-edition/store/useEditorSettings.ts", "commit", "save", "gesture"),
	w("src/lib/ai-edition/store/useEditorSettings.ts", "set", "save", "gesture"),
	w("src/lib/ai-edition/store/useEditorSettings.ts", "set", "set", "automatic"),
	w("src/lib/ai-edition/store/useEditorSettings.ts", "setLive", "set", "automatic"),

	// The serialised timeline-op queue. Another wrapper: it used to hardcode
	// `{ history: true }`, which was right for both of today's callers and would have
	// been wrong for the first background one.
	w("src/lib/ai-edition/store/useSequentialTimelineOps.ts", "apply", "save", "forwarded"),

	// Every timeline edit the user makes with the mouse or the keyboard.
	w("src/lib/ai-edition/store/useTimeline.ts", "addAnnotation", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addCameraFullscreen", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addSpeed", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addTrim", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addZoom", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addZoomsBulk", "save", "gesture"),
	// The two drag commits. One undo step per gesture, recorded on release and only
	// if the write lands — `historyBase` carries the pre-drag document.
	w("src/lib/ai-edition/store/useTimeline.ts", "commitAnnotationChange", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "commitZoomFocus", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "duplicateClip", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "insertClipAt", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "moveClip", "save", "gesture"),
	// The round-2 defect: a background duration probe every freshly imported asset
	// fires, because `addAsset` never populates `durationSec`.
	w("src/lib/ai-edition/store/useTimeline.ts", "probeAndCorrectClip", "save", "automatic"),
	w("src/lib/ai-edition/store/useTimeline.ts", "removeClip", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "removeRegion", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "removeRegions", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "setTrimEntries", "save", "gesture"),
	// The live halves of the two drags.
	w("src/lib/ai-edition/store/useTimeline.ts", "updateAnnotationLive", "set", "automatic"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateAnnotationSpan", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateCameraFullscreenSpan", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateClipCrop", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateClipSourceRange", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateSpeedSpan", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateSpeedValue", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateTrim", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateZoomDepth", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateZoomFocusLive", "set", "automatic"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateZoomFocusMode", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateZoomRotation", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "updateZoomSpan", "save", "gesture"),
	// Source-dimension backfill for assets a migration left unprobed. On load, for
	// every project, whether or not the user touches anything.
	w("src/lib/ai-edition/store/useTimeline.ts", "useTimeline", "save", "automatic"),
];

function w(file: string, fn: string, writer: "save" | "set", trigger: Trigger): WritePath {
	return { file, fn, writer: writer === "save" ? "saveDocument" : "setDocument", trigger };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const WRITERS = new Set(["saveDocument", "setDocument"]);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = resolve(dir, entry);
		if (statSync(full).isDirectory()) return sourceFiles(full);
		if (!/\.tsx?$/.test(entry) || /\.(test|spec)\.tsx?$/.test(entry)) return [];
		return [full];
	});
}

function calleeName(call: ts.CallExpression): string | null {
	if (ts.isIdentifier(call.expression)) return call.expression.text;
	if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
	return null;
}

type FunctionLike =
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction
	| ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node)
	);
}

/** The name a reader would use for this function: its own, or the binding it is
 *  assigned to through however many `useCallback(...)` wrappers. */
function nameOf(fn: FunctionLike): string | null {
	if (
		!ts.isArrowFunction(fn) &&
		!ts.isFunctionExpression(fn) &&
		fn.name &&
		ts.isIdentifier(fn.name)
	)
		return fn.name.text;
	let node: ts.Node | undefined = fn.parent;
	while (node && (ts.isCallExpression(node) || ts.isParenthesizedExpression(node))) {
		node = node.parent;
	}
	if (node && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
	if (node && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) return node.name.text;
	if (node && ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
	return null;
}

/** The innermost enclosing function that has a name, and the chain down to the call —
 *  `forwarded` needs the chain to check the identifier really is a parameter. */
function enclosingFunctions(call: ts.Node): { name: string; functions: FunctionLike[] } {
	const functions: FunctionLike[] = [];
	let node: ts.Node | undefined = call.parent;
	let name: string | null = null;
	while (node) {
		if (isFunctionLike(node)) {
			functions.push(node);
			name ??= nameOf(node);
		}
		node = node.parent;
	}
	return { name: name ?? "<module>", functions };
}

function triggerOf(call: ts.CallExpression, functions: FunctionLike[]): Trigger | string {
	const opts = call.arguments.at(-1);
	if (!opts) return "no options argument";
	if (ts.isIdentifier(opts)) {
		// A wrapper only counts as forwarding if what it passes on came from OUTSIDE.
		// A local `const opts = { history: true }` is a hardcode wearing a disguise.
		const isParameter = functions.some((fn) =>
			fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === opts.text),
		);
		return isParameter ? "forwarded" : `local variable \`${opts.text}\``;
	}
	if (!ts.isObjectLiteralExpression(opts)) return "options are not an object literal";
	const history = opts.properties.find(
		(p) => p.name && ts.isIdentifier(p.name) && p.name.text === "history",
	);
	if (!history || !ts.isPropertyAssignment(history)) return "no `history` property";
	if (history.initializer.kind === ts.SyntaxKind.TrueKeyword) return "gesture";
	if (history.initializer.kind === ts.SyntaxKind.FalseKeyword) return "automatic";
	return "`history` is computed, so nobody decided";
}

interface Scan {
	writes: WritePath[];
	/** A Map, not an object: `calleeName` returns whatever the source says, and
	 *  `"toString" in {}` is true. */
	callsTo: Map<string, { file: string; fn: string }[]>;
}

function scan(): Scan {
	const writes: WritePath[] = [];
	const callsTo = new Map<string, { file: string; fn: string }[]>([
		["pushHistory", []],
		["recordHistory", []],
	]);
	for (const path of sourceFiles(SRC)) {
		const file = relative(ROOT, path).split("\\").join("/");
		const source = ts.createSourceFile(
			path,
			readFileSync(path, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node)) {
				const callee = calleeName(node);
				const { name, functions } = callee ? enclosingFunctions(node) : { name: "", functions: [] };
				if (callee) callsTo.get(callee)?.push({ file, fn: name });
				if (callee && WRITERS.has(callee)) {
					writes.push({
						file,
						fn: name,
						writer: callee as WritePath["writer"],
						trigger: triggerOf(node, functions) as Trigger,
					});
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return { writes, callsTo };
}

function sortKey(path: WritePath): string {
	return `${path.file}#${path.fn}#${path.writer}#${path.trigger}`;
}

const scanned = scan();

describe("every write that can reach the undo stack", () => {
	it("is declared in the table above, with the trigger it actually writes", () => {
		// A failure here is not a broken test. It means a write path was added, moved
		// or reclassified, and nobody has said whether the user asked for it. Read the
		// diff, decide, and put the row in `DECLARED`.
		expect(scanned.writes.map(sortKey).sort()).toEqual(DECLARED.map(sortKey).sort());
	});

	// The table is only the whole surface while these two hold. `recordHistory` is
	// module-private to `projectStore`, and `pushHistory` is reachable from anywhere
	// that imports `undoStack` — so the stack grows one more entry point the moment
	// somebody calls it directly, and the table would stop being the audit.
	it("goes through `recordHistory`, which only `saveDocument` and `setDocument` call", () => {
		expect(scanned.callsTo.get("recordHistory")).toEqual([
			{ file: "src/lib/ai-edition/store/projectStore.ts", fn: "saveDocument" },
			{ file: "src/lib/ai-edition/store/projectStore.ts", fn: "setDocument" },
		]);
	});

	it("reaches `pushHistory` from `recordHistory` and nowhere else", () => {
		expect(scanned.callsTo.get("pushHistory")).toEqual([
			{ file: "src/lib/ai-edition/store/projectStore.ts", fn: "recordHistory" },
		]);
	});
});
