**Button** — the primary text action. Use `primary` for the one main action in a view (Export, Apply cuts, Send), `secondary` for adjacent choices (Review each), `ghost` for low-emphasis toolbar/topbar actions.

```jsx
<Button variant="primary" icon={<ExportIcon/>}>Export</Button>
<Button variant="secondary">Review each</Button>
<Button variant="ghost" size="sm">demo2</Button>
```

- Primary is emerald with a soft accent glow; darkens to `--brand-lo` on hover.
- Keep labels short imperative verbs. No emoji.
- Icon-only actions → use `IconButton` instead.
