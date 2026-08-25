# Driving the benchmark remotely

The run takes one to three hours and needs nobody watching it. This is how to start it, check on
it, and pick it up again from a Claude Code session on your phone, in the browser, or dispatched
from another machine.

The design constraint behind all of it: **every prompt that needs a human is provoked up front**,
and everything after that writes its state to disk so a session that disconnects loses nothing.

---

## The one interactive gate

Do this while you are at the keyboard. It is the only part that cannot be remote, because macOS
security prompts must be answered on the machine itself.

```bash
node benchmark/bench.mjs preflight --launch
```

It will:

1. Print the machine's fitness to measure — chip, cores, RAM, OS build, free disk, power source,
   thermal state — and refuse quietly-wrong conditions rather than producing a quietly-wrong number.
2. List every download with its size and licence terms, and wait for you to approve the set.
3. Provoke each app's **"… wants access to control …"** Apple Events prompt one at a time, so you
   answer them all in one sitting instead of being ambushed six times during the run. Nothing here
   clicks *Allow* for you — these are security settings.
4. Open each GUI app once so its first-launch dialogs (onboarding surveys, update nags, usage-data
   consent) can be dismissed while you are there.

When it prints `preflight complete`, the machine is ready and you can leave.

## Starting a run remotely

```bash
node benchmark/bench.mjs install                     # skips anything already present
node benchmark/bench.mjs calibrate                   # once per machine; ~5 min
node benchmark/bench.mjs run --reps 3 --id nightly
```

`run` is safe to launch in the background and disconnect from:

```bash
nohup node benchmark/bench.mjs run --reps 3 --id nightly > /tmp/bench-nightly.log 2>&1 &
```

## Checking on it

```bash
node benchmark/bench.mjs status --json
```

```json
{
  "runId": "nightly",
  "phase": "running",
  "current": { "app": "camtasia", "index": 3, "of": 6 },
  "completed": ["ffmpeg-baseline", "openscreen-cli"],
  "pending": ["kap", "cap"]
}
```

`status.json` is rewritten atomically, so polling it can never read a half-written document.
`results/<runId>/events.ndjson` is append-only and carries one line per app started, finished or
skipped — `tail -f` it for a live view without touching the run.

Partial results are written after **every** app, not at the end. A run that dies at app four
still leaves four apps' worth of `results.json`, and `bench.mjs report --run <id>` will render
what exists.

## Picking up where it stopped

```bash
node benchmark/bench.mjs run --apps camtasia,kap --id nightly   # same id: same output folder
node benchmark/bench.mjs report --run nightly
```

There is no magic resume flag, deliberately: naming the apps you still need is clearer than a
flag that guesses, and re-running one app is cheap.

## Notes for an agent driving this

- **Do not run two benchmarks at once, and do not do anything else heavy on the machine while one
  is running.** The measurement is wall-clock on a shared 8-core SoC; a concurrent build makes
  every number wrong without making any of them look wrong. `preconditionCheck()` catches
  throttling and battery, not a competing process.
- **`run` is long.** Expect ~2 minutes per repetition per app plus 45 s of cooldown between them —
  roughly 25 minutes for six apps at three reps. Poll `status --json` on a slow cadence; do not
  busy-wait.
- **A GUI app can leave a window open** if a run is killed mid-export. `bench.mjs doctor` reports
  what is running; quitting the app by hand is always safe between runs.
- **Never interpret a missing app as a slow app.** Skipped rows carry a `reason`; report it
  verbatim rather than omitting the row.
- **The report is the deliverable, not the terminal output.** `results/<runId>/report.html` is
  self-contained and can be published as an artifact directly.

## What still needs a human, and when

| Moment | Why | Frequency |
|---|---|---|
| Apple Events prompts | macOS security; only the user can grant them | once per app, ever |
| First-launch dialogs | vendor onboarding, consent, update nags | once per app, ever |
| Screen Studio activation | export is licence-gated | once, if you own a licence |
| Nothing else | — | — |

If a prompt does appear mid-run, `lib/permissions.mjs → pendingPermissionDialog()` reads its text,
so a session can report *what* is being asked rather than just noticing that everything stalled.
