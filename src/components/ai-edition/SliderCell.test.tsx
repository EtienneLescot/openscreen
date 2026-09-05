// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SliderCell } from "./RightPanes";

describe("SliderCell", () => {
	it("computes and sets --slider-pct gauge property correctly", () => {
		render(
			<SliderCell
				label="Volume"
				value={25}
				min={0}
				max={100}
				onChange={vi.fn()}
				onCommit={vi.fn()}
			/>,
		);
		const slider = screen.getByRole("slider", { name: "Volume" });
		expect(slider.style.getPropertyValue("--slider-pct")).toBe("25%");
	});

	it("clamps --slider-pct to 0% and 100% at boundaries", () => {
		const { rerender } = render(
			<SliderCell
				label="Opacity"
				value={-10}
				min={0}
				max={50}
				onChange={vi.fn()}
				onCommit={vi.fn()}
			/>,
		);
		const slider = screen.getByRole("slider", { name: "Opacity" });
		expect(slider.style.getPropertyValue("--slider-pct")).toBe("0%");

		rerender(
			<SliderCell
				label="Opacity"
				value={60}
				min={0}
				max={50}
				onChange={vi.fn()}
				onCommit={vi.fn()}
			/>,
		);
		expect(slider.style.getPropertyValue("--slider-pct")).toBe("100%");
	});

	it("applies full layout class when full prop is true", () => {
		const { container } = render(
			<SliderCell
				full
				label="Webcam size"
				value={20}
				min={10}
				max={50}
				onChange={vi.fn()}
				onCommit={vi.fn()}
			/>,
		);
		const cell = container.firstElementChild;
		expect(cell?.className).toContain("full");
	});
});
