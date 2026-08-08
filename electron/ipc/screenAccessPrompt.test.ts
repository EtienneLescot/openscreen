import { describe, expect, it } from "vitest";
import { shouldPromptForScreenAccess } from "./screenAccessPrompt";

describe("shouldPromptForScreenAccess", () => {
	it("never prompts once the permission is granted", () => {
		expect(shouldPromptForScreenAccess("granted", false)).toBe(false);
		expect(shouldPromptForScreenAccess("granted", true)).toBe(false);
	});

	it("prompts on the first ask of a launch even though macOS reports denied", () => {
		// The regression this guards: macOS collapses "never asked" into "denied",
		// so a first run used to skip the prompt entirely.
		expect(shouldPromptForScreenAccess("denied", false)).toBe(true);
	});

	it("stops prompting after this launch has already asked", () => {
		// Lets the caller report the real status so the Settings dialog takes over
		// instead of re-prompting on every click.
		expect(shouldPromptForScreenAccess("denied", true)).toBe(false);
		expect(shouldPromptForScreenAccess("restricted", true)).toBe(false);
	});

	it("still prompts on not-determined, whatever this launch has already asked", () => {
		expect(shouldPromptForScreenAccess("not-determined", false)).toBe(true);
		expect(shouldPromptForScreenAccess("not-determined", true)).toBe(true);
	});
});
