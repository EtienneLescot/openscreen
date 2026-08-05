// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Le traducteur renvoie la clé : une assertion lit mieux contre une clé que contre une phrase qui
// bouge à chaque relecture de copie.
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, vars?: Record<string, unknown>) =>
		vars ? `${key}:${Object.values(vars).join(",")}` : key,
}));

import { COLOR_PRESETS, ColorField } from "./ColorField";

beforeAll(() => {
	// Le popover Radix mesure sa cible ; jsdom n'a pas de ResizeObserver.
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = () => undefined;
			unobserve = () => undefined;
			disconnect = () => undefined;
		},
	);
});

function renderField(value = "#3b82f6") {
	const onChange = vi.fn();
	const onCommit = vi.fn();
	render(
		<ColorField value={value} onChange={onChange} onCommit={onCommit} label="annotation.color" />,
	);
	return { onChange, onCommit, trigger: screen.getByLabelText("annotation.color") };
}

describe("ColorField", () => {
	it("keeps the picker closed until the swatch is clicked", () => {
		const { trigger } = renderField();
		expect(screen.queryByLabelText("annotation.colorPalette")).not.toBeInTheDocument();
		fireEvent.click(trigger);
		expect(screen.getByLabelText("annotation.colorPalette")).toBeInTheDocument();
	});

	it("offers the presets inside the picker, not beside the field", () => {
		// Le point de la demande : une seule pastille dans le panneau, les présélections à
		// l'intérieur du sélecteur pour que chaque fonctionnalité offre le même contrôle.
		const { trigger } = renderField();
		fireEvent.click(trigger);
		const palette = screen.getByLabelText("annotation.colorPalette");
		expect(palette.children).toHaveLength(COLOR_PRESETS.length);
	});

	it("applies a preset and commits it in one click", () => {
		const { onChange, onCommit, trigger } = renderField();
		fireEvent.click(trigger);
		fireEvent.click(screen.getByLabelText("inspector.setColor:#22c55e"));
		expect(onChange).toHaveBeenCalledWith("#22c55e");
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("marks the current colour as pressed so the picker shows where you are", () => {
		const { trigger } = renderField("#22c55e");
		fireEvent.click(trigger);
		expect(screen.getByLabelText("inspector.setColor:#22c55e")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByLabelText("inspector.setColor:#ffffff")).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});

	it("pushes a typed hex once it is complete, and not before", () => {
		const { onChange, trigger } = renderField();
		fireEvent.click(trigger);
		const hex = screen.getByLabelText("annotation.colorWheel");
		fireEvent.change(hex, { target: { value: "#22c5" } });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.change(hex, { target: { value: "#22c55e" } });
		expect(onChange).toHaveBeenCalledWith("#22c55e");
	});

	it("accepts a hex typed without its leading #", () => {
		const { onChange, trigger } = renderField();
		fireEvent.click(trigger);
		fireEvent.change(screen.getByLabelText("annotation.colorWheel"), {
			target: { value: "22c55e" },
		});
		expect(onChange).toHaveBeenCalledWith("#22c55e");
	});

	it("commits once when the picker closes, not on every wheel event", () => {
		// La roue émet en continu ; committer à chaque événement reconstruisait toute la scène et
		// rendait le contrôle inutilisable (c'est le lag rapporté).
		const { onCommit, trigger } = renderField();
		fireEvent.click(trigger);
		expect(onCommit).not.toHaveBeenCalled();
		fireEvent.keyDown(document.body, { key: "Escape" });
		expect(onCommit).toHaveBeenCalledTimes(1);
	});
});
