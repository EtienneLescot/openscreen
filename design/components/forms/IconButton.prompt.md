**IconButton** — icon-only square button, ghost by default. The most-used control in the editor chrome (topbar, timeline toolbar, panel close, transport).

```jsx
<IconButton title="Settings"><SettingsIcon/></IconButton>
<IconButton title="Loop" active={loopOn} onClick={toggleLoop}><LoopIcon/></IconButton>
<IconButton title="Delete clip" tone="danger"><TrashIcon/></IconButton>
```

- Rests at `--muted`, hovers to `--fg` on `--surface-2`.
- `active` = emerald-soft fill for toggled tools.
- Sizes: 26–28px inside dense toolbars (radius 6), 30–34px in the topbar/transport (radius 9). Always pass a `title`.
