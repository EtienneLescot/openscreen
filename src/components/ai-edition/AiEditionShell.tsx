import { NewEditorShell } from "./NewEditorShell";

// ponytail: the new editor is the default for all users (merge plan §0 — the
// new editing model is NOT opt-in). The LLM/agent UI (chat panel, provider
// settings) always mounts inside NewEditorShell. The legacy VideoEditor is
// deprecated.

export function AiEditionOrLegacy() {
	return <NewEditorShell />;
}

export default AiEditionOrLegacy;
