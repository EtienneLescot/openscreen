// check-docs.mjs gained `.harness/` because that tree rotted unwatched:
// `git-workflow.md` and `memory/MEMORY.md` both described the pre-#90
// `release/vX.Y.Z-rc.N` branch naming for a month, sending anyone who read them
// to a branch the workflows never create, while the same fact stayed correct
// under technical-documentation/ because this script was watching that tree.
//
// The failure mode worth guarding is not a missed doc — it is this script
// reporting OK while checking nothing. If the walk silently stops covering a
// tree, or a LEGACY entry stops matching, the output is still a green
// `check-docs: OK` and the rot resumes invisibly for months. So assert the
// script actually *rejects* something, not just that it exits 0.
//
// Run as a subprocess rather than imported: the script exits on failure and
// resolves its own root from `import.meta.dirname`, so it is not parameterisable
// without a refactor the guard does not need.

import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-docs.mjs");

/** @returns {{code: number, out: string}} */
function run() {
	try {
		return { code: 0, out: execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" }) };
	} catch (e) {
		return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

describe("check-docs", () => {
	it("passes on the tree as committed", () => {
		const { code, out } = run();
		expect(out).toContain("check-docs: OK");
		expect(code).toBe(0);
	});

	// Both spellings, because the rot used both and the first version of this
	// guard only caught one. The prose said `release/vX.Y.Z-rc.N`, but the
	// copy-pasteable shell block said `release/v1.5.0-rc.1` — and that block is
	// what an operator restores from git history when the dispatch UI is down.
	// A substring check on the placeholder waves the concrete one straight
	// through, which is the more dangerous of the two.
	for (const naming of ["release/vX.Y.Z-rc.N", "release/v1.5.0-rc.1"]) {
		it(`rejects the retired release-branch naming "${naming}" inside .harness/`, () => {
			// .harness/ specifically: technical-documentation/ was never the tree that
			// went stale, so planting there would pass even if the walk lost .harness/.
			const probe = path.join(ROOT, ".harness", "docs", "_check-docs-probe.md");
			writeFileSync(probe, `# probe\n\n\`\`\`bash\ngit checkout ${naming}\n\`\`\`\n`);
			try {
				const { code, out } = run();
				expect(out).toContain("_check-docs-probe.md");
				expect(out).toContain(naming);
				expect(code).toBe(1);
			} finally {
				rmSync(probe, { force: true });
			}
		});
	}

	// A guard that over-fires gets switched off, so pin what must NOT trip it:
	// RC *tags* carry the `-rc.N` suffix and are current, the stable release
	// branch and its ephemeral sync branch are current, and backport lines use
	// `release/1.4.x`.
	it("accepts the naming that is still current", () => {
		const probe = path.join(ROOT, ".harness", "docs", "_check-docs-probe.md");
		writeFileSync(
			probe,
			"# probe\n\nTag `v1.6.0-rc.1` on `release/v1.6.0`, synced via `release/v1.6.0-sync`; backports on `release/1.4.x`.\n",
		);
		try {
			const { code, out } = run();
			expect(out).toContain("check-docs: OK");
			expect(code).toBe(0);
		} finally {
			rmSync(probe, { force: true });
		}
	});
});
