import { describe, expect, it, vi } from "vitest";
import { addSelectedAssetToTimeline } from "./MediaStage";

describe("addSelectedAssetToTimeline", () => {
	it("reports success after the selected asset is added", async () => {
		const onAdd = vi.fn(async () => undefined);
		const onSuccess = vi.fn();

		await addSelectedAssetToTimeline(
			{ id: "asset-7", label: "", originalPath: "/recordings/demo.mp4" },
			onAdd,
			onSuccess,
		);

		expect(onAdd).toHaveBeenCalledWith("asset-7");
		expect(onSuccess).toHaveBeenCalledWith("demo.mp4");
	});

	it("does not report success when adding the asset fails", async () => {
		const error = new Error("insert failed");
		const onAdd = vi.fn(async () => {
			throw error;
		});
		const onSuccess = vi.fn();

		await expect(
			addSelectedAssetToTimeline(
				{ id: "asset-7", label: "Demo", originalPath: "/recordings/demo.mp4" },
				onAdd,
				onSuccess,
			),
		).rejects.toBe(error);

		expect(onSuccess).not.toHaveBeenCalled();
	});

	it("does nothing without a selected asset", async () => {
		const onAdd = vi.fn(async () => undefined);
		const onSuccess = vi.fn();

		await addSelectedAssetToTimeline(null, onAdd, onSuccess);

		expect(onAdd).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});
});
