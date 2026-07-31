// ponytail: prompts and tool-surface constants, kept apart from the scenarios
// so a wording change is one edit and so the wizard prompt stays byte-identical
// to production.

/**
 * VERBATIM copy of `AI_ENHANCE_PROMPT` from
 * `src/components/ai-edition/v4/V4Timeline.tsx:57-58` — the string the
 * Auto-enhance button sends through the prompt bus into the same `runChat`.
 * A workbench that paraphrases it measures a prompt the product never sends.
 */
export const AI_ENHANCE_PROMPT =
	"Automatically enhance this recording: (1) add smart zoom-ins on the moments where the cursor dwells or interacts with the UI, each focused on the cursor's location; and (2) cut the dead time — long pauses, silences, and idle stretches where nothing happens — to keep the pacing tight and natural. Apply the edits directly to the timeline.";

/** The 19 tools OpenScreen builds in `deep-agent/service.ts` (`buildTools`).
 * `moveClip` reordering a clip had NO tool while the system prompt promised one,
 * which is what pushed the model onto `replaceTimeline` (D-DESTRUCT).
 * `getCursorTrack` is the newest: the app records pointer telemetry and loads it
 * in the compositor, but NOTHING carried a single sample to the model, so asked
 * what cursor data the project held it had to answer from nothing (D-TELEM).
 *
 * ponytail: the name is `getCursorTrack`, not `getCursorTrack` — the tool
 * returns the TRACK (positions over time) and no longer the stillness detector's
 * digest, and this list said otherwise for a while. That is not a cosmetic
 * drift: a scenario check written as `calls("getCursorTrack").length > 0`
 * counts a call LangChain refused, so `cursor-question` and `cursor-blind` both
 * scored 1.0 on turns where nothing was ever read. Every name here is frozen
 * against the real surface by `l1/end-to-end.wb.ts`. */
export const OPENSCREEN_TOOLS = [
	"getCurrentDocument",
	"getTranscript",
	"getCursorTrack",
	"addTrim",
	"setTrim",
	"setClipRange",
	"moveClip",
	"replaceTimeline",
	"addZoom",
	"setZoom",
	"addSpeed",
	"setSpeed",
	"addAnnotation",
	"setAnnotation",
	"addCameraFullscreen",
	"setCameraFullscreen",
	"removeTrim",
	"removeModifier",
	"removeClip",
] as const;

/**
 * The 8 filesystem/todo/sub-agent tools the `deepagents` middlewares used to
 * inject on top of ours. They operated on an in-memory `StateBackend` that is
 * EMPTY, and the model was not told so — the mechanical cause of D1: asked
 * about cursor telemetry, the model ran `ls`/`glob` against that sandbox and
 * reported, in good faith, that the project contains no pointer-tracking data.
 *
 * The surface is gone (`deep-agent/service.ts` now calls LangChain's
 * `createAgent` with our own tools and our prompt alone), so this list changed
 * meaning rather than becoming dead: it is now the list of names that must
 * NEVER appear on the wire again. A call to one of them is no longer the model
 * using a tool it was handed — it is the model hallucinating a filesystem it
 * was never offered, which is a rarer but still exact D1 tell. `l1` freezes the
 * surface directly; the scenarios keep scoring the calls.
 */
export const PHANTOM_TOOLS = [
	"write_todos",
	"ls",
	"read_file",
	"write_file",
	"edit_file",
	"glob",
	"grep",
	"task",
] as const;

/** Exactly our 19, and nothing else. A change here means the agent's context
 * changed shape — which is the one thing a report cannot be compared across. */
export const EXPECTED_TOOL_COUNT = OPENSCREEN_TOOLS.length;

const PHANTOM_SET: ReadonlySet<string> = new Set<string>(PHANTOM_TOOLS);

export function isPhantomTool(name: string): boolean {
	return PHANTOM_SET.has(name);
}

/**
 * The exact substring LangChain raises when a model emits arguments the zod
 * schema rejects.
 *
 * It no longer kills the turn. Under `createDeepAgent` the throw escaped,
 * `deep-agent/service.ts` caught it, emptied the text, and `chat-service.ts`
 * re-labelled the turn "Empty response from model" — the same words a genuinely
 * mute provider gets. Under `createAgent` the ToolNode catches it and feeds it
 * back as the tool result ("… Please fix the error and try again"), so the model
 * sees its own mistake and gets another round. The substring is still the only
 * way to tell a bad emission from an infrastructure failure, and it is still not
 * ours, so the L0 lock stays: a LangChain rewording would silently reclassify
 * model errors — now on the wire rather than in `run.error`.
 */
export const LANGCHAIN_SCHEMA_ERROR = "did not match expected schema";

/** `chat-service.ts:362-372`. */
export const EMPTY_RESPONSE_ERROR = "Empty response from model";
