// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The translator returns the key: an assertion reads better against a key than
// against a sentence that moves every time the copy is revised.
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

import type { AssetTranscriptionView } from "@/lib/ai-edition/transcription/status";
import { TranscriptionStatusDot, useTranscriptionLabel } from "./TranscriptionStatus";

/** Renders the shared label so the hook can be asserted as plain text. */
function Label({ view }: { view: AssetTranscriptionView }) {
	return <span data-testid="label">{useTranscriptionLabel()(view)}</span>;
}

function running(extra: Partial<AssetTranscriptionView> = {}): AssetTranscriptionView {
	return {
		assetId: "a",
		status: "running",
		progress: { completedSec: 45, totalSec: 100 },
		...extra,
	};
}

function labelOf(view: AssetTranscriptionView): string {
	return render(<Label view={view} />).getByTestId("label").textContent ?? "";
}

describe("useTranscriptionLabel telemetry suffix", () => {
	// The whole point of the change: a run on the slow path says so, in the one
	// string all three status surfaces render.
	it("names the CPU path and the speed while transcribing", () => {
		expect(labelOf(running({ backend: "whispercpp-cpu", rtf: 1.1 }))).toBe(
			"mediaStage.transcribing 45% · CPU · 0.9×",
		);
	});

	// A healthy GPU run gets the speed but no backend name — labelling every
	// successful run "Vulkan" would be noise, and only the CPU case is actionable.
	it("shows the speed but not the backend on a GPU run", () => {
		expect(labelOf(running({ backend: "whispercpp-vulkan", rtf: 0.5 }))).toBe(
			"mediaStage.transcribing 45% · 2.0×",
		);
	});

	// Regression guard for the helper binary that predates the `timing` field:
	// with nothing reported the label must be exactly what it always was, not
	// "0.0×" and not a stray separator.
	it("is unchanged when the engine reports no timing", () => {
		expect(labelOf(running())).toBe("mediaStage.transcribing 45%");
	});

	// Chunk progress can be absent while the run is still starting up.
	it("drops the percentage but keeps the telemetry without progress", () => {
		expect(labelOf(running({ progress: undefined, backend: "whispercpp-cpu" }))).toBe(
			"mediaStage.transcribing · CPU",
		);
	});

	// The model download has its own words and no device to report yet.
	it("leaves the model-download phase alone", () => {
		expect(labelOf(running({ phase: "loading-model", backend: "whispercpp-cpu", rtf: 1.1 }))).toBe(
			"mediaStage.downloadingModel",
		);
	});
});

describe("TranscriptionStatusDot", () => {
	// "CPU" in the label is terse by necessity; the tooltip is where the cost is
	// spelled out. It has to be a <title> CHILD because lucide renders an <svg>,
	// which has no tooltip-bearing `title` attribute.
	it("explains the CPU cost in the spinner's SVG title", () => {
		const { container } = render(
			<TranscriptionStatusDot view={running({ backend: "whispercpp-cpu", rtf: 1.1 })} />,
		);
		const title = container.querySelector("svg > title");
		expect(title?.textContent).toBe(
			"mediaStage.transcribing 45% · CPU · 0.9× — mediaStage.cpuBackendHint",
		);
	});

	it("uses the plain label as the title on a GPU run", () => {
		const { container } = render(
			<TranscriptionStatusDot view={running({ backend: "whispercpp-vulkan", rtf: 0.5 })} />,
		);
		expect(container.querySelector("svg > title")?.textContent).toBe(
			"mediaStage.transcribing 45% · 2.0×",
		);
	});

	// A settled asset renders the dot, not the spinner — the tooltip lives on the
	// `title` attribute there, and no backend is in play.
	it("falls back to the dot once the run is over", () => {
		const { container } = render(
			<TranscriptionStatusDot view={{ assetId: "a", status: "ready" }} />,
		);
		expect(container.querySelector("svg")).toBeNull();
		expect(container.querySelector("span")).toHaveAttribute("title", "mediaStage.transcriptReady");
	});
});
