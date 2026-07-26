# 15 — Export dialog (MP4 / GIF)

**Surface:** `ExportDialog` (`src/components/ai-edition/ExportDialog.tsx`), `documentExporter.ts`, exporter pipeline (`mp4ExportSettings.ts`, `videoExporter.ts`, `gifExporter.ts`).
**Prerequisites:** `02-editor-foundation.md`, `03-transport-and-preview.md`, `05-clip-operations.md` (a project with clips + regions).

**Goal of this block:** prove the export pipeline works end-to-end — open the dialog, pick quality / format / fps / codec, run the export, verify the output file exists and has the expected duration.

**Reference:**
- `ExportDialog.tsx` — modal with quality preset, format, fps, codec, output path picker.
- roadmap F2.4 (`58feb34`) — fps (24/30/60) + codec (h264/h265/vp9) selects.
- roadmap F2.5 (pending) — round-trip export test.
- `mp4ExportSettings.ts`:
  - Quality `medium` → short side 720 px → 10 Mbps.
  - Quality `good` → short side 1080 px → 20 Mbps.
  - Quality `source` → match source dims → 30/50/80 Mbps.
- `videoExporter.ts:589` — Codec default `avc1.640033` (H.264 High Profile Level 5.1).

---

## Scenario 15.1 — Open Export dialog

**Setup**
1. Project is open with at least 1 clip.

**Steps**
1. Click the **Export** button (in the titlebar or the File menu).
2. The `ExportDialog` opens.

**Expected**
- The modal is centered.
- It contains:
  - Quality preset selector (`preview-low`, `final-balanced`, `final-high`).
  - Format selector (`MP4`, `GIF`).
  - FPS selector (`24`, `30`, `60`).
  - Codec selector (`h264`, `h265`, `vp9`) — only for MP4.
  - GIF-specific options (`frameRate`, `sizePreset`) — only for GIF.
  - Output path picker.
  - `Export` button.

---

## Scenario 15.2 — Default export (MP4, final-balanced, h264, 30fps)

**Setup**
1. From scenario 15.1 state.

**Steps**
1. Pick the default options: MP4, final-balanced, h264, 30fps.
2. Pick an output path (e.g. `C:\temp\export-test.mp4`).
3. Click `Export`.
4. Wait for completion (the dialog shows progress).

**Expected**
- The progress bar advances (frames encoded → muxer → finalize).
- A success toast or the modal closes.
- The output file exists at the chosen path.
- The file size > 0.
- The file duration (via `ffprobe` or system metadata) matches the project's total duration within ±1 s.

---

## Scenario 15.3 — Export quality preset: preview-low

**Setup**
1. From scenario 15.1 state.

**Steps**
1. Pick `preview-low` quality.
2. Export to a new path.

**Expected**
- The output dimensions are 720 px on the short side.
- The bitrate is ~10 Mbps.
- The file is smaller than the `final-balanced` output.

---

## Scenario 15.4 — Export quality preset: final-high

**Setup**
1. From scenario 15.1 state.

**Steps**
1. Pick `final-high` quality.

**Expected**
- The output dimensions match the source.
- The bitrate is ~30/50/80 Mbps (depending on pixel count).
- The file is the largest of the three presets.

---

## Scenario 15.5 — Export at 60fps

**Setup**
1. From scenario 15.1 state. Pick MP4, final-balanced, h264.

**Steps**
1. Set FPS to `60`.

**Expected**
- The output is encoded at 60 fps.
- The output duration matches the source.

---

## Scenario 15.6 — Export with h265 codec

**Setup**
1. From scenario 15.1 state.

**Steps**
1. Set codec to `h265`.

**Expected**
- The output uses the H.265 / HEVC codec.
- The file size is smaller than the H.264 equivalent at the same quality.

---

## Scenario 15.7 — Export with VP9 codec

**Setup**
1. From scenario 15.1 state.

**Steps**
1. Set codec to `vp9`.

**Expected**
- The output uses VP9.
- The file is playable in modern players.

---

## Scenario 15.8 — Export to GIF

**Setup**
1. From scenario 15.1 state.

**Steps**
1. Set format to `GIF`.
2. Pick `sizePreset` (`small`, `medium`, `large`).
3. Set `frameRate` (`10`, `15`, `24`).
4. Export.

**Expected**
- The output is a GIF.
- The dimensions match the size preset (`small = 480p`, `medium = 720p`, `large = 1080p`).
- The frame rate matches the picker.

---

## Scenario 15.9 — Export honours skip ranges

**Setup**
1. Project has a skip range (1 skip of 2 s in the middle of a 10 s clip).

**Steps**
1. Export the project.
2. Verify the output duration via `ffprobe`.

**Expected**
- The output duration is ~8 s (the skip was applied).

---

## Scenario 15.10 — Export honours speed regions

**Setup**
1. Project has a speed region (2× speed for a 2 s portion).

**Steps**
1. Export the project.

**Expected**
- The output duration is shorter than the source (the 2× region plays in 1 s of output).

---

## Scenario 15.11 — Export honours crop region

**Setup**
1. Project has a crop region (non-default).

**Steps**
1. Export the project.

**Expected**
- The output dimensions match the crop (not the source's full dimensions).

---

## Scenario 15.12 — Export honours aspect ratio

**Setup**
1. Project has `aspectRatio = "1:1"`.

**Steps**
1. Export the project.

**Expected**
- The output has 1:1 aspect.

---

## Scenario 15.13 — Export with annotations

**Setup**
1. Project has 2+ annotation regions.

**Steps**
1. Export the project.

**Expected**
- The output video contains the annotations baked in at the right times.

---

## Scenario 15.14 — Export with zoom regions

**Setup**
1. Project has 2+ zoom regions.

**Steps**
1. Export the project.

**Expected**
- The output video contains the zoomed frames baked in at the right times.

---

## Scenario 15.15 — Export progress visible

**Setup**
1. Export a long project.

**Steps**
1. Watch the progress bar / percentage.

**Expected**
- The progress advances smoothly (not stuck).
- The encoder queue does not stall.

---

## Scenario 15.16 — Cancel export

**Setup**
1. Export is in progress.

**Steps**
1. Click `Cancel` in the dialog.

**Expected**
- The export stops.
- The partial file is deleted.
- The dialog closes.

---

## Scenario 15.17 — Output file path validation

**Setup**
1. From scenario 15.1 state.

**Steps**
1. Pick a path with no write permission (e.g. `C:\Windows\System32\export.mp4`).
2. Click `Export`.

**Expected**
- The dialog shows an error message: `Cannot write to <path>`.
- No file is created.

---

## Scenario 15.18 — Reveal in folder

**Setup**
1. Export is complete.

**Steps**
1. The dialog has a `Reveal in Folder` button (or a system notification with the link).
2. Click it.

**Expected**
- The OS file explorer opens at the export's directory, with the file selected.

---

## Scenario 15.19 — Export audio

**Setup**
1. Project has audio.

**Steps**
1. Export the project.

**Expected**
- The output has audio.
- Audio is AAC (or Opus as fallback) — verify with `ffprobe`.

---

## Scenario 15.20 — Export with webcam overlay

**Setup**
1. Project has both screen and webcam files.

**Steps**
1. Export the project.

**Expected**
- The output video includes the webcam PIP at the configured position / size / shape.

---

## Cross-cutting checks for this block

- The Export dialog remembers the last-used settings (quality / format / fps / codec) across runs.
- The dialog handles large exports without OOM (the encoder is throttled via `maxEncodeQueue = 120`).

**Next:** proceed to [`16-modal-shortcuts-i18n.md`](16-modal-shortcuts-i18n.md).