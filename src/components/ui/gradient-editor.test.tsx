// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GradientEditorState } from "./gradient-editor";
import GradientEditor from "./gradient-editor";

const getLastState = (onChange: ReturnType<typeof vi.fn>): GradientEditorState => {
	const calls = onChange.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return calls[calls.length - 1][0] as GradientEditorState;
};

describe("GradientEditor", () => {
	it("emits unique point IDs after an interaction", async () => {
		const onChange = vi.fn();
		render(<GradientEditor onChange={onChange} />);

		const removeButton = screen.getByRole("button", { name: "Remove color" });
		fireEvent.click(removeButton);
		await waitFor(() => expect(onChange).toHaveBeenCalled());

		const state = getLastState(onChange);
		const ids = state.points.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain("main");
		expect(ids).toHaveLength(2);
	});

	it("generates a fresh ID after remove→add instead of reusing an existing one", async () => {
		const onChange = vi.fn();
		render(<GradientEditor onChange={onChange} />);

		fireEvent.click(screen.getByRole("button", { name: "Remove color" }));
		await waitFor(() => expect(getLastState(onChange).points).toHaveLength(2));
		expect(getLastState(onChange).points.map((p) => p.id)).toEqual(["main", "o1"]);

		fireEvent.click(screen.getByRole("button", { name: "Add color" }));
		await waitFor(() => expect(getLastState(onChange).points).toHaveLength(3));
		const finalIds = getLastState(onChange).points.map((p) => p.id);
		expect(new Set(finalIds).size).toBe(finalIds.length);
		expect(finalIds).toContain("o3");
	});

	it("disables add at MAX_COLORS and remove at one color", async () => {
		render(<GradientEditor onChange={vi.fn()} />);

		const addButton = screen.getByRole("button", { name: "Add color" });
		const removeButton = screen.getByRole("button", { name: "Remove color" });

		expect(addButton).toBeDisabled();
		expect(removeButton).not.toBeDisabled();

		fireEvent.click(removeButton);
		await waitFor(() => expect(addButton).not.toBeDisabled());

		fireEvent.click(removeButton);
		await waitFor(() => expect(removeButton).toBeDisabled());
		expect(addButton).not.toBeDisabled();
	});

	it("cycles harmony when eligible", async () => {
		const onChange = vi.fn();
		render(<GradientEditor onChange={onChange} />);

		fireEvent.click(screen.getByRole("button", { name: "Cycle harmony" }));
		await waitFor(() => expect(onChange).toHaveBeenCalled());
		expect(getLastState(onChange).harmonyType).not.toBe("splitComplementary");
	});
});
