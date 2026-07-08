**TimelinePill** — a marker on a timeline lane. Position it inside a `position:relative` lane track via `leftPct`/`widthPct`.

```jsx
<div style={{position:'relative', height:24}}>
  <TimelinePill tone="speed" leftPct={19} widthPct={5} icon={<ClockIcon/>}>1.5×</TimelinePill>
  <TimelinePill tone="danger" leftPct={10} widthPct={10}>0:37.3</TimelinePill>
  <TimelinePill tone="annotation" leftPct={40} icon={<CommentIcon/>}>New annotation</TimelinePill>
</div>
```

- `accent`=zoom, `annotation`=amber comment, `speed`=orange ramp, `danger`=red skip/cut.
