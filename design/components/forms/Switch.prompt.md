**Switch** — boolean toggle. Lives at the right edge of an inspector setting row (label on the left).

```jsx
<div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
  <span>Blur background</span>
  <Switch checked={blur} onChange={setBlur} />
</div>
```

- Track fills `--accent` when on, `--surface-3` when off; white knob slides.
- For a choice that changes what's on screen but isn't on/off, use SegmentedControl instead.
