**ProposalCard** — the distinctive agent output: a reviewable set of proposed edits attached to an assistant message.

```jsx
<ProposalCard
  total="0:44.1"
  confidence="High confidence"
  applyLabel="Apply 3 cuts"
  items={[{range:'0:31.0 – 0:37.3', dur:'6.3s'}, …]}
  rationale="Detected silences over 600ms and 4 filler words."
  onApply={apply} onReview={review}
/>
```

- Time ranges + durations are always Geist Mono. Each row has a striped emerald clip chip.
- Render it as a child of, or immediately after, an assistant `ChatBubble`.
