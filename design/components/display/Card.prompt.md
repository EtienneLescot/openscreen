**Card** — the generic bordered container behind setting rows, popovers, and panels. Use `elevation="pop"` for anything that floats over the stage (inspector, menus), `card` for resting content.

```jsx
<Card title="Proposed cuts" headerRight={<Badge dot>High</Badge>}>…</Card>
<Card elevation="pop" level={1} radius={16} padding={0}>…</Card>
```

- `level` maps to `--surface` / `--surface-1` / `--surface-2`. Nested containers should round less than their parent.
