export interface SelectOption { value: string; label: string; }

export interface SelectProps {
  options: (string | SelectOption)[];
  value: string;
  onChange?: (value: string) => void;
  /** @default true */
  fullWidth?: boolean;
  style?: React.CSSProperties;
}

/** Native <select> styled for OpenScreen (surface-2 fill, 36px tall). */
export function Select(props: SelectProps): JSX.Element;
