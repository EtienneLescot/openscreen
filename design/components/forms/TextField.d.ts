import React from 'react';

export interface TextFieldProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  /** Render an auto-height textarea instead of an input. */
  multiline?: boolean;
  /** Icon node rendered inside the field (e.g. a search glyph). */
  leadingIcon?: React.ReactNode;
  /** Rows when multiline. @default 2 */
  rows?: number;
  /** Style for the control element. */
  style?: React.CSSProperties;
  /** Style for the bordered wrapper. */
  wrapStyle?: React.CSSProperties;
}

/** Text input / composer — single primitive for both single- and multi-line. */
export function TextField(props: TextFieldProps): JSX.Element;
