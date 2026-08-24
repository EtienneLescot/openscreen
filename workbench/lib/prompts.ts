// ponytail: prompts and tool-surface constants, kept apart from the scenarios
// so a wording change is one edit and so the wizard prompt is stated once, with
// its provenance, rather than paraphrased per scenario.

import { OPENSCREEN_TOOL_NAMES, PHANTOM_TOOL_NAMES } from "../../electron/ai-edition/agent-tools";

/**
 * The Auto-enhance prompt the wizard scenarios send. It is NOT the string the
 * button sends any more: `src/components/ai-edition/v4/V4Timeline.tsx:77`
 * narrowed to cuts only in `7e6439ad`, because the model places zooms from what
 * the transcript SAYS rather than from where the pointer WAS — on a real 66s
 * screencast, 7 of its 9 focus points missed the cursor in their own window.
 *
 * This copy stays WIDE on purpose. That same commit names `real-wizard-enhance`
 * as the scenario that would show the model can read the track and justify
 * re-widening the product, and no scenario can measure zoom placement under a
 * prompt that never asks for a zoom: `dsl.zoom.placement` (weight 3) opens with
 * `fail("aucun zoom émis")`. The `wizard-enhance` pair scores the D1 fabricated
 * focus and D2 multiplier tells the same way — under the narrow prompt those
 * checks go green without anything having been fixed.
 *
 * So the divergence is deliberate, but it IS a divergence: re-narrowing this
 * string means reworking the zoom checks in all three scenarios and re-recording
 * their baselines, which is why it is not a one-line edit.
 *
 * ponytail: this said "VERBATIM copy … the string the Auto-enhance button sends"
 * from `7e6439ad` until now, pointing at `V4Timeline.tsx:57-58` where the
 * constant no longer lives. Nothing said so — `npm run wb` is not part of CI.
 */
export const AI_ENHANCE_PROMPT =
	"Automatically enhance this recording: (1) add smart zoom-ins on the moments where the cursor dwells or interacts with the UI, each focused on the cursor's location; and (2) cut the dead time — long pauses, silences, and idle stretches where nothing happens — to keep the pacing tight and natural. Apply the edits directly to the timeline.";

/**
 * The tools OpenScreen builds in `deep-agent/service.ts` (`buildTools`), and the
 * filesystem/todo/sub-agent tools that must never appear beside them again.
 *
 * Both are RE-EXPORTS, not copies. The bench used to keep its own hand-written
 * pair, and both went stale without anything noticing: the tool roster sat at 19
 * from the day it was written while the agent grew to 21 (`addTrims`/`addZooms`),
 * and the phantom list was missing `execute`, so `isPhantomTool` could not flag
 * the one middleware tool a sandbox backend would have re-introduced. Nothing
 * caught either, because `npm run wb` is not part of CI — the bench was checking
 * the product against a surface the product had outgrown.
 *
 * `agent-tools.ts` is the right home for them: it already owns
 * `MUTATING_TOOL_NAMES` and runs on zod plus pure document helpers, so importing
 * it costs L0 nothing (four L0 files already pull `executeAgentTool` from it).
 * Importing `deep-agent/service.ts` instead would drag LangChain down here.
 *
 * What keeps the roster honest is `deep-agent/service.test.ts`, which asserts it
 * equals `buildTools(...).map(t => t.name)` — and that suite runs in CI. A tool
 * added without updating the roster now fails the build rather than a bench
 * nobody runs.
 */
export const OPENSCREEN_TOOLS = OPENSCREEN_TOOL_NAMES;
export const PHANTOM_TOOLS = PHANTOM_TOOL_NAMES;

/** Our whole surface, and nothing else. A change here means the agent's context
 * changed shape — which is the one thing a report cannot be compared across, so
 * `fingerprintOf` records the wire's own `toolNames`/`toolsSha256` in every
 * report rather than trusting this to have been noticed. */
export const EXPECTED_TOOL_COUNT = OPENSCREEN_TOOL_NAMES.length;

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
