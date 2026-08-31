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
// what triggers it.
//
// What a green run here means, exactly. The scan is SYNTACTIC: it walks the
// non-test `.ts`/`.tsx` under `src/`, matches calls on the callee's written name,
// and reads each one's trigger off the object literal at the call site. So the
// table covers every `saveDocument` / `setDocument` written as such in shipped
// renderer code, and the tests below it pin the names an entry can reach a stack
// through -- `recordHistory`, called only by those two writers, then `pushHistory`,
// plus undo/redo's own two pushes for the entries they step over.
//
// And the third writer, which neither of those names covers:
// `useProjectStore.setState({ document })` puts a document in the store around both
// of them. Four shipped sites do it -- undo's own restore, and the three rollbacks
// that put a document back when a save failed -- and every one of them means to,
// because none of them is an edit. But a `history` option that cannot be omitted is
// no guard at all against a writer that never takes one, so those sites are rows
// too, carrying `unrecorded`: out of scope for the stack, in scope for the
// guarantee, and a new one has to come here and say who asked. The match is keyed on
// the RECEIVER as well as the name, because `useTranscriptionStore.setState` is a
// different store and writes no document.
//
// What it does not see, so nobody reads more into that than is in it:
//   - INDIRECTION, both ways round. The callee name is whatever the source says,
//     so a write reached through an alias or a callback is not a row at all. And
//     `readonly` on the stacks is erased at runtime, so `(past as Snapshot[]).push(...)`
//     compiles, runs, and appears nowhere here -- the `@ts-expect-error`s below
//     pin the un-cast form only.
//   - DATAFLOW. `forwarded` asks where the identifier handed on was BOUND, not
//     what value arrives in it. A parameter reassigned to a hardcode is still a
//     parameter, and so is a callback parameter the same expression supplies from
//     a literal. Both read as forwarded; the last describe in this file pins them
//     saying so.
// Neither shape is in the tree today, and finding either is a reading job, not this
// file's. What this file guarantees is the part a reading job keeps missing: that
// nobody added a write in plain sight -- through either recording writer or straight
// into the store -- without saying who asked for it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { clearHistory, future, past } from "./undoStack";

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
	 *  identifier passed on must resolve to a PARAMETER, in the first enclosing
	 *  scope that binds that name — a local `const` of the same name is not a
	 *  forward, however many outer functions have a parameter called that. */
	| "forwarded"
	/** Not a recording writer at all. `useProjectStore.setState` writes the document
	 *  into the store directly, so nothing can reach the stacks from here and there is
	 *  no `history` option to decide — which is exactly why these are rows. Every one
	 *  of today's four is a restore, and a restore must not record: the entry it would
	 *  reverse is the one it is undoing. */
	| "unrecorded";

interface WritePath {
	file: string;
	/** Nearest named function around the call. */
	fn: string;
	writer: "saveDocument" | "setDocument" | "useProjectStore.setState";
	trigger: Trigger;
}

/** Short keys for the table below, spelled out here so a row stays one line. */
const WRITER_NAMES = {
	save: "saveDocument",
	set: "setDocument",
	state: "useProjectStore.setState",
} as const;

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
	// Putting the pre-agent document back when the save the user's edit depended on
	// failed. Straight into the store, so it cannot record — and must not: the entry
	// it would reverse was never pushed, because the save records only on success.
	w(
		"src/lib/ai-edition/store/agentDocumentApply.ts",
		"applyAgentDocumentIfCurrent",
		"state",
		"unrecorded",
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

	// Ctrl+Z / Ctrl+Shift+Z putting a snapshot back on screen. The one write in the
	// tree that MUST go around both recording writers: routing it through one meant an
	// undo re-recorded the document it had just replaced and cleared `future` on the
	// way past, so redo was gone before the user could reach for it.
	w("src/lib/ai-edition/store/undo.ts", "restore", "state", "unrecorded"),

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
	// The Edit Clip dialog's Apply: source range and crop composed into ONE save (#355),
	// where they used to be two writes that overwrote each other.
	w("src/lib/ai-edition/store/useTimeline.ts", "applyClipEdit", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addAnnotation", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addCameraFullscreen", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addSpeed", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addTrim", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addZoom", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "addZoomsBulk", "save", "gesture"),
	// The two drag commits. One undo step per gesture, recorded on release and only
	// if the write lands — `historyBase` carries the pre-drag document.
	w("src/lib/ai-edition/store/useTimeline.ts", "commitAnnotationChange", "save", "gesture"),
	// And the rollback each of them runs when that write does not land: the pre-drag
	// document back into the store, around the writers, so it records nothing. There is
	// nothing to take off either — the commit records only on success.
	w("src/lib/ai-edition/store/useTimeline.ts", "commitAnnotationChange", "state", "unrecorded"),
	w("src/lib/ai-edition/store/useTimeline.ts", "commitZoomFocus", "save", "gesture"),
	w("src/lib/ai-edition/store/useTimeline.ts", "commitZoomFocus", "state", "unrecorded"),
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

function w(
	file: string,
	fn: string,
	writer: keyof typeof WRITER_NAMES,
	trigger: Trigger,
): WritePath {
	return { file, fn, writer: WRITER_NAMES[writer], trigger };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** The two writers that take a `history` option, so the compiler can force their
 *  call sites to decide. `useProjectStore.setState` is the third writer and matches
 *  separately — see `isProjectStoreSetState`. */
const WRITERS = new Set(["saveDocument", "setDocument"]);

/**
 * `useProjectStore.setState(...)` written as such: a document into the store around
 * both recording writers, and the shape neither `WRITERS` nor the `history` option
 * can see.
 *
 * Keyed on the RECEIVER as well as the method name. `calleeName` returns the
 * property name alone, and `useTranscriptionStore.setState` — four calls in this
 * same directory — writes no document; matching on `setState` would file all four
 * as document writes.
 */
function objectLiteralHasDocument(obj: ts.ObjectLiteralExpression): boolean {
	return obj.properties.some((prop) => {
		if (ts.isSpreadAssignment(prop)) return false;
		const name = prop.name;
		if (!name) return false;
		if (ts.isIdentifier(name)) return name.text === "document";
		if (ts.isStringLiteral(name)) return name.text === "document";
		return false;
	});
}

function returnedObjectHasDocument(expr: ts.Expression): boolean {
	let node: ts.Expression = expr;
	while (ts.isParenthesizedExpression(node)) node = node.expression;
	// `useTimeline`'s two rollbacks return `cond ? { document } : {}`, so a branch counts:
	// the call CAN write a document, which is what the row is about.
	if (ts.isConditionalExpression(node)) {
		return returnedObjectHasDocument(node.whenTrue) || returnedObjectHasDocument(node.whenFalse);
	}
	if (ts.isBinaryExpression(node)) {
		return returnedObjectHasDocument(node.left) || returnedObjectHasDocument(node.right);
	}
	return ts.isObjectLiteralExpression(node) && objectLiteralHasDocument(node);
}

function writesDocumentProperty(arg: ts.Expression | undefined): boolean {
	if (!arg) return false;
	// `setState({ document, ... })`
	if (ts.isObjectLiteralExpression(arg)) return objectLiteralHasDocument(arg);
	// `setState((state) => ({ document, ... }))`. Three of the four production call sites
	// take this shape, so an object-literal-only check would drop them from the table.
	if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
		const body = arg.body;
		if (!ts.isBlock(body)) return returnedObjectHasDocument(body);
		return body.statements.some(
			(st) =>
				ts.isReturnStatement(st) && !!st.expression && returnedObjectHasDocument(st.expression),
		);
	}
	return false;
}

function isProjectStoreSetState(call: ts.CallExpression): boolean {
	const target = call.expression;
	if (
		!ts.isPropertyAccessExpression(target) ||
		!ts.isIdentifier(target.expression) ||
		target.expression.text !== "useProjectStore" ||
		target.name.text !== "setState"
	) {
		return false;
	}
	// The receiver alone is not enough: `useProjectStore.setState({ dirty: true })` writes no
	// document and must not become a row. Ask what the call actually writes.
	return writesDocumentProperty(call.arguments[0]);
}

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

/** The innermost enclosing function that has a name. */
function enclosingFunctionName(call: ts.Node): string {
	let node: ts.Node | undefined = call.parent;
	while (node) {
		if (isFunctionLike(node)) {
			const name = nameOf(node);
			if (name) return name;
		}
		node = node.parent;
	}
	return "<module>";
}

/** Every name a binding introduces, destructuring included. */
function bindsName(binding: ts.BindingName, name: string): boolean {
	if (ts.isIdentifier(binding)) return binding.text === name;
	return binding.elements.some(
		(element) => ts.isBindingElement(element) && bindsName(element.name, name),
	);
}

function declaresInList(list: ts.VariableDeclarationList, name: string): boolean {
	return list.declarations.some((declaration) => bindsName(declaration.name, name));
}

/** Whether this scope binds `name` as a LOCAL — the thing a forward is not. */
function scopeDeclaresLocal(scope: ts.Node, name: string): boolean {
	const declares = (statement: ts.Statement): boolean => {
		if (ts.isVariableStatement(statement)) return declaresInList(statement.declarationList, name);
		// `function opts() {}` and `class opts {}` bind the name exactly as a `const`
		// does, and shadow an outer parameter of that name exactly as one does. Reading
		// only variable statements meant the walk could not SEE those bindings, so it
		// carried on outwards and reported the shadowed parameter — answering "where was
		// this name bound" with a scope the name does not come from.
		if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
			return statement.name?.text === name;
		return false;
	};
	const inStatements = (statements: readonly ts.Statement[]) => statements.some(declares);
	if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope))
		return inStatements(scope.statements);
	if (ts.isCaseBlock(scope)) return scope.clauses.some((clause) => inStatements(clause.statements));
	if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope))
		return (
			!!scope.initializer &&
			ts.isVariableDeclarationList(scope.initializer) &&
			declaresInList(scope.initializer, name)
		);
	if (ts.isCatchClause(scope))
		return !!scope.variableDeclaration && bindsName(scope.variableDeclaration.name, name);
	return false;
}

/**
 * Where the identifier handed to a writer as its options argument was bound.
 *
 * The walk goes OUTWARD from the call and stops at the FIRST scope that binds the
 * name. Stopping is the point. The previous version collected every function-like
 * ancestor up to the module and asked whether ANY of them had a parameter of that
 * name, so a local `const opts = { history: true }` read as `forwarded` the moment
 * an unrelated outer function happened to have an `opts` parameter — which
 * `useSequentialTimelineOps` does, on the hook itself. That is precisely the
 * hardcode-in-a-disguise the check exists to expose.
 *
 * "The innermost function's parameters" is not the rule either, though, and the
 * walk has to leave that function: `useSequentialTimelineOps.apply` calls
 * `saveDocument(applied.document, opts)` inside a zero-parameter `async () => {}`,
 * and `opts` is the parameter of the `useCallback` arrow two scopes further out.
 */
/** Scopes that bind parameters. Wider than `isFunctionLike`, which exists to NAME a
 *  function: a constructor and a `set` accessor take parameters but have no name a
 *  reader would use for a write site, so they belong here and not there. */
function declaresParameter(node: ts.Node, name: string): boolean {
	if (
		isFunctionLike(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	) {
		return node.parameters.some((p) => bindsName(p.name, name));
	}
	return false;
}

function bindingOf(call: ts.Node, name: string): "parameter" | "local" {
	let node: ts.Node | undefined = call.parent;
	while (node) {
		if (scopeDeclaresLocal(node, name)) return "local";
		if (declaresParameter(node, name)) return "parameter";
		node = node.parent;
	}
	// Bound nowhere on the way out: a module binding, an import, or a global. None of
	// them is the caller's decision either.
	return "local";
}

function triggerOf(call: ts.CallExpression): Trigger | string {
	// Arity before `at(-1)`. On a one-argument call the last argument is the DOCUMENT,
	// and if that document is an identifier naming an enclosing parameter the call
	// reads as `forwarded` instead of as the mistake it is. Both writers require the
	// options argument today, so this cannot bite — but "the compiler would have
	// caught it" is exactly the reasoning this file exists not to rely on.
	if (call.arguments.length < 2) return "no options argument";
	const opts = call.arguments.at(-1);
	if (!opts) return "no options argument";
	if (ts.isIdentifier(opts)) {
		// A wrapper only counts as forwarding if what it passes on came from OUTSIDE.
		// A local `const opts = { history: true }` is a hardcode wearing a disguise.
		return bindingOf(call, opts.text) === "parameter"
			? "forwarded"
			: `local variable \`${opts.text}\``;
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
		// The other two ways an entry can land on a stack. They exist because the
		// arrays are `readonly` now, which is what turned "somebody called `.push` on
		// an exported array" — invisible here, the callee name is `push` — into a
		// named call this scan can count.
		["pushPast", []],
		["pushFuture", []],
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
				const name = callee ? enclosingFunctionName(node) : "";
				if (callee) callsTo.get(callee)?.push({ file, fn: name });
				if (callee && WRITERS.has(callee)) {
					writes.push({
						file,
						fn: name,
						writer: callee as WritePath["writer"],
						trigger: triggerOf(node) as Trigger,
					});
				} else if (isProjectStoreSetState(node)) {
					// No options argument to read a trigger off — that is the whole reason this
					// shape needs a row rather than a compile error.
					writes.push({
						file,
						fn: enclosingFunctionName(node),
						writer: "useProjectStore.setState",
						trigger: "unrecorded",
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

	// The table stands in for the stack only while these two hold. `recordHistory` is
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

	it("grows the stacks only through `pushHistory` and undo/redo's own two pushes", () => {
		// `undo` and `redo` hand each other the document they are stepping over, which
		// is not a new edit and must not clear the other stack -- so they cannot go
		// through `pushHistory`. Those two calls are the whole remainder of the ones
		// written under their own name, and the rows below are what makes that a
		// checked statement rather than a claim.
		expect(scanned.callsTo.get("pushPast")).toEqual([
			{ file: "src/lib/ai-edition/store/undo.ts", fn: "redo" },
		]);
		expect(scanned.callsTo.get("pushFuture")).toEqual([
			{ file: "src/lib/ai-edition/store/undo.ts", fn: "undo" },
		]);
	});

	it("does not let an importer push to the stacks in passing", () => {
		// The hole this closes. `past` and `future` were exported as `Snapshot[]`, and
		// `const` binds the reference, not the contents -- so `past.push(...)` from any
		// importer recorded history, and the scan above could not see it: it keys on the
		// callee NAME, and the name there is `push`.
		//
		// The assertions are the `@ts-expect-error`s. Each one is an error itself the
		// moment the directive stops suppressing anything, so this test fails the
		// typecheck pass if the stacks ever go mutable again. "In passing" is the whole
		// claim: `readonly` is a compile-time thing, so somebody who WANTS to write to
		// these arrays still can, by casting the type back off -- and the scan will not
		// see that either.
		// @ts-expect-error `past` is `readonly Snapshot[]`; record through `pushHistory`.
		past.push({ projectId: "project_x", doc: {} });
		// @ts-expect-error `future` is `readonly Snapshot[]`; step forward through `pushFuture`.
		future.push({ projectId: "project_x", doc: {} });
		// @ts-expect-error `length` is read-only too; empty the stacks with `clearHistory`.
		past.length = 0;

		// The lines above still RUN -- `readonly` is erased, it is the same array -- so
		// leave the module the way this file found it.
		clearHistory();
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The audit's own rule, pinned. The table above is worth exactly as much as
// `triggerOf`, and a `forwarded` that an unrelated outer parameter name can spoof
// is the hole the audit exists to close.
// ---------------------------------------------------------------------------

/** Classify the first `saveDocument(...)` call in a snippet. Parsed, not
 *  type-checked, so the fixtures can leave their free variables undeclared. */
function classify(fixture: string): Trigger | string {
	const source = ts.createSourceFile(
		"fixture.ts",
		fixture,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && calleeName(node) === "saveDocument") calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(source);
	const [call] = calls;
	if (!call) throw new Error("fixture has no `saveDocument` call");
	return triggerOf(call);
}

describe("how a write's trigger is read off its call site", () => {
	it("does not call a local `opts` forwarded because an OUTER function has one", () => {
		// The shape that was live: `useSequentialTimelineOps` takes a parameter called
		// `options`, so anything written inside that hook as a local `options` would have
		// read as `forwarded` -- a hardcode wearing exactly the disguise the check is
		// supposed to strip off.
		expect(
			classify(`
				function useOps(opts) {
					return () => {
						const opts = { history: true };
						saveDocument(doc, opts);
					};
				}
			`),
		).toBe("local variable `opts`");
	});

	it("still forwards across an inner function that takes no parameters", () => {
		// `useSequentialTimelineOps.apply`, reduced: the call sits in a zero-parameter
		// `async () => {}` and `opts` is bound two scopes out. Stopping the walk at the
		// innermost function would break this row.
		expect(
			classify(`
				const apply = (op, opts) =>
					enqueue(async () => {
						const doc = current();
						return saveDocument(doc, opts);
					});
			`),
		).toBe("forwarded");
	});

	it("reads a destructured local as a local, not as a forward", () => {
		expect(
			classify(`
				function wrapper(opts) {
					const { opts } = defaults;
					saveDocument(doc, opts);
				}
			`),
		).toBe("local variable `opts`");
	});

	it("says so when there is no options argument at all", () => {
		// Without the arity check the last argument here is the DOCUMENT, and `doc` names
		// an enclosing parameter -- so the call reported itself as forwarding.
		expect(
			classify(`
				function wrapper(doc) {
					saveDocument(doc);
				}
			`),
		).toBe("no options argument");
	});

	it.each([
		["function", "function opts() {}"],
		["class", "class opts {}"],
	])("reads a local %s declaration as a local, not as a forward", (_kind, declaration) => {
		// The scope walk used to read variable statements and nothing else, so these two
		// bindings were invisible to it: it walked straight past them to the `opts`
		// parameter outside and called the call forwarded. Neither shape is a valid
		// options object, so this is not a hole anything could have fallen through -- it
		// is the walk answering "where was this name bound" correctly.
		expect(
			classify(`
				function wrapper(opts) {
					return () => {
						${declaration}
						saveDocument(doc, opts);
					};
				}
			`),
		).toBe("local variable \`opts\`");
	});
});

// ---------------------------------------------------------------------------
// And the rule's edge, pinned as it actually is. `forwarded` is a question about
// BINDINGS, not about values, and these two are where those answers part company.
// They are here so the header's "does not catch" is a measured statement rather
// than a remembered one, and so a future tightening has a fixture to flip rather
// than a paragraph to argue with.
// ---------------------------------------------------------------------------

describe("what reading the call site cannot tell you", () => {
	it("calls a callback parameter forwarded even when the caller is the local hardcode", () => {
		// `forEach` supplies `opts` from a literal three lines up. Nobody outside decided
		// anything, but the binding really is a parameter, and a binding is all the walk
		// looks at.
		expect(
			classify(`
				[{ history: true }].forEach((opts) => saveDocument(doc, opts));
			`),
		).toBe("forwarded");
	});

	it("calls a parameter forwarded after it has been reassigned to a hardcode", () => {
		// The value reaching the writer is the literal on the line above. Following that
		// is dataflow analysis, which this file does not do.
		expect(
			classify(`
				function wrapper(doc, opts) {
					opts = { history: true };
					saveDocument(doc, opts);
				}
			`),
		).toBe("forwarded");
	});
});

// ---------------------------------------------------------------------------
// The third writer's match. It is the one row-producing rule in this file that is
// NOT keyed on the callee name alone, and the reason is a name collision that is
// already in the tree.
// ---------------------------------------------------------------------------

describe("which `setState` the scan files as a document write", () => {
	/** Whether the first `setState(...)` in a snippet would produce a row. */
	function matches(fixture: string): boolean {
		const source = ts.createSourceFile(
			"fixture.ts",
			fixture,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		const calls: ts.CallExpression[] = [];
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node) && calleeName(node) === "setState") calls.push(node);
			ts.forEachChild(node, visit);
		};
		visit(source);
		const [call] = calls;
		if (!call) throw new Error("fixture has no `setState` call");
		return isProjectStoreSetState(call);
	}

	it("counts a write straight into the project store", () => {
		expect(matches("useProjectStore.setState({ document: next });")).toBe(true);
	});

	it("does not count another store of the same shape", () => {
		// `useTranscriptionStore.setState` is four calls in this same directory and writes
		// no document. Keyed on the method name alone, all four would have been rows —
		// and a table padded with writes it cannot judge is a table nobody reads.
		expect(matches("useTranscriptionStore.setState((state) => state);")).toBe(false);
	});

	it("does not count a bare `setState` that no receiver names", () => {
		// React's own, in a `.tsx` the walk covers.
		expect(matches("setState({ open: true });")).toBe(false);
	});

	it("does not count a write into the project store that carries no document", () => {
		// The receiver is right and the call is real, but nothing here reaches the
		// document — filing it would put a row in the table that no reader can judge.
		expect(matches("useProjectStore.setState({ dirty: true });")).toBe(false);
	});

	it("counts the updater form, which is how three of the four real ones are written", () => {
		expect(
			matches(
				"useProjectStore.setState((state) => ({ document: doc, revision: state.revision + 1 }));",
			),
		).toBe(true);
	});

	it("counts an updater that only writes the document on one branch", () => {
		// `commitZoomFocus` and `commitAnnotationChange` both return
		// `state.document === doc ? { document: rollback, ... } : {}`. The call CAN write a
		// document, which is what the row is about — an object-literal-only check drops both.
		expect(
			matches(
				"useProjectStore.setState((state) => (state.document === doc ? { document: rollback } : {}));",
			),
		).toBe(true);
	});

	it("counts an updater with a block body", () => {
		expect(matches("useProjectStore.setState((state) => { return { document: doc }; });")).toBe(
			true,
		);
	});
});

describe("which scopes bind a parameter", () => {
	it("reads a constructor parameter as forwarded, not as a local", () => {
		expect(
			classify(`
				class Writer {
					constructor(opts) {
						saveDocument(doc, opts);
					}
				}
			`),
		).toBe("forwarded");
	});

	it("reads a setter parameter as forwarded, not as a local", () => {
		expect(
			classify(`
				class Writer {
					set options(opts) {
						saveDocument(doc, opts);
					}
				}
			`),
		).toBe("forwarded");
	});
});
