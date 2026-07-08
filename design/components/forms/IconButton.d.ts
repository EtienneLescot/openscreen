import React from 'react';

export interface IconButtonProps {
  /** Square size in px. @default 32 */
  size?: number;
  /** Selected / toggled-on state → emerald-soft fill. */
  active?: boolean;
  /** @default "default" */
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Used for both title and aria-label. */
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
  /** The icon (Lucide SVG at 24-viewbox, sized ~55% of the button). */
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

/** Square icon-only button — toolbars, topbar, floating chrome. */
export function IconButton(props: IconButtonProps): JSX.Element;
