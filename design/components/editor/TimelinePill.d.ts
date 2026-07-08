import React from 'react';

export interface TimelinePillProps {
  /** Lane accent. @default "accent" */
  tone?: 'accent' | 'annotation' | 'speed' | 'danger';
  icon?: React.ReactNode;
  children?: React.ReactNode;
  /** Left offset as % of the lane. */
  leftPct?: number;
  /** Width as % of the lane; omit for content-sized (tag) mode. */
  widthPct?: number | null;
  style?: React.CSSProperties;
}

/** Labelled marker on a timeline lane (annotation / speed / skip / zoom). */
export function TimelinePill(props: TimelinePillProps): JSX.Element;
