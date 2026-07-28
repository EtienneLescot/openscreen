import React from 'react';

export interface ChipProps {
  children?: React.ReactNode;
  /** Leading icon (rendered in accent). */
  icon?: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}

/** Rounded quick-action / filter pill with hover wash. */
export function Chip(props: ChipProps): JSX.Element;
