**SegmentedControl** — mutually-exclusive tab switcher in a recessed trough. Use for 2–4 short peer choices that swap the view (stage Media/Edit/Rec, background Image/Color/Gradient, source Screen/Window).

```jsx
<SegmentedControl options={['Media','Edit','Rec']} value={mode} onChange={setMode} />
<SegmentedControl size="sm" options={['Screen','Window']} value={src} onChange={setSrc} />
```

- Active segment = raised `--surface-hi` chip with `--elev-card`; inactive = `--muted` text.
- `md` for topbar-scale switches, `sm` for inside panels/menus.
