import React from 'react';

export interface CardProps {
  children?: React.ReactNode;
  /** Optional bordered header title. */
  title?: React.ReactNode;
  /** Node pinned to the right of the header. */
  headerRight?: React.ReactNode;
  /** Resting card vs floating popover shadow. @default "card" */
  elevation?: 'card' | 'pop';
  /** Fill surface level 0–2. @default 1 */
  level?: 0 | 1 | 2;
  radius?: number;
  padding?: number;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
}

/** Flat bordered surface container. */
export function Card(props: CardProps): JSX.Element;
