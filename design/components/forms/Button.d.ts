import React from 'react';

export interface ButtonProps {
  /** Visual weight. @default "primary" */
  variant?: 'primary' | 'secondary' | 'ghost';
  /** @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Leading icon node (Lucide SVG). */
  icon?: React.ReactNode;
  /** Trailing icon node (e.g. chevron). */
  iconRight?: React.ReactNode;
  disabled?: boolean;
  fullWidth?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

/**
 * The primary text-action button.
 *
 * @startingPoint section="Forms" subtitle="Primary / secondary / ghost text button" viewport="700x120"
 */
export function Button(props: ButtonProps): JSX.Element;
