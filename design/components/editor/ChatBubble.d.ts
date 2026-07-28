import React from 'react';

export interface ChatBubbleProps {
  /** @default "assistant" */
  role?: 'assistant' | 'user' | 'system';
  author?: string;
  time?: string;
  /** Avatar glyph for assistant role. */
  avatar?: React.ReactNode;
  children?: React.ReactNode;
}

/** One row in the agent conversation (assistant / user / system). */
export function ChatBubble(props: ChatBubbleProps): JSX.Element;
