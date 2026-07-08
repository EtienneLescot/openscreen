export interface ProgressBarProps {
  /** 0–100. */
  value: number;
  /** Track height in px. @default 3 */
  height?: number;
  /** Emerald gradient fill vs flat accent. @default true */
  gradient?: boolean;
  style?: React.CSSProperties;
}

/** Thin determinate progress track (recipe steps, generic progress). */
export function ProgressBar(props: ProgressBarProps): JSX.Element;
