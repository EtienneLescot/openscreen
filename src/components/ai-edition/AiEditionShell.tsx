import { NewEditorShell } from "./NewEditorShell";

// ponytail: the new editor is the default for all users (merge plan §0 — the
// new editing model is NOT opt-in). AI_FEATURES_ENABLED gates only the
// LLM/agent UI (chat panel, provider settings) which mounts inside
// NewEditorShell when the flag is true. The legacy VideoEditor is deprecated.

export function AiEditionOrLegacy() {
	return <NewEditorShell />;
}

export default AiEditionOrLegacy;
