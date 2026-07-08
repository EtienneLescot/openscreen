export interface SliderProps {
  /** Label shown top-left of the card. */
  label?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Formats the mono value shown top-right, e.g. v => `${v}%`. */
  format?: (v: number) => string | number;
  onChange?: (v: number) => void;
  /** Wrap in the bordered setting card. @default true */
  card?: boolean;
  style?: React.CSSProperties;
}

/** Labelled range slider inside an inspector setting card. */
export function Slider(props: SliderProps): JSX.Element;
