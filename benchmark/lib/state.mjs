/**
 * Run state: an append-only event log plus a single status document.
 *
 * Both exist for the same reason — the benchmark is meant to be started and then left alone,
 * possibly from a remote Claude Code session. Nobody is watching the terminal, so progress has
 * to be readable from disk at any moment, and a run that dies halfway has to be resumable
 * without repeating the expensive parts.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export class RunState {
	constructor(dir, runId) {
		this.dir = dir;
		this.runId = runId;
		mkdirSync(dir, { recursive: true });
		this.eventsPath = join(dir, "events.ndjson");
		this.statusPath = join(dir, "status.json");
		this.resultsPath = join(dir, "results.json");
	}

	event(type, payload = {}) {
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			runId: this.runId,
			type,
			...payload,
		});
		appendFileSync(this.eventsPath, `${line}\n`);
		return line;
	}

	/** Written atomically: a poller must never read a half-serialised status. */
	writeStatus(status) {
		const tmp = `${this.statusPath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
		renameSync(tmp, this.statusPath);
	}

	readStatus() {
		if (!existsSync(this.statusPath)) return null;
		try {
			return JSON.parse(readFileSync(this.statusPath, "utf8"));
		} catch {
			return null;
		}
	}

	writeResults(results) {
		const tmp = `${this.resultsPath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(results, null, 2)}\n`);
		renameSync(tmp, this.resultsPath);
	}

	readResults() {
		if (!existsSync(this.resultsPath)) return null;
		try {
			return JSON.parse(readFileSync(this.resultsPath, "utf8"));
		} catch {
			return null;
		}
	}
}

/** Sortable, human-readable, and stable inside one calendar second. */
export function newRunId(d = new Date()) {
	return d
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
}
