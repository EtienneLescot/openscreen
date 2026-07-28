**ChatBubble** — one message in the OpenScreen Agent panel.

```jsx
<ChatBubble role="user" author="YOU">Clean up the intro please.</ChatBubble>
<ChatBubble role="assistant" author="OpenScreen" time="10:41" avatar={<BotGlyph/>}>On it — scanning track 1…</ChatBubble>
<ChatBubble role="system">Applied 3 cuts</ChatBubble>
```

- Assistant bubbles have a distinctive asymmetric radius (`5px 15px 15px 15px`) + avatar; user bubbles mirror it in emerald-soft.
- For an attached proposal, render a `ProposalCard` as the bubble's child or directly after it.
