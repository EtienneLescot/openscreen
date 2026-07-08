**MediaCard** — a clip in the media-library grid. Gradient thumbnail (stands in for a real frame), film-strip glyph, drag handle, mono duration/size footer.

```jsx
<MediaCard name="demo-n8n-as-code-1.mp4" duration="0:02:34.7" size="110 MB"
  from="#10b981" to="#0d986a" selected onClick={select} onDragStart={…} />
```

- Selected state = 1.5px emerald border + a dot before the name. Cards are draggable onto the timeline.
