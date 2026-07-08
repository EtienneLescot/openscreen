export interface ProposalItem {
  /** Time range, e.g. "0:31.0 – 0:37.3". */
  range: string;
  /** Removed duration, e.g. "6.3s". */
  dur: string;
}

export interface ProposalCardProps {
  title?: string;
  /** Total removed, shown as −{total} in the header. */
  total?: string;
  /** @default "High confidence" */
  confidence?: string;
  items: ProposalItem[];
  rationale?: string;
  /** Primary button label. @default "Apply" */
  applyLabel?: string;
  onApply?: () => void;
  onReview?: () => void;
}

/** The agent's proposed-cuts card (header + range rows + actions + rationale). */
export function ProposalCard(props: ProposalCardProps): JSX.Element;
