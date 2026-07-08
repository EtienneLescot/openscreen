**Slider** — labelled range control. By default renders the full inspector card (label + mono emerald value + filled track). The track uses the global range-slider chrome from `base.css`.

```jsx
<Slider label="Shadow" value={shadow} onChange={setShadow} format={v => `${v}%`} />
<Slider label="Zoom" value={zoom} min={0} max={100} format={v => `${(1+v/50).toFixed(1)}×`} />
```

- Value read-out is always Geist Mono in `--accent`.
- Pass `card={false}` for a bare track (e.g. embedded elsewhere).
