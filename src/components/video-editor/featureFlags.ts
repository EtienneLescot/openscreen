export const BLUR_REGIONS_ENABLED = false;

// ponytail: gates ONLY the LLM/agent surface — provider settings dialog, chat
// panel, suggestions list, "Restore checkpoint" actions. Does NOT gate the
// new editing model, project panel, timeline, transcript editor, or exporter.
// Local Whisper is privacy-safe and also not gated. The new editor ships as
// the default from Phase 1 PR 1.3 onward; this flag is just the AI-features
// opt-in. Renamed from AI_EDITION_ENABLED on 2026-06-26 — see
// docs/architecture/ai-edition-merge-plan.md §0 / §5.9.
export const AI_FEATURES_ENABLED = true;
