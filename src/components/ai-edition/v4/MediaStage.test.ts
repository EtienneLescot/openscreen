import { describe, expect, it, vi } from "vitest";
import { addSelectedAssetToTimeline } from "./MediaStage";

describe("addSelectedAssetToTimeline", () => {
	it("reports success only once the selected asset has been added", async () => {
		// Deferred on purpose: with an immediately-resolved onAdd this test passes whether
		// onSuccess fires before or after the insertion, which is the one thing it is here
		// to pin — a success toast for a clip that is not on the timeline yet.
		let resolveAdd!: () => void;
		const onAdd = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveAdd = resolve;
				}),
		);
		const onSuccess = vi.fn();

		const pending = addSelectedAssetToTimeline(
			{ id: "asset-7", label: "", originalPath: "/recordings/demo.mp4" },
			onAdd,
			onSuccess,
		);

		expect(onAdd).toHaveBeenCalledWith("asset-7");
		expect(onSuccess).not.toHaveBeenCalled();

		resolveAdd();
		await pending;

		// Empty label falls back to the basename.
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
