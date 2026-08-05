// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startGlobalPointerDrag } from "./pointer-drag";

// `Element` declares the three pointer-capture methods as always present, but jsdom
// may ship without them — hence Omit + optional redeclaration rather than `extends`,
// which cannot make an inherited required member optional.
type ElementWithCapture = Omit<
	Element,
	"hasPointerCapture" | "setPointerCapture" | "releasePointerCapture"
> & {
	hasPointerCapture?: (id: number) => boolean;
	setPointerCapture?: (id: number) => void;
	releasePointerCapture?: (id: number) => void;
};

describe("startGlobalPointerDrag", () => {
	beforeEach(() => {
		// jsdom doesn't implement pointer capture; patch so the helper doesn't throw.
		const proto = Element.prototype as ElementWithCapture;
		if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
		if (!proto.setPointerCapture) proto.setPointerCapture = () => undefined;
		if (!proto.releasePointerCapture) proto.releasePointerCapture = () => undefined;
	});

	it("invokes onMove on subsequent pointermove and onEnd on pointerup", () => {
		const onMove = vi.fn();
		const onEnd = vi.fn();
		const { getByRole } = render(
			<button
				type="button"
				onPointerDown={(event) => startGlobalPointerDrag(event, { onMove, onEnd })}
			>
				go
			</button>,
		);
		fireEvent.pointerDown(getByRole("button"), { pointerId: 1, buttons: 1 });
		fireEvent.pointerMove(window, { pointerId: 1, buttons: 1 });
		fireEvent.pointerUp(window, { pointerId: 1 });
		expect(onMove).toHaveBeenCalledTimes(1);
		expect(onEnd).toHaveBeenCalledWith("pointerup", expect.anything());
	});

	it("ends early when buttons drop to 0 mid-move", () => {
		const onEnd = vi.fn();
		const { getByRole } = render(
			<button
				type="button"
				onPointerDown={(event) =>
					startGlobalPointerDrag(event, {
						onMove: (_e) => undefined,
						onEnd,
					})
				}
			>
				go
			</button>,
		);
		fireEvent.pointerDown(getByRole("button"), { pointerId: 2, buttons: 1 });
		fireEvent.pointerMove(window, { pointerId: 2, buttons: 0 });
		expect(onEnd).toHaveBeenCalledWith("pointerup", expect.anything());
	});

	it("ignores pointermove from other pointerIds", () => {
		const onMove = vi.fn();
		const { getByRole } = render(
			<button
				type="button"
				onPointerDown={(event) =>
					startGlobalPointerDrag(event, {
						onMove,
						onEnd: (_r, _e) => undefined,
					})
				}
			>
				go
			</button>,
		);
		fireEvent.pointerDown(getByRole("button"), { pointerId: 3, buttons: 1 });
		fireEvent.pointerMove(window, { pointerId: 99, buttons: 1 });
		expect(onMove).not.toHaveBeenCalled();
	});

	it("ends with window-blur when the window loses focus", () => {
		const onEnd = vi.fn();
		const { getByRole } = render(
			<button
				type="button"
				onPointerDown={(event) =>
					startGlobalPointerDrag(event, {
						onMove: (_e) => undefined,
						onEnd,
					})
				}
			>
				go
			</button>,
		);
		fireEvent.pointerDown(getByRole("button"), { pointerId: 4, buttons: 1 });
		fireEvent.blur(window);
		expect(onEnd).toHaveBeenCalledWith("window-blur", undefined);
	});

	it("cancel-returned function ends with pointercancel", () => {
		const onEnd = vi.fn();
		// Seeded with a no-op instead of null: the assignment happens inside the
		// pointerdown handler, which control-flow analysis cannot see, so a nullable
		// `cancel` narrows to `null` and stops being callable at the call site below.
		// If the handler never ran, calling the no-op leaves `onEnd` unfired and the
		// expectation still fails.
		let cancel: () => void = () => undefined;
		const { getByRole } = render(
			<button
				type="button"
				onPointerDown={(event) => {
					cancel = startGlobalPointerDrag(event, {
						onMove: (_e) => undefined,
						onEnd,
					});
				}}
			>
				go
			</button>,
		);
		fireEvent.pointerDown(getByRole("button"), { pointerId: 5, buttons: 1 });
		cancel();
		expect(onEnd).toHaveBeenCalledWith("pointercancel", undefined);
	});
});
