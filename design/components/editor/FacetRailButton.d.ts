import React from 'react';

export interface FacetRailButtonProps {
  active?: boolean;
  title?: string;
  onClick?: () => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

/** Icon button in the vertical inspector facet rail. */
export function FacetRailButton(props: FacetRailButtonProps): JSX.Element;
