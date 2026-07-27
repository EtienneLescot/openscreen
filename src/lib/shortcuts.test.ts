import { describe, expect, it } from "vitest";
import {
	DEFAULT_SHORTCUTS,
	findConflict,
	mergeWithDefaults,
	SHORTCUT_ACTIONS,
	SHORTCUT_LABELS,
	type ShortcutsConfig,
} from "./shortcuts";

describe("shortcut registry", () => {
	// Every action in the list is offered by ShortcutsConfigDialog and matched by
	// findConflict. An action that has no default binding, or a default binding
	// nothing dispatches, becomes a phantom the user can collide with — which is
	// exactly what "addBlur" was before it was removed.
	it("gives every action a default binding and a label", () => {
		for (const action of SHORTCUT_ACTIONS) {
			expect(DEFAULT_SHORTCUTS[action], `${action} has no default binding`).toBeDefined();
			expect(SHORTCUT_LABELS[action], `${action} has no label`).toBeTruthy();
		}
		expect(Object.keys(DEFAULT_SHORTCUTS).sort()).toEqual([...SHORTCUT_ACTIONS].sort());
	});

	it("leaves a plain 'b' free to bind", () => {
		// The blur *region* was never implemented — blur ships as an annotation
		// type. While `addBlur: {key: "b"}` was still in the registry, binding B to
		// any real action reported "Already used by Add Blur" and offered a Swap
		// that handed the old binding to a hidden, undispatched action.
		expect(findConflict({ key: "b" }, "addZoom", DEFAULT_SHORTCUTS)).toBeNull();
	});

	it("still reports a real collision", () => {
		expect(findConflict({ key: "z" }, "addTrim", DEFAULT_SHORTCUTS)).toEqual({
			type: "configurable",
			action: "addZoom",
		});
	});

	it("ignores stored bindings for actions that no longer exist", () => {
		// mergeWithDefaults iterates SHORTCUT_ACTIONS, so a config saved before an
		// action was dropped loads without a migration.
		const stored = { addZoom: { key: "q" }, addBlur: { key: "b" } };
		const merged = mergeWithDefaults(stored as Partial<ShortcutsConfig>);
		expect(merged.addZoom).toEqual({ key: "q" });
		expect(merged).not.toHaveProperty("addBlur");
	});
});
