# Driver contract

A driver teaches the harness how one app performs the benchmark scenario. It is the only
app-specific code; timing, verification and reporting are shared so no app is measured on a
kinder stopwatch than another.

```js
export default {
  id: "screen-studio",          // stable slug, used in results and on the CLI
  displayName: "Screen Studio",
  vendor: "Screen Studio",
  kind: "gui",                  // "cli" | "gui" | "reference"
  automation: "menu",           // "cli" | "menu" | "menu+coords" | "none"
  processName: "Screen Studio", // as System Events sees it
  appPath: "/Applications/Screen Studio.app",
  bundleId: "studio.screen.app",
  install: { method: "dmg", url, appName, approxMB, licence, notes },

  detect(),                     // -> { installed, version, path }
  async prepare(ctx),           // import the source, apply the scenario, park in the editor
                                //    -> { appliedFeatures: string[], notes: string[] }
  outputPath(ctx),              // where the export will land
  async runExport(ctx),         // MUST call ctx.commit() at the instant export is committed
  async cleanup(ctx),           // quit, remove temp state
};
```

## The two rules that keep the comparison fair

**`ctx.commit()` marks the same moment for every app.** It is called immediately after the
action that starts the render — the click on *Export*, or the CLI's first `started` event —
never before the project is loaded and never after the first frame. Anything a driver does
before `commit()` (launching the app, importing the clip, setting presets) is warm-up and is
reported separately; anything after it counts.

**Completion is decided by the filesystem, not by the app.** The harness watches the output
path until it stops growing (`waitForStableFile`), so an app that shows 100% before it has
finished muxing gets no credit for it. A driver's `runExport` may return as soon as the export
is committed; it does not have to detect the end itself.

## The automation ladder

GUI drivers should reach for the highest rung that works, and record which one they used —
`automation` in the results is what tells a reader how reproducible a given row is.

| Rung | Mechanism | Reproducible across machines? |
|---|---|---|
| 1 | AppleScript dictionary (`sdef`) | yes — none of these apps has one |
| 2 | System Events menu item by name | yes, until the app renames the item |
| 3 | Documented keyboard shortcut | yes |
| 4 | Accessibility control by name/description | mostly — names drift between versions |
| 5 | Pixel coordinates | no — flagged as reduced reproducibility |

`node bench.mjs discover <app>` dumps the menus and the accessibility tree of an installed app,
which is how a driver gets written or repaired when a new version moves something.
