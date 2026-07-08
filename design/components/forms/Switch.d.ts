export interface SwitchProps {
  checked?: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}

/** Pill toggle for boolean inspector settings. Emerald when on. */
export function Switch(props: SwitchProps): JSX.Element;
