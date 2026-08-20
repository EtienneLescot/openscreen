import { info, setFailed, warning } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { createForumThread, postChannelMessage } from "./discord-bot-api.mjs";

const botToken = (process.env.DISCORD_BOT_TOKEN || "").trim();
const channelId = (
	process.env.DISCORD_RC_TESTING_CHANNEL_ID ||
	process.env.DISCORD_RELEASE_CHANNEL_ID ||
	""
).trim();

const kind = (process.env.KIND || "stable").trim();
const stableTag = (process.env.STABLE_TAG || "").trim();
const rcTag = (process.env.RC_TAG || "").trim();
const extra = (process.env.EXTRA || "").trim();

// Set only by announce-release.yml. Every path below that ends without posting
// used to exit 0, which is right when prerelease.yml and promote.yml call this:
// the release is already out, the announcement is bookkeeping, and failing the
// job would misreport a successful release. A manual dispatch has the opposite
// contract — it exists *because* an announcement was missed, so a green run
// that posted nothing recreates the exact failure it was invoked to repair.
const strict = (process.env.STRICT || "").trim() !== "";

/** Ends the run without announcing: fatal under STRICT, a skip otherwise. */
function bail(message, note = warning) {
	if (strict) {
		setFailed(message);
		process.exit(1);
	}
	note(message);
	process.exit(0);
}

if (!stableTag) {
	bail("STABLE_TAG missing; skipping.");
}
if (!botToken || !channelId) {
	bail("Discord announce skipped: set DISCORD_BOT_TOKEN and a channel id variable.", info);
}

const owner = context.repo.owner;
const repo = context.repo.repo;
const releaseUrl = `${context.serverUrl}/${owner}/${repo}/releases/tag/${stableTag}`;
const stableVersion = stableTag.replace(/^v/, "").replace(/-.*$/, "");

let closedIssues = [];
if (process.env.GITHUB_TOKEN) {
	try {
		const octokit = getOctokit(process.env.GITHUB_TOKEN);
		const versionTitle = `v${stableVersion}`;
		const milestones = await octokit.paginate(octokit.rest.issues.listMilestones, {
			owner,
			repo,
			state: "closed",
			per_page: 100,
		});
		const m = milestones.find((x) => x.title === versionTitle);
		if (m) {
			const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
				owner,
				repo,
				milestone: `${m.number}`,
				state: "closed",
				per_page: 100,
			});
			closedIssues = issues
				.filter((i) => !i.pull_request)
				.slice(0, 20)
				.map((i) => `• [#${i.number}](${i.html_url}) ${i.title}`);
		}
	} catch (err) {
		warning(`Failed to fetch closed issues: ${err?.message ?? err}`);
	}
}

const isRc = kind === "rc";
const embedTitle = isRc
	? `🧪 ${stableTag} release candidate ready for testing`
	: `🚀 ${stableTag} released`;
const threadName = (isRc ? `${stableTag} RC — testing` : `${stableTag} released`).slice(0, 100);
const color = isRc ? 15844367 : 5814783;

const description = [
	extra ? `> ${extra}\n` : "",
	`📦 **Download:** [${stableTag}](${releaseUrl})`,
	isRc && rcTag ? `_Promoted from \`${rcTag}\`_` : "",
	closedIssues.length > 0 ? `\n**Closed issues in this release:**\n${closedIssues.join("\n")}` : "",
]
	.filter(Boolean)
	.join("\n");

const embed = {
	title: embedTitle,
	url: releaseUrl,
	description,
	color,
	timestamp: new Date().toISOString(),
};

// Discord channel types that require a thread wrapper (no top-level messages).
const FORUM_LIKE_TYPES = new Set([15, 16]); // 15 = GUILD_FORUM, 16 = GUILD_MEDIA

async function fetchChannelType() {
	const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
		headers: { Authorization: `Bot ${botToken}` },
	});
	if (!res.ok) {
		const txt = await res.text();
		// Returned rather than reported here, so the single exit policy in bail()
		// decides whether a failed lookup is fatal.
		return { error: `Discord channel fetch failed ${res.status}: ${txt}` };
	}
	return { channel: await res.json() };
}

async function announceToForum() {
	const thread = await createForumThread({
		botToken,
		forumChannelId: channelId,
		payload: {
			name: threadName,
			auto_archive_duration: 4320,
			message: {
				embeds: [embed],
				allowed_mentions: { parse: [] },
			},
		},
	});
	info(`📣 ${kind} announcement posted to forum thread ${thread.id}.`);
}

async function announceToText() {
	const result = await postChannelMessage({
		botToken,
		channelId,
		payload: {
			embeds: [embed],
			allowed_mentions: { parse: [] },
		},
	});
	info(`📣 ${kind} announcement posted to text channel (id=${result.id}).`);
}

const { channel, error } = await fetchChannelType();
if (error) {
	bail(error);
}

try {
	if (FORUM_LIKE_TYPES.has(channel.type)) {
		await announceToForum();
	} else {
		await announceToText();
	}
} catch (err) {
	// Not bail(): this is the last statement, so there is nothing left to skip
	// and the non-strict path must fall through rather than exit — "handles 4xx
	// gracefully without throwing" pins that the module finishes on its own.
	const message = `Discord announce failed: ${err?.message ?? err}`;
	if (strict) {
		setFailed(message);
		process.exit(1);
	}
	warning(message);
}
