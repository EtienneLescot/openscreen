// ponytail: gates the native GIF export path added in slice 1 of the
// D3D ↔ Pixi cleanup roadmap. Stays `false` for this PR — the renderer
// still routes GIF through `gif.js` via `src/lib/exporter/gifExporter.ts`.
// The native path is wired end-to-end (Rust → napi addon →
// `compositorViewService.exportGif` → TS contract) but flipping this on
// is a follow-up: the bench in `crates/poc-d3d/src/bench.rs` is the
// honest signal that decides whether the readback is fast enough to be
// a win (or whether a 5× regression makes it not worth the swap — see
// the `Native GIF export — initial bench` section of
// `technical-documentation/engineering/rendering-performance.md`).
export const NATIVE_GIF_EXPORT_ENABLED = false;
