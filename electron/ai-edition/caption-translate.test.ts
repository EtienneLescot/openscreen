import { describe, expect, it } from "vitest";
import { parseTranslationReply } from "./caption-translate";

describe("parseTranslationReply", () => {
	it("reads a bare JSON array", () => {
		expect(parseTranslationReply('[{"id":"seg_1","text":"bonjour"}]')).toEqual({
			seg_1: "bonjour",
		});
	});

	it("reads a fenced JSON array", () => {
		const raw = '```json\n[{"id":"seg_1","text":"bonjour"}]\n```';
		expect(parseTranslationReply(raw)).toEqual({ seg_1: "bonjour" });
	});

	it("reads an array buried in a lead-in sentence", () => {
		const raw = 'Here you go:\n[{"id":"seg_1","text":"bonjour"}]\nHope that helps!';
		expect(parseTranslationReply(raw)).toEqual({ seg_1: "bonjour" });
	});

	it("skips entries with a missing or empty text", () => {
		const raw = '[{"id":"seg_1","text":"bonjour"},{"id":"seg_2","text":"   "},{"id":"seg_3"}]';
		expect(parseTranslationReply(raw)).toEqual({ seg_1: "bonjour" });
	});

	it("returns nothing when the reply is not a translation at all", () => {
		expect(parseTranslationReply("I cannot help with that.")).toEqual({});
		expect(parseTranslationReply('{"id":"seg_1","text":"bonjour"}')).toEqual({});
	});
});
