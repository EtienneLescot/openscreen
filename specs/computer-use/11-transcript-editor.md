# 11 — Transcript editor + auto-captions

**Surface:** `TranscriptEditor` (`src/components/ai-edition/TranscriptEditor.tsx`), `Modals.tsx` (`AutoCaptionsModal`), `captioning` library (`src/lib/captioning/*`).
**Prerequisites:** `01-source-selection-and-record.md` (a recording exists with audio), `02-editor-foundation.md` (editor is open with the recording loaded).

**Goal of this block:** prove the in-browser Whisper transcription works end-to-end: open the Auto-Captions modal, pick a model, run, view the result in the transcript editor, click words to seek, delete words to add skips, regenerate in another language.

**Reference:**
- design `openscreen-editor.html` — `.transcript-list`, `.transcript-row`, `.transcript-row.skip`, `.filler`, `.skip-mark`.
- `src/lib/captioning/transcribe.ts` — `transcribeMono16kToSegments(samples, options)`.
- `src/lib/captioning/transcribeCore.ts` — orchestration, retries, slicing.
- roadmap P1.5 / P2.4 — transcription pipeline (Phase 4).
- `Model: Xenova/whisper-tiny` (default), bundled under `caption-assets/`.

---

## Scenario 11.1 — Open the Auto-Captions modal

**Setup**
1. Project is open with a clip that has audio.

**Steps**
1. Click the **Captions** button in the bottombar (icon: `Captions` / `MessageSquare`).
2. The `AutoCaptionsModal` opens.

**Expected**
- The modal is centered.
- The title is `Auto-captions` (or localized equivalent).
- The modal contains:
  - A model picker (tiny / base / small / medium — Whisper models).
  - A language selector (auto / en / fr / de / es / it / pt / nl / ja / ko / zh).
  - A `Generate` button.

---

## Scenario 11.2 — Generate captions with the tiny model

**Setup**
1. From scenario 11.1 state.

**Steps**
1. Pick the `tiny` model (default).
2. Language: `auto`.
3. Click `Generate`.
4. Wait up to 60 s (the in-browser Whisper runs on CPU; can be slow on first run).

**Expected**
- A progress indicator appears (model loading, then transcribing).
- The modal shows the model's download progress on first run (`caption-assets/` is fetched from the bundled dir on subsequent runs).
- When complete, the modal closes (or shows a `Done` button).
- The transcript editor on the right side now shows the transcript words.
- The transcript is segmented into lines (`minWords=2, maxWords=7`).

---

## Scenario 11.3 — Transcript editor shows words

**Setup**
1. From scenario 11.2 state.

**Steps**
1. Take a screenshot of the transcript editor.

**Expected**
- Each word is a span with `data-word-id` and class `kept | cut`.
- Words are colored normally (kept) or red (in a skip).
- A "current cue" highlight tracks the playhead.

---

## Scenario 11.4 — Click a word → preview seeks

**Setup**
1. From scenario 11.3 state.

**Steps**
1. Click any word in the transcript.

**Expected**
- The preview seeks to that word's `startSec`.
- The playhead jumps to the corresponding position.
- The cue highlight moves to the clicked word.
- If the word is off-screen, the transcript auto-scrolls to keep it in view (with 56 px margin top/bottom).

---

## Scenario 11.5 — Caret navigation with arrow keys

**Setup**
1. From scenario 11.4 state. Click into the transcript to set focus.

**Steps**
1. Press `Right Arrow`. The caret moves to the next word.
2. The preview seeks to the new caret's interpolated time.
3. Press `Left Arrow`. Reverts.

**Expected**
- The caret (a thin vertical line) moves between words.
- The preview follows.

---

## Scenario 11.6 — Select range of words with mouse

**Setup**
1. From scenario 11.5 state.

**Steps**
1. Click the first word. Shift-click a later word.
2. The range is highlighted.

**Expected**
- The range is visually marked (different background).
- The status bar or the transcript header shows `2 words selected` (or similar).

---

## Scenario 11.7 — Backspace / Delete adds a skip

**Setup**
1. From scenario 11.6 state.

**Steps**
1. Press `Backspace` or `Delete`.

**Expected**
- The selected words are added to a skip range.
- The transcript words turn red (`cut` class).
- `data-skip-count` increments.
- The skip pill appears in the timeline.
- The preview at the skip range is no longer rendered during playback.

---

## Scenario 11.8 — Backspace at collapsed caret deletes adjacent word

**Setup**
1. Place the caret next to a kept word (no selection).

**Steps**
1. Press `Backspace` (the word before the caret is deleted).

**Expected**
- A one-word skip is added.
- The preview scrubs to the word's start.

---

## Scenario 11.9 — Trash button on a cut run

**Setup**
1. From scenario 11.7 state. A cut run (group of skipped words) exists.

**Steps**
1. Hover the cut run.
2. A trash button appears.
3. Click the trash button.

**Expected**
- The skip range is removed.
- The cut words turn back to `kept` color.

---

## Scenario 11.10 — Filler words highlighted

**Setup**
1. The transcript has filler words (`uh`, `um`, etc. — the filler lexicon in `structured-agent.ts:11-21`).

**Steps**
1. Look at the transcript.

**Expected**
- Filler words have a yellow / amber background and italic style.
- They are visually distinct from regular kept words.

---

## Scenario 11.11 — Silence gaps marked

**Setup**
1. The transcript has silence gaps between segments.

**Steps**
1. Look at the transcript.

**Expected**
- Silence is marked as `(0.5s)` (or similar) between segments.
- The `silence` class is applied.

---

## Scenario 11.12 — Regenerate transcript in another language

**Setup**
1. The project's audio is in English (or any language with words in it).

**Steps**
1. Re-open the Auto-Captions modal.
2. Pick language `fr` (or any non-English).
3. Click `Generate`.

**Expected**
- A new transcription replaces the previous one.
- The transcript words are in the chosen language (or `auto` if the model detects English).
- The skips added previously remain (they are project state, not transcript state).

---

## Scenario 11.13 — Transcript editor content is editable (delete-only)

**Setup**
1. From scenario 11.12 state.

**Steps**
1. Try to type text into the transcript.
2. Try to paste text.

**Expected**
- Typing is blocked (`contentEditable` with delete-only logic).
- Pasting is blocked.
- The only allowed mutation is deletion.

---

## Scenario 11.14 — Transcript auto-caption → annotation injection (legacy)

**Setup**
1. The transcript has words.

**Steps**
1. Look at the annotation lane.

**Expected**
- Auto-caption annotations are NOT auto-injected (per roadmap "Auto-caption→annotation injection — dropped; transcript editor is the SSOT").
- The annotation lane is empty unless the user explicitly added annotations.

---

## Scenario 11.15 — Transcript edits add multiple skips

**Setup**
1. The transcript has many words.

**Steps**
1. Select and delete 3 different ranges.

**Expected**
- `data-skip-count` is now `3`.
- All 3 skips are rendered in the timeline.
- The preview at each skip cuts out the corresponding range.

---

## Scenario 11.16 — Skip pill from transcript matches timeline skip

**Setup**
1. A skip was added via transcript deletion.

**Steps**
1. Find the corresponding skip pill in the timeline's skip lane.

**Expected**
- The pill's `startMs` / `endMs` match the deleted word range.
- Resizing the timeline pill updates the transcript's `cut` state.
- Deleting the timeline pill updates the transcript.

---

## Scenario 11.17 — Long audio is sliced automatically

**Setup**
1. Project has a 30-minute clip with continuous audio.

**Steps**
1. Run auto-captions with the `tiny` model.
2. Wait for completion.

**Expected**
- The transcribe pipeline slices the audio into 12-minute chunks (`TRANSCRIBE_SLICE_SAMPLES = 12 * 60 * 16_000`).
- Each slice is transcribed in sequence.
- The final transcript contains all the words from the full clip.

---

## Scenario 11.18 — Undo a transcript deletion

**Setup**
1. A skip was added via transcript deletion.

**Steps**
1. Press `Ctrl+Z`.

**Expected**
- The skip is removed.
- The transcript words return to `kept` color.

---

## Scenario 11.19 — Transcript words reflect the source language

**Setup**
1. Source audio is in French. Run auto-captions with `auto`.

**Expected**
- The transcript is in French (or the detected language).
- The auto-caption annotations (if used) are also in French.

---

## Scenario 11.20 — Open the transcript editor as a right pane

**Setup**
1. Project is open with a transcript.

**Steps**
1. The transcript editor is rendered in the right side of the bottombar (or in the transcript rail — implementation-specific).

**Expected**
- The transcript is visible.
- It can be collapsed / expanded via a toggle.

---

## Cross-cutting checks for this block

- The transcript editor survives clip operations (delete, reorder).
- The cue highlight tracks the playhead in real time during playback.
- The auto-captions modal is cancelable.

**Next:** proceed to [`12-chat-panel.md`](12-chat-panel.md).