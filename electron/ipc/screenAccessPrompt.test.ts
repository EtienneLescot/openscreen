import { describe, expect, it } from "vitest";
import {
	isAwaitingScreenPromptAnswer,
	SCREEN_PROMPT_GRACE_MS,
	shouldPromptForScreenAccess,
} from "./screenAccessPrompt";

describe("shouldPromptForScreenAccess", () => {
	it("never prompts once the permission is granted", () => {
		expect(shouldPromptForScreenAccess("granted", null)).toBe(false);
		expect(shouldPromptForScreenAccess("granted", 1_000)).toBe(false);
	});

	it("prompts on the first ask of a launch even though macOS reports denied", () => {
		// The regression this guards: macOS collapses "never asked" into "denied",
		// so a first run used to skip the prompt entirely.
		expect(shouldPromptForScreenAccess("denied", null)).toBe(true);
	});

	it("stops prompting after this launch has already asked", () => {
		// Lets the caller report the real status so the Settings dialog takes over
		// instead of re-prompting on every click.
		expect(shouldPromptForScreenAccess("denied", 1_000)).toBe(false);
		expect(shouldPromptForScreenAccess("restricted", 1_000)).toBe(false);
	});

	it("still prompts on not-determined, whatever this launch has already asked", () => {
		expect(shouldPromptForScreenAccess("not-determined", null)).toBe(true);
		expect(shouldPromptForScreenAccess("not-determined", 1_000)).toBe(true);
	});
});

describe("isAwaitingScreenPromptAnswer", () => {
	it("is not awaiting anything before the prompt has been raised", () => {
		expect(isAwaitingScreenPromptAnswer(null, 10_000)).toBe(false);
	});

	it("holds the real status back while the prompt may still be on screen", () => {
		// Without this the Settings dialog opens over the native prompt and the
		// renderer's retry loop aborts on its first poll, because macOS keeps
		// answering "denied" until the user actually accepts.
		expect(isAwaitingScreenPromptAnswer(1_000, 1_000)).toBe(true);
		expect(isAwaitingScreenPromptAnswer(1_000, 1_000 + SCREEN_PROMPT_GRACE_MS - 1)).toBe(true);
	});

	it("releases the real status once the grace window lapses", () => {
		expect(isAwaitingScreenPromptAnswer(1_000, 1_000 + SCREEN_PROMPT_GRACE_MS)).toBe(false);
		expect(isAwaitingScreenPromptAnswer(1_000, 60_000)).toBe(false);
	});
});
