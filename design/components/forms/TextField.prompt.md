**TextField** — text entry. One primitive covers the search input (single-line, radius 10, with a leading search icon) and the chat composer (multiline, radius 14). The composer typically has a toolbar row below it (model pill + send) — compose that around the TextField.

```jsx
<TextField leadingIcon={<SearchIcon/>} placeholder="Search media…" value={q} onChange={setQ} />
<TextField multiline placeholder="Describe the edit you want…" value={msg} onChange={setMsg} />
```

- Wrapper carries the border + `--surface-1` fill; the control itself is borderless/transparent.
