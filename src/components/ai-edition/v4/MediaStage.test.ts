import { describe, expect, it, vi } from "vitest";
import { addSelectedAssetToTimeline } from "./MediaStage";

describe("addSelectedAssetToTimeline", () => {
	it("forwards the selected asset ID and displayed fallback name", () => {
		const onAdd = vi.fn();
		const onSuccess = vi.fn();

		addSelectedAssetToTimeline(
			{ id: "asset-7", label: "", originalPath: "/recordings/demo.mp4" },
			onAdd,
			onSuccess,
		);

		expect(onAdd).toHaveBeenCalledWith("asset-7");
		expect(onSuccess).toHaveBeenCalledWith("demo.mp4");
	});

	it("does nothing without a selected asset", () => {
		const onAdd = vi.fn();
		const onSuccess = vi.fn();

		addSelectedAssetToTimeline(null, onAdd, onSuccess);

		expect(onAdd).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});
});
