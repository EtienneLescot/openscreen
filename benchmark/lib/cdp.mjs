/**
 * Chrome DevTools Protocol client — the way into the Electron apps whose UI nothing else can
 * reach.
 *
 * Screen Studio marks its editor window `kCGWindowSharingNone`, so macOS excludes it from every
 * capture API: no screenshot, and therefore no pixel clicking. Its UI is a web view that
 * publishes no accessibility tree either, so `System Events` sees a window with three
 * traffic-light buttons and nothing else. The menu bar is scriptable, but the export dialog is
 * not on it.
 *
 * Launching the app with `--remote-debugging-port` puts its own renderer within reach: the
 * export button can be found by its text and clicked, exactly as a user would, with no
 * coordinates involved. That is a *more* reproducible interaction than clicking pixels, not a
 * less reproducible one — it survives a different display, a moved window and a resized UI.
 *
 * What it does not do is change the app: the flag only opens an inspector, the renderer and the
 * export pipeline are the shipping ones, and every click goes through the app's own handlers.
 * Runs driven this way are recorded as `automation: "cdp"` so a reader can weigh that.
 *
 * Uses Node's built-in WebSocket (Node 22+); no dependency is added to the repo.
 */

export class CdpError extends Error {}

const httpJson = async (port, path) => {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(8000) });
	if (!res.ok) throw new CdpError(`CDP ${path} → HTTP ${res.status}`);
	return res.json();
};

export async function listTargets(port) {
	return httpJson(port, "/json/list");
}

/** Wait for a page target whose url or title matches, e.g. the app's index.html. */
export async function waitForTarget(port, match, { timeoutMs = 60_000, pollMs = 500 } = {}) {
	const re = match instanceof RegExp ? match : new RegExp(match, "i");
	const t0 = Date.now();
	let lastSeen = [];
	while (Date.now() - t0 < timeoutMs) {
		try {
			const targets = await listTargets(port);
			lastSeen = targets.map((t) => `${t.type}:${t.url}`);
			const hit = targets.find(
				(t) => t.type === "page" && (re.test(t.url) || re.test(t.title ?? "")),
			);
			if (hit) return hit;
		} catch {
			/* the app may not be listening yet */
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
	throw new CdpError(
		`no CDP page matched ${re} on port ${port} within ${timeoutMs}ms. Saw: ${lastSeen.join(", ")}`,
	);
}

export class CdpSession {
	constructor(wsUrl) {
		this.wsUrl = wsUrl;
		this.id = 0;
		this.pending = new Map();
		this.ws = null;
	}

	static async attach(port, match, opts) {
		const target = await waitForTarget(port, match, opts);
		const s = new CdpSession(target.webSocketDebuggerUrl);
		await s.open();
		return s;
	}

	open() {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.wsUrl);
			const timer = setTimeout(() => reject(new CdpError("CDP websocket timed out")), 15_000);
			this.ws.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			});
			this.ws.addEventListener("error", (e) => {
				clearTimeout(timer);
				reject(new CdpError(`CDP websocket error: ${e.message ?? e.type}`));
			});
			this.ws.addEventListener("message", (ev) => {
				let msg;
				try {
					msg = JSON.parse(ev.data);
				} catch {
					return;
				}
				const p = this.pending.get(msg.id);
				if (!p) return;
				this.pending.delete(msg.id);
				if (msg.error)
					p.reject(
						new CdpError(`${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ""}`),
					);
				else p.resolve(msg.result);
			});
		});
	}

	send(method, params = {}, { timeoutMs = 120_000 } = {}) {
		const id = ++this.id;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new CdpError(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Evaluate an expression in the page and return its JSON value. */
	async eval(expression, { awaitPromise = true, timeoutMs = 120_000 } = {}) {
		const r = await this.send(
			"Runtime.evaluate",
			{ expression, returnByValue: true, awaitPromise, userGesture: true },
			{ timeoutMs },
		);
		if (r.exceptionDetails) {
			const d = r.exceptionDetails;
			throw new CdpError(d.exception?.description ?? d.text ?? "evaluation failed");
		}
		return r.result?.value;
	}

	close() {
		try {
			this.ws?.close();
		} catch {
			/* already gone */
		}
	}
}

/**
 * A DOM helper injected into the page: find elements by visible text, which is the only
 * selector that survives an app's next release. Returns a description rather than a handle so
 * the caller can log exactly what it matched.
 */
export const DOM_HELPERS = `
(() => {
  if (window.__osbench) return "already";
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const text = (el) => (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim();
  window.__osbench = {
    visible, text,
    /** Every clickable thing on screen, with its text — the discovery call. */
    controls() {
      const sel = 'button,[role="button"],a,[role="menuitem"],[role="tab"],input,select,label,[data-testid]';
      return [...document.querySelectorAll(sel)].filter(visible).map((el, i) => ({
        i, tag: el.tagName.toLowerCase(), type: el.type || null,
        role: el.getAttribute("role"), testid: el.getAttribute("data-testid"),
        text: text(el).slice(0, 80), value: el.value ?? null,
        disabled: !!el.disabled,
        rect: (({x,y,width,height}) => ({x:Math.round(x),y:Math.round(y),w:Math.round(width),h:Math.round(height)}))(el.getBoundingClientRect()),
      }));
    },
    find(needle, { exact = false, tag = null } = {}) {
      const n = needle.toLowerCase();
      const sel = tag || 'button,[role="button"],a,[role="menuitem"],[role="tab"],label,div,span,[data-testid]';
      const hits = [...document.querySelectorAll(sel)].filter(visible).filter((el) => {
        const t = text(el).toLowerCase();
        return exact ? t === n : t.includes(n);
      });
      // Prefer the smallest match: the innermost element carrying the text, not its container.
      hits.sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) -
                          (b.getBoundingClientRect().width * b.getBoundingClientRect().height));
      return hits[0] || null;
    },
    click(needle, opts) {
      const el = this.find(needle, opts);
      if (!el) return { ok: false, reason: "not found", needle };
      const target = el.closest("button,[role='button'],a,[role='menuitem'],label") || el;
      const r = target.getBoundingClientRect();
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, view: window,
          clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
        }));
      }
      return { ok: true, matched: this.text(target).slice(0, 80), rect: { x: Math.round(r.x), y: Math.round(r.y) } };
    },
  };
  return "installed";
})()
`;
