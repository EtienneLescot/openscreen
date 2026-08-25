/**
 * Windows UI automation — the counterpart to uiScript.mjs.
 *
 * The two platforms need the same four things from a GUI app: launch it, find a control by its
 * visible name, click it, and answer a file dialog. macOS answers all four through AppleScript
 * and the accessibility API. Windows answers them through UI Automation (UIA), reached from
 * PowerShell, which is genuinely the same idea under a different name — controls are addressed
 * by AutomationId or Name, not by coordinates, so a driver written against it survives a
 * different display and a moved window.
 *
 * Two things are markedly easier here than on macOS:
 *
 *   · File dialogs take a full path typed straight into the file-name box, so there is no
 *     equivalent of the ⇧⌘G dance, and no risk of the path landing in the editor when the
 *     dialog failed to open.
 *   · Most apps expose a real UIA tree, including Electron ones once accessibility is on —
 *     where on macOS an Electron window is frequently an empty shell.
 *
 * One thing is harder: UIA has no menu-bar equivalent to `System Events`' menu items, because
 * Windows apps mostly do not have a menu bar. Drivers reach for CDP or named controls instead.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { sleep } from "./measure.mjs";
import { IS_WIN, powershell } from "./platform.mjs";

export class UiWindowsError extends Error {
	constructor(message) {
		super(message);
		this.name = "UiWindowsError";
	}
}

const assertWin = () => {
	if (!IS_WIN) throw new UiWindowsError("uiWindows.mjs is Windows-only; use uiScript.mjs on macOS");
};

/** Shared preamble: load UIA and Forms once per PowerShell invocation. */
const PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms | Out-Null
function Get-AppWindows([string]$proc) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, 0)
  $out = @()
  foreach ($p in (Get-Process -Name $proc -ErrorAction SilentlyContinue)) {
    $c = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
    $out += $root.FindAll([System.Windows.Automation.TreeScope]::Children, $c)
  }
  return $out
}
function Find-Descendants($el, [int]$max = 4000) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $stack = New-Object System.Collections.Stack
  $stack.Push($el)
  $seen = 0
  while ($stack.Count -gt 0 -and $seen -lt $max) {
    $n = $stack.Pop(); $seen++
    $n
    $child = $walker.GetFirstChild($n)
    while ($child -ne $null) { $stack.Push($child); $child = $walker.GetNextSibling($child) }
  }
}
`;

const ps = (body, opts) => powershell(PRELUDE + body, opts);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* ------------------------------------------------------------------- lifecycle ----------- */

export function appIsRunning(processName) {
	assertWin();
	return ps(`[bool](Get-Process -Name ${q(processName)} -ErrorAction SilentlyContinue)`) === "True";
}

export async function launchApp(exePath, processName, { args = [], timeoutMs = 90_000 } = {}) {
	assertWin();
	if (!existsSync(exePath)) throw new UiWindowsError(`${exePath} does not exist`);
	const argList = args.length ? `-ArgumentList @(${args.map(q).join(",")})` : "";
	ps(`Start-Process -FilePath ${q(exePath)} ${argList} | Out-Null`);
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (appIsRunning(processName)) return true;
		await sleep(500);
	}
	throw new UiWindowsError(`"${processName}" did not start within ${timeoutMs}ms`);
}

export function activateApp(processName) {
	assertWin();
	try {
		ps(`
			$p = Get-Process -Name ${q(processName)} -ErrorAction SilentlyContinue | Select-Object -First 1
			if ($p -and $p.MainWindowHandle -ne 0) {
				$sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
				$t = Add-Type -MemberDefinition $sig -Name Fg -Namespace W -PassThru
				$t::SetForegroundWindow($p.MainWindowHandle) | Out-Null
			}
		`);
	} catch {
		/* an app with no main window cannot be fronted; callers proceed */
	}
}

export async function quitApp(processName, { force = false, timeoutMs = 25_000 } = {}) {
	assertWin();
	try {
		ps(
			`Get-Process -Name ${q(processName)} -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`,
		);
	} catch {
		/* fall through to the wait */
	}
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (!appIsRunning(processName)) return true;
		await sleep(400);
	}
	if (force) {
		try {
			ps(`Stop-Process -Name ${q(processName)} -Force -ErrorAction SilentlyContinue`);
		} catch {
			/* already gone */
		}
		await sleep(1500);
	}
	return !appIsRunning(processName);
}

/* --------------------------------------------------------------------- windows ----------- */

export function listWindows(processName) {
	assertWin();
	try {
		const raw = ps(`
			$names = @()
			foreach ($w in (Get-AppWindows ${q(processName)})) { $names += $w.Current.Name }
			$names | ConvertTo-Json -Compress
		`);
		if (!raw) return [];
		const v = JSON.parse(raw);
		return [].concat(v).filter((x) => typeof x === "string");
	} catch {
		return [];
	}
}

export async function waitForWindow(processName, match, { timeoutMs = 60_000, pollMs = 500 } = {}) {
	assertWin();
	const re = match instanceof RegExp ? match : new RegExp(match, "i");
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const hit = listWindows(processName).find((w) => re.test(w));
		if (hit) return hit;
		await sleep(pollMs);
	}
	throw new UiWindowsError(
		`no window in ${processName} matched ${re} within ${timeoutMs}ms. Present: ${JSON.stringify(listWindows(processName))}`,
	);
}

/**
 * Dump every named control in the app. This is the discovery step a maintainer runs once per
 * app version to write or repair a driver — the same role `dumpMenus` plays on macOS.
 */
export function describeApp(processName, { max = 400 } = {}) {
	assertWin();
	return ps(
		`
		$rows = @()
		foreach ($w in (Get-AppWindows ${q(processName)})) {
			foreach ($e in (Find-Descendants $w)) {
				$c = $e.Current
				if ($c.Name -or $c.AutomationId) {
					$rows += [pscustomobject]@{
						type = $c.ControlType.ProgrammaticName -replace 'ControlType\\.', ''
						name = $c.Name
						id   = $c.AutomationId
						enabled = $c.IsEnabled
						off  = $c.IsOffscreen
					}
				}
				if ($rows.Count -ge ${max}) { break }
			}
		}
		$rows | ConvertTo-Json -Compress -Depth 3
	`,
		{ timeoutMs: 120_000 },
	);
}

/* -------------------------------------------------------------------- controls ----------- */

/**
 * Click a control found by its visible name or AutomationId.
 *
 * Invokes through the UIA pattern rather than synthesising a mouse click, so it works on a
 * window that is not frontmost and does not depend on where the window happens to sit.
 */
export function clickControl(processName, needle, { exact = false, controlType = null } = {}) {
	assertWin();
	const typeGuard = controlType
		? `if ($c.ControlType.ProgrammaticName -notmatch ${q(controlType)}) { continue }`
		: "";
	const match = exact
		? `($c.Name -eq ${q(needle)} -or $c.AutomationId -eq ${q(needle)})`
		: `($c.Name -like ${q(`*${needle}*`)} -or $c.AutomationId -like ${q(`*${needle}*`)})`;

	const out = ps(
		`
		$hit = $null
		$seen = @()
		foreach ($w in (Get-AppWindows ${q(processName)})) {
			foreach ($e in (Find-Descendants $w)) {
				$c = $e.Current
				if (-not $c.Name -and -not $c.AutomationId) { continue }
				${typeGuard}
				if ($c.Name) { $seen += $c.Name }
				if ($hit -eq $null -and ${match} -and -not $c.IsOffscreen) { $hit = $e }
			}
		}
		if ($hit -eq $null) {
			@{ ok = $false; seen = @($seen | Select-Object -Unique -First 25) } | ConvertTo-Json -Compress
		} else {
			$p = $null
			if ($hit.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
				$p.Invoke()
			} elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
				$p.Toggle()
			} elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
				$p.Select()
			} else {
				$r = $hit.Current.BoundingRectangle
				[System.Windows.Forms.Cursor]::Position =
					New-Object System.Drawing.Point([int]($r.X + $r.Width/2), [int]($r.Y + $r.Height/2))
				$sig = '[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);'
				$t = Add-Type -MemberDefinition $sig -Name M -Namespace W2 -PassThru
				$t::mouse_event(0x0002,0,0,0,0); $t::mouse_event(0x0004,0,0,0,0)
			}
			@{ ok = $true; matched = $hit.Current.Name } | ConvertTo-Json -Compress
		}
	`,
		{ timeoutMs: 90_000 },
	);
	return JSON.parse(out);
}

/** Read a control's value (ValuePattern), for verifying a field took what was typed. */
export function readControlValue(processName, needle) {
	assertWin();
	const out = ps(`
		$val = $null
		foreach ($w in (Get-AppWindows ${q(processName)})) {
			foreach ($e in (Find-Descendants $w)) {
				$c = $e.Current
				if ($c.Name -like ${q(`*${needle}*`)} -or $c.AutomationId -like ${q(`*${needle}*`)}) {
					$p = $null
					if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
						$val = $p.Current.Value; break
					}
				}
			}
			if ($val -ne $null) { break }
		}
		if ($val -eq $null) { '' } else { $val }
	`);
	return out || null;
}

/** Type into a control found by name, via ValuePattern (no keystroke racing). */
export function setControlValue(processName, needle, value) {
	assertWin();
	const out = ps(`
		$done = $false
		foreach ($w in (Get-AppWindows ${q(processName)})) {
			foreach ($e in (Find-Descendants $w)) {
				$c = $e.Current
				if ($c.Name -like ${q(`*${needle}*`)} -or $c.AutomationId -like ${q(`*${needle}*`)}) {
					$p = $null
					if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
						$p.SetValue(${q(value)}); $done = $true; break
					}
				}
			}
			if ($done) { break }
		}
		[string]$done
	`);
	return out === "True";
}

/* ----------------------------------------------------------------- file dialogs ---------- */

/**
 * Answer a Save/Open dialog with an exact path.
 *
 * Windows' common file dialog accepts a full path in its file-name box and resolves it, so
 * unlike macOS there is no separate "go to folder" step. The path is set through ValuePattern
 * rather than typed, which removes the keystroke race that produced a truncated filename on the
 * macOS side of this benchmark.
 */
export async function fileDialogTo(
	processName,
	absolutePath,
	{ timeoutMs = 30_000, commit = true } = {},
) {
	assertWin();
	const t0 = Date.now();
	let ready = false;
	while (Date.now() - t0 < timeoutMs) {
		const wins = listWindows(processName);
		if (wins.some((w) => /save|open|enregistrer|ouvrir|export/i.test(w))) {
			ready = true;
			break;
		}
		await sleep(400);
	}
	if (!ready) {
		throw new UiWindowsError(
			`no file dialog appeared for ${processName} within ${timeoutMs}ms. Windows present: ${JSON.stringify(listWindows(processName))}`,
		);
	}

	const set = ps(`
		$done = $false
		foreach ($w in (Get-AppWindows ${q(processName)})) {
			foreach ($e in (Find-Descendants $w)) {
				$c = $e.Current
				if ($c.ControlType.ProgrammaticName -match 'Edit' -and
				    ($c.Name -match 'File name|Nom du fichier|Nom' -or $c.AutomationId -eq '1148')) {
					$p = $null
					if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
						$p.SetValue(${q(absolutePath)}); $done = $true; break
					}
				}
			}
			if ($done) { break }
		}
		[string]$done
	`);
	if (set !== "True") {
		throw new UiWindowsError(`could not fill the file-name field of ${processName}'s dialog`);
	}

	if (commit) {
		await sleep(400);
		const r = clickControl(processName, "Save", { controlType: "Button" });
		if (!r.ok) {
			// Localised builds, and dialogs whose default button is "Export" or "Enregistrer".
			for (const label of ["Enregistrer", "Export", "OK", "Open", "Ouvrir"]) {
				if (clickControl(processName, label, { controlType: "Button" }).ok)
					return { path: absolutePath };
			}
			throw new UiWindowsError(
				`filled the path but found no commit button. Present: ${JSON.stringify(r.seen ?? [])}`,
			);
		}
	}
	return { path: absolutePath, file: basename(absolutePath) };
}

/** Send raw keystrokes to the frontmost window. Last resort; prefer named controls. */
export function sendKeys(text) {
	assertWin();
	ps(`[System.Windows.Forms.SendKeys]::SendWait(${q(text)})`);
}
