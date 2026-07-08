export interface SegmentOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  /** Segments — plain strings or {value,label} objects. */
  options: (string | SegmentOption)[];
  /** Currently selected value. */
  value: string;
  onChange?: (value: string) => void;
  /** @default "md" */
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
}

/** Pill-in-a-trough tab switcher (stage mode, background tabs, source). */
export function SegmentedControl(props: SegmentedControlProps): JSX.Element;
