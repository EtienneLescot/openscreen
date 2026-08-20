import { setFailed } from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateForumThread = vi.fn();
const mockPostChannelMessage = vi.fn();
const mockListMilestones = vi.fn();
const mockListForRepo = vi.fn();

vi.mock("@actions/core", () => ({
	info: vi.fn(),
	warning: vi.fn(),
	setFailed: vi.fn(),
}));
vi.mock("@actions/github", () => ({
	context: {
		repo: { owner: "acme", repo: "widget" },
		serverUrl: "https://github.com",
	},
	getOctokit: () => ({
		paginate: async (fn, opts) => {
			if (fn === mockListMilestones) return mockListMilestones(opts);
			if (fn === mockListForRepo) return mockListForRepo(opts);
			return [];
		},
		rest: {
			issues: {
				listMilestones: mockListMilestones,
				listForRepo: mockListForRepo,
			},
		},
	}),
}));
vi.mock("./discord-bot-api.mjs", () => ({
	createForumThread: mockCreateForumThread,
	postChannelMessage: mockPostChannelMessage,
}));

async function loadScript(env) {
	vi.resetModules();
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`process.exit unexpectedly called with "${code}"`);
	});
	for (const [k, v] of Object.entries(env)) {
		process.env[k] = v;
	}
	return import("./discord-release-announce.mjs");
}

const BASE_ENV = {
	DISCORD_BOT_TOKEN: "test-token",
	GITHUB_TOKEN: "test-github",
	STABLE_TAG: "v1.5.0",
};

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn());
	vi.mocked(setFailed).mockReset();
	mockCreateForumThread.mockReset();
	mockPostChannelMessage.mockReset();
	mockListMilestones.mockReset();
	mockListForRepo.mockReset();
	mockListMilestones.mockResolvedValue([]);
	mockListForRepo.mockResolvedValue([]);
	for (const k of Object.keys(process.env)) {
		if (
			k.startsWith("DISCORD_") ||
			k === "GITHUB_TOKEN" ||
			k === "STABLE_TAG" ||
			k === "RC_TAG" ||
			k === "KIND" ||
			k === "EXTRA" ||
			k === "STRICT"
		) {
			delete process.env[k];
		}
	}
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("discord-release-announce", () => {
	it("skips when STABLE_TAG is missing", async () => {
		await expect(
			loadScript({ DISCORD_BOT_TOKEN: "t", DISCORD_RC_TESTING_CHANNEL_ID: "c" }),
		).rejects.toThrow(/process\.exit.*"0"/);
		expect(mockCreateForumThread).not.toHaveBeenCalled();
		expect(mockPostChannelMessage).not.toHaveBeenCalled();
	});

	it("skips when bot token or channel id is missing", async () => {
		await expect(loadScript({ STABLE_TAG: "v1.0.0" })).rejects.toThrow(/process\.exit.*"0"/);
		expect(mockCreateForumThread).not.toHaveBeenCalled();
		expect(mockPostChannelMessage).not.toHaveBeenCalled();
	});

	it("posts a forum thread when the channel is a forum (type 15)", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ type: 15, name: "rc-testing" }),
		});
		mockCreateForumThread.mockResolvedValue({ id: "thread-1" });

		await loadScript({
			...BASE_ENV,
			DISCORD_RC_TESTING_CHANNEL_ID: "1521416826146263051",
			KIND: "rc",
			RC_TAG: "v1.4.5-rc.3",
		});

		expect(mockCreateForumThread).toHaveBeenCalledTimes(1);
		const args = mockCreateForumThread.mock.calls[0][0];
		expect(args.botToken).toBe("test-token");
		expect(args.forumChannelId).toBe("1521416826146263051");
		expect(args.payload.name).toBe("v1.5.0 RC — testing".slice(0, 100));
		expect(args.payload.message.embeds[0].title).toContain("release candidate");
		expect(args.payload.message.embeds[0].description).toContain(
			"https://github.com/acme/widget/releases/tag/v1.5.0",
		);
		expect(args.payload.message.embeds[0].description).toContain("Promoted from `v1.4.5-rc.3`");
		expect(mockPostChannelMessage).not.toHaveBeenCalled();
	});

	it("posts a media thread when the channel is media (type 16)", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ type: 16 }),
		});
		mockCreateForumThread.mockResolvedValue({ id: "thread-2" });

		await loadScript({ ...BASE_ENV, DISCORD_RELEASE_CHANNEL_ID: "1493594372409917512" });

		expect(mockCreateForumThread).toHaveBeenCalledTimes(1);
		expect(mockPostChannelMessage).not.toHaveBeenCalled();
	});

	it("posts a regular message when the channel is text (type 0)", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ type: 0 }),
		});
		mockPostChannelMessage.mockResolvedValue({ id: "msg-1" });

		await loadScript({ ...BASE_ENV, DISCORD_RELEASE_CHANNEL_ID: "123" });

		expect(mockPostChannelMessage).toHaveBeenCalledTimes(1);
		const args = mockPostChannelMessage.mock.calls[0][0];
		expect(args.channelId).toBe("123");
		expect(args.payload.embeds[0].title).toContain("released");
		expect(mockCreateForumThread).not.toHaveBeenCalled();
	});

	it("includes closed issues from the versioned milestone", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ type: 0 }),
		});
		mockPostChannelMessage.mockResolvedValue({ id: "msg-2" });
		mockListMilestones.mockResolvedValue([{ number: 7, title: "v1.5.0" }]);
		mockListForRepo.mockResolvedValue([
			{ number: 42, title: "fix bug", html_url: "https://x/42", pull_request: null },
			{ number: 43, title: "add feature", html_url: "https://x/43", pull_request: { url: "x" } },
		]);

		await loadScript({ ...BASE_ENV, DISCORD_RELEASE_CHANNEL_ID: "123" });

		const args = mockPostChannelMessage.mock.calls[0][0];
		const desc = args.payload.embeds[0].description;
		expect(desc).toContain("Closed issues in this release");
		expect(desc).toContain("#42");
		expect(desc).toContain("fix bug");
		expect(desc).not.toContain("add feature");
	});

	it("handles 4xx gracefully without throwing", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ type: 0 }),
		});
		mockPostChannelMessage.mockRejectedValue(new Error("failed 403: Missing Permissions"));

		await loadScript({ ...BASE_ENV, DISCORD_RELEASE_CHANNEL_ID: "123" });
		expect(mockPostChannelMessage).toHaveBeenCalledTimes(1);
	});
});

// Every path below exits 0 without STRICT, which is correct when prerelease.yml
// and promote.yml call this: the release is already published and a failed
// announcement must not report it as broken. announce-release.yml is dispatched
// *because* an announcement was missed, so the same silence there recreates the
// failure it was invoked to repair — v1.9.0 shipped unannounced exactly that way.
describe("strict mode", () => {
	const STRICT_ENV = { ...BASE_ENV, STRICT: "1", DISCORD_RELEASE_CHANNEL_ID: "123" };
	const exits1 = /process\.exit unexpectedly called with "1"/;

	it("fails when the release tag is missing", async () => {
		await expect(
			loadScript({ ...BASE_ENV, STABLE_TAG: "", STRICT: "1", DISCORD_RELEASE_CHANNEL_ID: "123" }),
		).rejects.toThrow(exits1);
		expect(vi.mocked(setFailed)).toHaveBeenCalledWith(
			expect.stringContaining("STABLE_TAG missing"),
		);
	});

	it("fails when the Discord configuration is missing", async () => {
		await expect(loadScript({ STABLE_TAG: "v1.5.0", STRICT: "1" })).rejects.toThrow(exits1);
		expect(vi.mocked(setFailed)).toHaveBeenCalledWith(expect.stringContaining("DISCORD_BOT_TOKEN"));
	});

	it("fails when the channel lookup fails", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: false,
			status: 403,
			text: async () => "Missing Access",
		});

		await expect(loadScript(STRICT_ENV)).rejects.toThrow(exits1);
		expect(vi.mocked(setFailed)).toHaveBeenCalledWith(expect.stringContaining("403"));
	});

	it("fails when the post itself fails", async () => {
		vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ type: 0 }) });
		mockPostChannelMessage.mockRejectedValue(new Error("failed 403: Missing Permissions"));

		await expect(loadScript(STRICT_ENV)).rejects.toThrow(exits1);
		expect(vi.mocked(setFailed)).toHaveBeenCalledWith(
			expect.stringContaining("Missing Permissions"),
		);
	});

	it("announces normally when everything works", async () => {
		vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ type: 0 }) });
		mockPostChannelMessage.mockResolvedValue({ id: "42" });

		await loadScript(STRICT_ENV);

		expect(mockPostChannelMessage).toHaveBeenCalledTimes(1);
		expect(vi.mocked(setFailed)).not.toHaveBeenCalled();
	});

	it("leaves the release workflows non-fatal without STRICT", async () => {
		vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ type: 0 }) });
		mockPostChannelMessage.mockRejectedValue(new Error("failed 403: Missing Permissions"));

		await loadScript({ ...BASE_ENV, DISCORD_RELEASE_CHANNEL_ID: "123" });

		expect(vi.mocked(setFailed)).not.toHaveBeenCalled();
	});
});
