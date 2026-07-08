export interface BadgeProps {
  children?: React.ReactNode;
  /** @default "accent" */
  tone?: 'accent' | 'neutral' | 'danger' | 'warn';
  /** Show a leading status dot. */
  dot?: boolean;
  /** Tinted fill (true) vs bordered outline (false). @default true */
  soft?: boolean;
  /** Geist Mono (true) vs Geist (false). @default true */
  mono?: boolean;
  style?: React.CSSProperties;
}

/** Small status pill — "Saved", "0% context", "High confidence". */
export function Badge(props: BadgeProps): JSX.Element;
