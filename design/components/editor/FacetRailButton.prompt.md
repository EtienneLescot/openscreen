**FacetRailButton** — one icon in the vertical rail that switches the floating inspector's facet (Background, Effects, Layout, Cursor, Captions, Chapters, Transcript, Crop).

```jsx
<FacetRailButton title="Background" active={facet==='bg'} onClick={()=>setFacet('bg')}><ImageIcon/></FacetRailButton>
```

- 40×40, radius 11. Active facet = emerald-soft fill; hover steps to `--surface-3`.
