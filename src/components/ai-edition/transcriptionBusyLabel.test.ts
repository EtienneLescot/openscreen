import { describe, expect, it } from "vitest";
import type { AssetTranscriptionView } from "@/lib/ai-edition/transcription/status";
import { transcriptionBusyLabel } from "./transcriptionBusyLabel";

function view(extra: Partial<AssetTranscriptionView> = {}): AssetTranscriptionView {
	return { assetId: "a", status: "running", phase: "loading-model", ...extra };
}

describe("Captions/Transcript busy copy", () => {
	it("does not use captions.transcribing while pending on loading-model", () => {
		const label = transcriptionBusyLabel(view(), (v) =>
			v.phase === "loading-model" ? "mediaStage.initializingModel" : "captions.transcribing",
		);
		expect(label).toBe("mediaStage.initializingModel");
		expect(label).not.toContain("captions.transcribing");
	});

	it("returns null when idle so the pane can keep its transcribe verb", () => {
		expect(
			transcriptionBusyLabel(view({ status: "idle", phase: undefined }), () => "x"),
		).toBeNull();
	});
});
