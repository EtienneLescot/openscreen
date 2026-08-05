// ponytail: the agent's SURFACE and the honesty of its event sink — the two
// things that were wrong in a way no unit test could see, because both were
// decided by a dependency rather than by this repo.
//
// D-FS: `createDeepAgent` stacked a filesystem middleware, a todo middleware
// and a sub-agent middleware unconditionally, so the model was handed 25 tools
// instead of our 17 and a system message of ~8 700 characters instead of ours,
// promising a filesystem backed by an EMPTY in-memory store. Asked what cursor
// data the project holds, it ran `ls {"path":"/"}`, found nothing, and said so
// about the project. Counting the tools here is the cheapest tripwire for any
// dependency that starts injecting again.
//
// D-HONEST: every write was announced twice — once by the tool body with the
// executor's real verdict, once by the stream loop with `ok` hard-coded true —
// and read tools were announced only by the lying emission.

import { ChatAnthropic } from "@langchain/anthropic";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../../src/lib/ai-edition/schema";
import {
	ZOOM_DEPTH_LEGEND,
	ZOOM_DEPTH_SCALES,
} from "../../../src/lib/ai-edition/timeline/zoom-scale";
import { executeAgentTool, isMutatingTool } from "../agent-tools";
import {
	anthropicCachingMiddleware,
	buildSystemPrompt,
	buildTools,
	type OpenScreenAgentSink,
	SYSTEM_PROMPT,
	TOOL_DESCRIPTIONS,
} from "./service";

const OPENSCREEN_TOOLS = [
	"getCurrentDocument",
	"getTranscript",
	"getCursorTrack",
	"addTrim",
	"addTrims",
	"setTrim",
	"setClipRange",
	"moveClip",
	"replaceTimeline",
	"addZoom",
	"addZooms",
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
];

/** The tools `createDeepAgent` used to add. None of them may ever be built here
 * again: `execute` is in the middleware's list too and only disappeared at
 * runtime because the default backend is not a sandbox, so it is listed as
 * well — a sandbox backend would have made it a 26th tool. */
const PHANTOM_TOOLS = [
	"ls",
	"read_file",
	"write_file",
	"edit_file",
	"glob",
	"grep",
	"execute",
	"write_todos",
	"task",
];

/** Valid arguments for every tool, chosen so the executor's verdict is split
 * across the table: some succeed, some are refused for an unknown id, and
 * `replaceTimeline` is refused for the user-placed clips. A table where every
 * call succeeds would not notice a sink that reports `ok: true` always. */
const ARGS: Record<string, unknown> = {
	getCurrentDocument: {},
	getTranscript: {},
	getCursorTrack: {},
	addTrim: { startSec: 1, endSec: 2 },
	addTrims: { ranges: [{ startSec: 1, endSec: 2 }] },
	setTrim: { trimRangeId: "trim_1", startSec: 1, endSec: 2 },
	setClipRange: { clipId: "clip_1", sourceStartSec: 0, sourceEndSec: 10 },
	moveClip: { clipId: "clip_1", beforeClipId: null },
	replaceTimeline: { intervals: [{ startSec: 0, endSec: 10 }] },
	addZoom: { startSec: 1, endSec: 2 },
	addZooms: { regions: [{ startSec: 1, endSec: 2 }] },
	setZoom: { zoomId: "zoom_nope" },
	addSpeed: { startSec: 1, endSec: 2 },
	setSpeed: { speedId: "speed_nope" },
	addAnnotation: { startSec: 1, endSec: 2, text: "hi" },
	setAnnotation: { annotationId: "ann_nope" },
	addCameraFullscreen: { startSec: 1, endSec: 2 },
	setCameraFullscreen: { cameraFullscreenId: "cam_nope" },
	removeTrim: { trimRangeId: "trim_1" },
	removeModifier: { id: "nope" },
	removeClip: { clipId: "clip_1" },
};

function fixtureDocument(): AxcutDocument {
	const base = createEmptyDocument({ title: "Test", projectId: "proj_1" });
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Recording",
				originalPath: "/tmp/rec.mp4",
				durationSec: 30,
			},
		],
		transcripts: [
			{
				assetId: "asset_1",
				language: "en",
				segments: [
					{ id: "seg_1", kind: "speech", startSec: 0, endSec: 5, text: "Hello", wordIds: [] },
				],
				words: [],
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			trimRanges: [
				{ id: "trim_1", assetId: "asset_1", startSec: 10, endSec: 12, reason: "", origin: "user" },
			],
		},
	});
}

interface SinkEvent {
	kind: "toolStart" | "toolEnd";
	name: string;
	ok?: boolean;
	summary?: string;
}

function recordingSink(): { sink: OpenScreenAgentSink; events: SinkEvent[] } {
	const events: SinkEvent[] = [];
	return {
		events,
		sink: {
			// Only the tool channel is under test here; the text/thinking/error
			// channels are recorded by the L1 harness instead.
			text: () => undefined,
			thinking: () => undefined,
			toolStart: (name) => events.push({ kind: "toolStart", name }),
			toolEnd: (name, ok, summary) => events.push({ kind: "toolEnd", name, ok, summary }),
			error: () => undefined,
		},
	};
}

/** `buildTools` returns a tuple with a DISTINCT type per tool, one per zod
 * schema, so `tools.find(...)` is a 21-way union — and `.invoke` is generic, a
 * shape TypeScript will not call through a union (TS2349). Widening to the
 * interface every one of them implements is what the model is handed anyway:
 * `createAgent` takes them as `ClientTool`, i.e. exactly this. Nothing the
 * tests read is lost — `name`, `description`, `schema` and `invoke` all live on
 * the interface. */
type BuiltTool = StructuredToolInterface;

function toolsFor(document: AxcutDocument) {
	const { sink, events } = recordingSink();
	const holder = { current: document };
	const tools: BuiltTool[] = buildTools(holder, sink);
	return { tools, events, holder };
}

describe("the tool surface handed to the model", () => {
	it("is exactly OpenScreen's 21 tools", () => {
		const { tools } = toolsFor(fixtureDocument());
		expect(tools.map((t) => t.name)).toEqual(OPENSCREEN_TOOLS);
	});

	it("carries none of the tools deepagents used to inject", () => {
		const names = new Set(toolsFor(fixtureDocument()).tools.map((t) => t.name));
		for (const phantom of PHANTOM_TOOLS) expect(names.has(phantom)).toBe(false);
	});

	it("describes every tool it builds, and builds every tool it describes", () => {
		// Two surfaces that must not drift: a tool with no description reaches the
		// model as a bare name, and a description with no tool is dead prose.
		const names = toolsFor(fixtureDocument()).tools.map((t) => t.name);
		expect(Object.keys(TOOL_DESCRIPTIONS).sort()).toEqual([...names].sort());
		for (const tool of toolsFor(fixtureDocument()).tools) {
			expect(tool.description, `${tool.name} has no description`).toBeTruthy();
		}
	});

	it("promises no filesystem in the system prompt", () => {
		// The middleware prompt that came with the phantom tools said "You have
		// access to a filesystem which you can interact with using these tools.
		// All file paths must start with a /". Ours must never say anything of
		// the sort — a prompt promising tools that are gone is worse than the
		// tools were.
		expect(SYSTEM_PROMPT).not.toMatch(/file ?system|file path|write_todos|sub-?agent/i);
	});
});

describe("prompt caching on the Anthropic-wire providers", () => {
	// `createDeepAgent` added this middleware for us. Dropping it with the rest
	// of deepagents would have made every Anthropic and MiniMax turn re-pay for
	// the whole prompt — a cost and latency regression invisible to every
	// offline test, which all run on the OpenAI-compatible path.
	it("is attached for ChatAnthropic", () => {
		const model = new ChatAnthropic({ apiKey: "test-not-a-real-key", model: "claude-sonnet-4-6" });
		expect(anthropicCachingMiddleware(model)).toHaveLength(1);
	});

	it("covers MiniMax, which rides ChatAnthropic because its wire format is Anthropic's", () => {
		const model = new ChatAnthropic({
			apiKey: "test-not-a-real-key",
			model: "MiniMax-M2",
			anthropicApiUrl: "https://api.minimax.io/anthropic",
		});
		expect(anthropicCachingMiddleware(model)).toHaveLength(1);
	});

	it("is absent everywhere else", () => {
		const model = new ChatOpenAI({ apiKey: "test-not-a-real-key", model: "gpt-4o" });
		expect(anthropicCachingMiddleware(model)).toEqual([]);
	});
});

describe("the sink announces each call exactly once, with the real verdict", () => {
	for (const name of OPENSCREEN_TOOLS) {
		it(`${name}: one start, one end, ok from the executor`, async () => {
			const document = fixtureDocument();
			const args = ARGS[name];
			// The reference verdict, computed by the executor the tool wraps.
			const expected = executeAgentTool(document, name, JSON.stringify(args));

			const { tools, events } = toolsFor(document);
			const tool = tools.find((t) => t.name === name);
			if (!tool) throw new Error(`${name} is not built`);
			await tool.invoke(args);

			expect(events.map((e) => e.kind)).toEqual(["toolStart", "toolEnd"]);
			expect(events[0].name).toBe(name);
			expect(events[1].name).toBe(name);
			expect(events[1].ok).toBe(expected.ok);
			expect(events[1].summary).toBe(expected.summary);
		});
	}

	it("covers both verdicts, so a sink hard-coding ok:true could not pass", () => {
		const document = fixtureDocument();
		const verdicts = OPENSCREEN_TOOLS.map(
			(name) => executeAgentTool(document, name, JSON.stringify(ARGS[name])).ok,
		);
		expect(verdicts).toContain(true);
		expect(verdicts).toContain(false);
	});

	it("a read tool that fails is reported as a failure", async () => {
		// `getTranscript` on a project with no transcript returns
		// `{"error":"No transcript for asset …"}`. It used to reach the sink as
		// ok:true — read tools had no emission of their own, and the stream loop
		// hard-coded the verdict.
		const document = { ...fixtureDocument(), transcripts: [], transcript: null };
		const { tools, events } = toolsFor(document);
		const tool = tools.find((t) => t.name === "getTranscript");
		if (!tool) throw new Error("getTranscript is not built");
		const result = await tool.invoke({});

		expect(String(result)).toContain("No transcript");
		expect(events).toHaveLength(2);
		expect(events[1]).toMatchObject({ kind: "toolEnd", name: "getTranscript", ok: false });
	});

	it("lets a malformed batch entry reach the executor instead of throwing at the schema", async () => {
		// LangChain parses the tool's schema BEFORE calling us, so a batch schema
		// that enforced its element shape would reject the whole call here — the
		// per-item `refused[index]` that `addTrims` promises the model could never
		// happen on the product path, only in a direct-executor test.
		const { tools, holder } = toolsFor(fixtureDocument());
		const tool = tools.find((t) => t.name === "addTrims");
		if (!tool) throw new Error("addTrims is not built");

		const result = JSON.parse(
			String(await tool.invoke({ ranges: [{ startSec: 1, endSec: 2 }, { startSec: "oops" }] })),
		);
		expect(result.appliedCount).toBe(1);
		expect(result.refused[0].index).toBe(1);
		expect(holder.current.timeline.trimRanges).toHaveLength(2);
	});

	it("advances the holder on a write, and leaves it alone on a refusal", async () => {
		const { tools, holder } = toolsFor(fixtureDocument());
		const before = holder.current;

		const refused = tools.find((t) => t.name === "setZoom");
		if (!refused) throw new Error("setZoom is not built");
		await refused.invoke({ zoomId: "zoom_nope" });
		expect(holder.current).toBe(before);

		const write = tools.find((t) => t.name === "addTrim");
		if (!write) throw new Error("addTrim is not built");
		await write.invoke({ startSec: 1, endSec: 2 });
		expect(holder.current).not.toBe(before);
		expect(holder.current.timeline.trimRanges).toHaveLength(2);
	});
});

// ─── The surfaces that describe the tools ──────────────────────────────────
//
// `agent-tools.ts` used to carry AGENT_TOOL_SPECS — a full JSON-schema
// description of all 17 tools, with a comment saying it was "sent verbatim to
// the provider". It was not, and had not been since the deep-agent landed: the
// model gets the zod schemas built here plus TOOL_DESCRIPTIONS. So the surface
// humans read and the surface the model read were two different documents, and
// only one of them had a reader who would notice it drifting. The specs are
// gone; these tests are what keeps the remaining three in step.
describe("one description of the tools, not two", () => {
	it("every described tool is built, and every built tool is executable", () => {
		// The third surface is the executor's own switch, which answers
		// "Unknown tool: …" for a name it does not handle. A tool that is described
		// and built but not executed would reach the model as a promise and come
		// back as an error — exactly the shape of drift the specs were supposed to
		// prevent and could not, being read by nobody.
		const document = fixtureDocument();
		for (const name of Object.keys(TOOL_DESCRIPTIONS)) {
			const result = executeAgentTool(document, name, JSON.stringify(ARGS[name] ?? {}));
			const error = JSON.parse(result.resultJson).error;
			expect(
				typeof error === "string" && error.startsWith("Unknown tool"),
				`${name}: ${error}`,
			).toBe(false);
		}
	});

	it("the mutating flag production reads matches the tools that return a document", () => {
		const document = fixtureDocument();
		for (const name of OPENSCREEN_TOOLS) {
			const result = executeAgentTool(document, name, JSON.stringify(ARGS[name]));
			// A read must never produce a document; a write that succeeded must.
			if (!isMutatingTool(name)) expect(result.document, `${name} wrote`).toBeUndefined();
			else if (result.ok) expect(result.document, `${name} returned nothing`).toBeDefined();
		}
		expect(OPENSCREEN_TOOLS.filter((n) => !isMutatingTool(n))).toEqual([
			"getCurrentDocument",
			"getTranscript",
			"getCursorTrack",
		]);
	});
});

describe("what the descriptions say about zoom strength", () => {
	it("carries the real depth table and not the formula that never matched it", () => {
		// "depth 1–6 maps to 1.0×–3.5×" was `depth/2 + 0.5`, wrong at both ends of a
		// table running 1.25×–5.0×, and it told the model depth 3 was ~2.0× while
		// the pill on screen read 1.80×.
		for (const text of [TOOL_DESCRIPTIONS.addZoom, TOOL_DESCRIPTIONS.setZoom, SYSTEM_PROMPT]) {
			expect(text).not.toMatch(/1\.0×–3\.5×|1\.0x-3\.5x/);
		}
		expect(TOOL_DESCRIPTIONS.addZoom).toContain(ZOOM_DEPTH_LEGEND);
		expect(SYSTEM_PROMPT).toContain(ZOOM_DEPTH_LEGEND);
		// Derived, not retyped: editing the table must move the prompt with it.
		expect(ZOOM_DEPTH_LEGEND).toContain(`3=${ZOOM_DEPTH_SCALES[3].toFixed(2)}×`);
	});

	it("tells the model a full-camera region needs a linked webcam", () => {
		expect(TOOL_DESCRIPTIONS.addCameraFullscreen).toMatch(/hasCameraTrack/);
		expect(SYSTEM_PROMPT).toMatch(/hasCameraTrack/);
	});
});

// ── D-CONSENT ───────────────────────────────────────────────────────────────
//
// The executor's guard is the wall; this is the other half. The workbench
// scores `dsl.consent.no-silent-edit` on the tool_calls the model EMITS, not on
// what the executor did with them — a turn that fires three writes and has all
// three refused is still a turn that tried. Only the prompt stops the emission,
// and only the guard makes the promise real. Neither is sufficient alone, so
// both are tested.
describe("the prompt when the user has turned project edits off", () => {
	it("tells the model to ask, and not to pretend", () => {
		const prompt = buildSystemPrompt({ editsAllowed: false });
		expect(prompt).toMatch(/PROJECT EDITS ARE CURRENTLY DISABLED/);
		expect(prompt).toMatch(/ask the user to confirm/i);
		expect(prompt).toMatch(/getCurrentDocument and getTranscript work as usual/);
		expect(prompt).toMatch(/Never state or imply that an edit was applied/i);
	});

	it("says nothing of the sort on a normal turn", () => {
		expect(buildSystemPrompt({ editsAllowed: true })).toBe(SYSTEM_PROMPT);
		expect(SYSTEM_PROMPT).not.toMatch(/PROJECT EDITS ARE CURRENTLY DISABLED/);
	});

	it("keeps the normal prompt as a prefix, so the editing rules still apply", () => {
		// The consent block CONSTRAINS the turn; it does not replace the tool
		// selection rules the model needs to describe the edit it is proposing.
		expect(buildSystemPrompt({ editsAllowed: false }).startsWith(SYSTEM_PROMPT)).toBe(true);
	});
});

describe("the tools when the user has turned project edits off", () => {
	it("still builds all 21 — the model has to be able to NAME the edit", () => {
		const { sink } = recordingSink();
		const tools: BuiltTool[] = buildTools({ current: fixtureDocument() }, sink, false);
		expect(tools.map((t) => t.name)).toEqual(OPENSCREEN_TOOLS);
	});

	it("refuses every write through the tool, and the sink says so", async () => {
		const holder = { current: fixtureDocument() };
		const { sink, events } = recordingSink();
		const tools: BuiltTool[] = buildTools(holder, sink, false);
		const before = holder.current;

		for (const name of OPENSCREEN_TOOLS.filter((n) => isMutatingTool(n))) {
			const tool = tools.find((t) => t.name === name);
			if (!tool) throw new Error(`${name} is not built`);
			const result = await tool.invoke(ARGS[name] ?? {});
			expect(JSON.parse(String(result)).code, name).toBe("consent_required");
		}
		// Not one of them advanced the document.
		expect(holder.current).toBe(before);
		// And every one was announced as a failure — a hard-coded ok:true here
		// would have shown the user a green chip for an edit that never happened.
		expect(events.filter((e) => e.kind === "toolEnd").every((e) => e.ok === false)).toBe(true);
	});

	it("leaves the reads working", async () => {
		const tools: BuiltTool[] = buildTools(
			{ current: fixtureDocument() },
			recordingSink().sink,
			false,
		);
		const read = tools.find((t) => t.name === "getCurrentDocument");
		if (!read) throw new Error("getCurrentDocument is not built");
		expect(JSON.parse(String(await read.invoke({}))).primaryAssetId).toBe("asset_1");
	});
});

// ─── D-TELEM: the reader is injected, and its absence is reported as ours ────
//
// `readCursorTelemetryFile` and friends existed and worked; they were wired
// only to the renderer, so the agent had no door and answered the question from
// nothing. The tool is the door. What these tests pin is the thing that would
// quietly recreate the defect: an agent whose reader is missing, or throws, must
// say "I could not look" — never "there is none".

const SAMPLES = (() => {
	const out: Array<{ timeMs: number; cx: number; cy: number; interactionType: "move" | "click" }> =
		[];
	let drift = 0;
	let clicked = false;
	for (let timeMs = 0; timeMs <= 12_000; timeMs += 33) {
		const parked = timeMs >= 4000 && timeMs <= 5600;
		if (parked) {
			// The click lands on the FIRST parked sample, so it is inside the dwell
			// window the detector reports rather than a step before it.
			const isClick = !clicked;
			clicked = true;
			out.push({ timeMs, cx: 0.8, cy: 0.25, interactionType: isClick ? "click" : "move" });
		} else {
			drift = (drift + 0.05) % 1;
			out.push({ timeMs, cx: drift, cy: drift, interactionType: "move" });
		}
	}
	return out;
})();

async function invokeCursorTool(runtime: Parameters<typeof buildTools>[3]) {
	const { sink, events } = recordingSink();
	const tools: BuiltTool[] = buildTools({ current: fixtureDocument() }, sink, true, runtime);
	const tool = tools.find((t) => t.name === "getCursorTrack");
	if (!tool) throw new Error("getCursorTrack is not built");
	const result = await tool.invoke({});
	return { payload: JSON.parse(String(result)), events };
}

describe("cursor telemetry reaches the model", () => {
	it("passes through what the injected reader returns", async () => {
		const { payload, events } = await invokeCursorTool({
			cursor: {
				read: async ({ assetId }) => ({ status: "ok", assetId, samples: SAMPLES }),
			},
		});

		expect(payload.available).toBe(true);
		expect(payload.sampleCount).toBe(SAMPLES.length);
		expect(payload.points.length).toBeGreaterThan(0);
		// The positions reaching the model are the recorded ones, not a centroid of
		// them: the click sample survives at its own coordinates.
		const click = payload.points.find((p: { kind?: string }) => p.kind === "click");
		expect(click).toBeTruthy();
		expect(click.cx).toBeCloseTo(0.8, 2);
		expect(click.cy).toBeCloseTo(0.25, 2);
		// A read, announced honestly, exactly once.
		expect(events.map((e) => e.kind)).toEqual(["toolStart", "toolEnd"]);
		expect(events[1].ok).toBe(true);
	});

	it("says 'unavailable' when no reader is injected", async () => {
		const { payload } = await invokeCursorTool({});
		expect(payload.available).toBe(false);
		expect(payload.reason).toBe("unavailable");
	});

	it("says 'unavailable', not 'no-sidecar', when the reader throws", async () => {
		// The failure mode that would put the defect back with green tests: a
		// broken reader turning into an absence of data.
		const { payload } = await invokeCursorTool({
			cursor: {
				read: async () => {
					throw new Error("EACCES: permission denied");
				},
			},
		});
		expect(payload.reason).toBe("unavailable");
		expect(payload.note).toContain("EACCES");
	});

	it("passes 'no-sidecar' through as the asset's own fact", async () => {
		const { payload } = await invokeCursorTool({
			cursor: { read: async ({ assetId }) => ({ status: "no-sidecar", assetId }) },
		});
		expect(payload.reason).toBe("no-sidecar");
	});

	it("asks the reader for the asset the call names, resolving the default itself", async () => {
		const asked: string[] = [];
		const runtime = {
			cursor: {
				read: async ({ assetId }: { assetId: string }) => {
					asked.push(assetId);
					return { status: "no-sidecar" as const, assetId };
				},
			},
		};
		const { sink } = recordingSink();
		const tools: BuiltTool[] = buildTools({ current: fixtureDocument() }, sink, true, runtime);
		const tool = tools.find((t) => t.name === "getCursorTrack");
		if (!tool) throw new Error("getCursorTrack is not built");

		await tool.invoke({});
		await tool.invoke({ assetId: "asset_1" });

		// Both resolve to the primary asset — the wrapper and the executor must
		// agree on which asset is being reported, or the answer describes one and
		// the payload names the other.
		expect(asked).toEqual(["asset_1", "asset_1"]);
	});

	it("never hands the reader a path the model chose", async () => {
		// The tool takes an assetId; the path comes from the document. A tool that
		// accepted a path would be an arbitrary JSON reader on the user's disk.
		const seen: Array<{ originalPath: string | null }> = [];
		const runtime = {
			cursor: {
				read: async (input: { assetId: string; originalPath: string | null }) => {
					seen.push({ originalPath: input.originalPath });
					return { status: "no-sidecar" as const, assetId: input.assetId };
				},
			},
		};
		const { sink } = recordingSink();
		const tools: BuiltTool[] = buildTools({ current: fixtureDocument() }, sink, true, runtime);
		const tool = tools.find((t) => t.name === "getCursorTrack");
		if (!tool) throw new Error("getCursorTrack is not built");

		// The extra `path` is the point of the test: the model is allowed to ask
		// for anything, and the tool must ignore what it did not declare.
		await tool.invoke({ assetId: "asset_1", path: "/etc/passwd" });

		expect(seen).toEqual([{ originalPath: fixtureDocument().assets[0].originalPath }]);
	});

	it("tells the model that blindness is not evidence", () => {
		// The executor's refusal is the mechanism; this sentence is what stops the
		// model converting it into a claim about the project, which is the half of
		// the defect no guard can reach.
		expect(SYSTEM_PROMPT).toMatch(/Blindness is not evidence/);
		expect(SYSTEM_PROMPT).toMatch(/hasCursorTelemetry/);
		expect(TOOL_DESCRIPTIONS.getCursorTrack).toMatch(/no-sidecar/);
		expect(TOOL_DESCRIPTIONS.getCursorTrack).toMatch(/unavailable/);
	});
});
