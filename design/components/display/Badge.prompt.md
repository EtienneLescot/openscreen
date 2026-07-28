**Badge** — status pill. Used for save state, context %, confidence, "Not generated yet". Defaults to a soft emerald mono pill with an optional pulsing-style dot.

```jsx
<Badge dot>Saved</Badge>
<Badge tone="accent" soft={false} dot>High confidence</Badge>
<Badge tone="neutral" mono={false}>Not generated yet</Badge>
```

- `mono` on by default — most badges carry numbers/status codes. Turn off for sentence-case labels.
