// The one place that answers "how much bigger will the picture actually be?".
//
// ponytail: this table used to live in `src/components/video-editor/types.ts`,
// which reaches its own imports through the `@/` alias. That alias is declared
// on the ROOT vite config (`vite.config.ts:45`), not on the main-process build
// (`main.vite.build` is `{}`), and nothing under `electron/` uses it — so the
// agent layer physically could not import the renderer's scale table without
// risking a main-process bundle that typechecks and then fails to resolve. The
// table now lives here, on the relative-import side of that fence, and
// `types.ts` re-exports it so every existing renderer importer is unaffected.
//
// Why it matters that there is exactly ONE table: `depth` is an ORDINAL, and
// three separate places had each invented their own factor for it. The agent's
// tool descriptions claimed "depth 1–6 maps to 1.0×–3.5×" (the formula
// `depth/2 + 0.5`), the compositor's scene description carried that same
// formula until it was corrected, and the pill on screen has always read the
// table below. Wrong at both ends: the range is 1.25×–5.0×, it is not linear,
// and the default depth 3 renders at 1.80× — not the "2.0×" the agent was told
// to report, and certainly not the "3×" a model reads off a bare ordinal.

export type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;

export const ZOOM_DEPTH_SCALES: Record<ZoomDepth, number> = {
	1: 1.25,
	2: 1.5,
	3: 1.8,
	4: 2.2,
	5: 3.5,
	6: 5.0,
};

export const MIN_ZOOM_SCALE = 1.0;
export const MAX_ZOOM_SCALE = 5.0;

export const DEFAULT_ZOOM_DEPTH: ZoomDepth = 3;

/** Everything `effectiveZoomScale` reads. Deliberately structural, so a stored
 * zoom region, a UI region and a hand-written `{ depth }` all satisfy it. */
export interface ZoomScaleInput {
	depth: ZoomDepth;
	/** Custom scale overriding the preset depth. When set, `depth` is inert. */
	customScale?: number;
}

/**
 * The scale the viewer will actually see: `customScale` when present (clamped
 * to the renderer's range), otherwise the preset for `depth`.
 *
 * The clamp is part of the answer, not decoration: `zoomRegionSchema` only
 * requires `customScale` to be positive, so a document can legally carry
 * `customScale: 12`. Anything that reads the raw field instead of calling this
 * renders a different picture from the preview.
 */
export function effectiveZoomScale(region: ZoomScaleInput): number {
	if (region.customScale != null) {
		const clamped = Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, region.customScale));
		if (Number.isFinite(clamped)) return clamped;
	}
	return ZOOM_DEPTH_SCALES[region.depth];
}

/**
 * The depth→scale table as one line of prose, for the tool descriptions handed
 * to the model.
 *
 * ponytail: DERIVED, never retyped. The previous copy was a hand-written
 * "1.0×–3.5×" that outlived the mapping it described by an unknown number of
 * releases, and the model dutifully repeated it to users. Anyone changing the
 * table above now changes the prompt in the same edit.
 */
export const ZOOM_DEPTH_LEGEND = (Object.keys(ZOOM_DEPTH_SCALES) as unknown as ZoomDepth[])
	.map((key) => Number(key) as ZoomDepth)
	.sort((a, b) => a - b)
	.map((depth) => `${depth}=${ZOOM_DEPTH_SCALES[depth].toFixed(2)}×`)
	.join(", ");
