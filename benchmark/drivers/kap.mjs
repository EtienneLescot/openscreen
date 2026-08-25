/**
 * Kap — the open-source minimum.
 *
 * Kap has no background, no padding, no corner radius, no shadow and no zooms: it trims and
 * re-encodes, and that is all it claims to do. It cannot express the full-demo scenario and is
 * not a peer of the other apps here. It is kept because it answers a question the synthetic
 * ffmpeg floor cannot — what a *real, shipping app* costs to get a frame from disk to disk on
 * this machine, Electron shell and all. Its row is always marked partial.
 *
 * Automation: Kap is Electron with no accessibility tree, so `System Events` sees an empty
 * window. Launched with `--remote-debugging-port` its renderer is reachable, and the export
 * button, the settings fields and the progress text are all plain DOM.
 *
 * Two things about Kap shape this driver:
 *
 * 1. **Its editor is single-use.** Once an export finishes, the Convert button is replaced by a
 *    share prompt, so a second run has nothing to click. Each run therefore opens the clip
 *    again — before the clock starts, so it is not measured.
 * 2. **Its export destination is a native popup menu** that neither CDP nor the accessibility
 *    API can open. The driver uses Kap's clipboard destination instead — the same render,
 *    writing to a temp directory — and adopts the file it produces. Kap's own "Export complete"
 *    is the stop signal, so the adoption copy is never counted.
 */
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CdpSession, DOM_HELPERS, listTargets } from "../lib/cdp.mjs";
import { now, sleep } from "../lib/measure.mjs";
import { appIsRunning, quitApp } from "../lib/uiScript.mjs";

const APP = "/Applications/Kap.app";
const BIN = `${APP}/Contents/MacOS/Kap`;
const PORT = 9334;
const HISTORY = join(
	homedir(),
	"Library",
	"Application Support",
	"Kap",
	"export-usage-history.json",
);

/** Every `<tmp>/<hash>/*.mp4` Kap could have written. */
function tempExports() {
	const base = process.env.TMPDIR || tmpdir();
	const out = new Map();
	let dirs = [];
	try {
		dirs = readdirSync(base);
	} catch {
		return out;
	}
	for (const d of dirs) {
		const dir = join(base, d);
		let entries = [];
		try {
			if (!statSync(dir).isDirectory()) continue;
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of entries) {
			if (!f.endsWith(".mp4")) continue;
			const p = join(dir, f);
			try {
				out.set(p, statSync(p).mtimeMs);
			} catch {
				/* vanished between readdir and stat */
			}
		}
	}
	return out;
}

/** Open the source clip in a fresh Kap editor and pin its output fields. */
async function openEditor(ctx) {
	execFileSync("/usr/bin/open", ["-a", APP, ctx.source.path]);
	await sleep(8000);
	const target = (await listTargets(PORT)).find((t) => t.url.includes("editor.html"));
	if (!target) throw new Error("Kap did not open an editor window for the source clip");
	const session = new CdpSession(target.webSocketDebuggerUrl);
	await session.open();
	await session.eval(DOM_HELPERS);

	const t = ctx.scenario.output;
	const raw = await session.eval(`(() => {
		const setNative = (el, v) => {
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
			setter.call(el, String(v));
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		};
		const ins = [...document.querySelectorAll("input")];
		const w = ins.find(i => i.value === "1920") || ins[ins.length - 3];
		const h = ins.find(i => i.value === "1080") || ins[ins.length - 2];
		const f = ins[ins.length - 1];
		if (w) setNative(w, ${t.width});
		if (h) setNative(h, ${t.height});
		if (f) setNative(f, ${t.fps});
		return JSON.stringify({
			format: (document.querySelector(".format") || {}).innerText,
			plugin: (document.querySelector(".plugin") || {}).innerText,
			values: [...document.querySelectorAll("input")].map(i => i.value),
		});
	})()`);
	return { session, state: JSON.parse(raw) };
}

export default {
	id: "kap",
	displayName: "Kap",
	vendor: "Wulkano",
	kind: "gui",
	automation: "cdp",
	processName: "Kap",
	appPath: APP,
	bundleId: "com.wulkano.kap",
	install: {
		method: "dmg",
		url: "https://github.com/wulkano/Kap/releases/download/v3.6.0/Kap-3.6.0-arm64.dmg",
		version: "3.6.0",
		appName: "Kap.app",
		approxMB: 119,
		licence: "MIT — free",
	},

	detect() {
		if (!existsSync(BIN)) return { installed: false, version: null, path: null };
		let version = null;
		try {
			version = execFileSync(
				"/usr/bin/defaults",
				["read", `${APP}/Contents/Info.plist`, "CFBundleShortVersionString"],
				{ encoding: "utf8" },
			).trim();
		} catch {
			/* keep null */
		}
		return { installed: true, version, path: BIN };
	},

	async prepare(ctx) {
		// Kap picks its default format from a usage ledger rather than a setting. Promoting mp4
		// there is how the editor opens on MP4 instead of GIF without touching the UI.
		if (existsSync(HISTORY)) {
			try {
				const h = JSON.parse(readFileSync(HISTORY, "utf8"));
				for (const k of Object.keys(h)) h[k].lastUsed = 1;
				h.mp4 = { lastUsed: 99, plugins: { default: 99 } };
				writeFileSync(HISTORY, JSON.stringify(h, null, 1));
			} catch {
				/* a fresh install has no ledger; the default is fine */
			}
		}

		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
		await sleep(1500);
		execFileSync("/bin/sh", [
			"-c",
			`nohup ${JSON.stringify(BIN)} --remote-debugging-port=${PORT} >/dev/null 2>&1 &`,
		]);
		await sleep(9000);

		const { session, state } = await openEditor(ctx);
		ctx.state.cdp = session;

		const applied = /mp4/i.test(state.format ?? "") ? ["targetResolution", "targetFps"] : [];
		return {
			appliedFeatures: applied,
			notes: [
				`format selector reads "${state.format}", destination "${state.plugin}"`,
				"Kap has no background, padding, corner-radius, shadow or zoom features — the full-demo scenario cannot be expressed, so this row is a re-encode reference rather than a competitor.",
			],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);
		const before = tempExports();

		let s = ctx.state.cdp;
		const hasButton = await s
			.eval(
				'String(!!(document.querySelector("button.start-export") || [...document.querySelectorAll("button")].find((x) => /convert/i.test(x.innerText))))',
			)
			.catch(() => "false");
		if (hasButton !== "true") {
			s?.close();
			const reopened = await openEditor(ctx);
			s = reopened.session;
			ctx.state.cdp = s;
		}

		const clicked = await s.eval(`(() => {
			const b = document.querySelector("button.start-export")
				|| [...document.querySelectorAll("button")].find(x => /convert/i.test(x.innerText));
			if (!b) return "no-button";
			b.click();
			return "clicked";
		})()`);
		if (clicked !== "clicked")
			throw new Error(`Kap: could not find the Convert button (${clicked})`);
		ctx.commit();

		const deadline = now() + 30 * 60 * 1000;
		let done = false;
		while (now() < deadline) {
			await sleep(500);
			const txt = await s.eval("document.body.innerText.slice(0, 400)");
			if (/export complete|drag and drop to copy/i.test(txt)) {
				ctx.markComplete();
				done = true;
				break;
			}
		}
		if (!done) throw new Error("Kap never reported the export as complete");

		const after = tempExports();
		const fresh = [...after.entries()]
			.filter(([p, m]) => !before.has(p) || before.get(p) !== m)
			.sort((a, b) => b[1] - a[1]);
		if (!fresh.length)
			throw new Error("Kap reported completion but wrote no file into the temp tree");
		mkdirSync(ctx.outDir, { recursive: true });
		copyFileSync(fresh[0][0], out);
		ctx.state.kapTempPath = fresh[0][0];
	},

	async cleanup(ctx) {
		ctx.state?.cdp?.close();
		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
	},
};
