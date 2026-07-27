// Guards the 1.8.0 provider removal. `openai-oauth` and `copilot-proxy` reached
// a user's subscription by presenting GitHub's and OpenAI's own OAuth client IDs
// and an editor User-Agent against first-party-only endpoints, inside a signed
// installer. They come back on the Copilot SDK / `codex app-server` instead.
//
// This is a lint, not a unit test: it fails if someone re-adds a provider that
// points at one of those endpoints, or an auth kind the app no longer implements.

import { describe, expect, it } from "vitest";
import { PROVIDER_DEFINITIONS } from "./provider-registry";

const FIRST_PARTY_ONLY_HOSTS = [
	"chatgpt.com/backend-api",
	"copilot_internal",
	"githubcopilot.com",
	"api.individual.githubcopilot.com",
];

describe("PROVIDER_DEFINITIONS", () => {
	it("ships only API-key providers", () => {
		const others = PROVIDER_DEFINITIONS.filter((def) => def.authKind !== "api-key");
		expect(others.map((d) => d.id)).toEqual([]);
	});

	it("points at no endpoint reserved for a vendor's own clients", () => {
		const offenders = PROVIDER_DEFINITIONS.filter((def) =>
			FIRST_PARTY_ONLY_HOSTS.some((host) => def.baseUrl?.includes(host)),
		);
		expect(offenders.map((d) => `${d.id} -> ${d.baseUrl}`)).toEqual([]);
	});

	it("no longer defines the two removed providers", () => {
		const ids = PROVIDER_DEFINITIONS.map((def) => def.id);
		expect(ids).not.toContain("openai-oauth");
		expect(ids).not.toContain("copilot-proxy");
	});
});
