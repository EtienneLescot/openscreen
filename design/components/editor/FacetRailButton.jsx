import React from 'react';

/**
 * OpenScreen FacetRailButton — an icon button in the vertical facet
 * rail beside the inspector. Active facet gets the emerald-soft fill.
 */
export function FacetRailButton({ active = false, title, onClick, children, style = {} }) {
  const [hover, setHover] = React.useState(false);
  let color = active ? 'var(--accent)' : 'var(--muted)';
  let background = active ? 'var(--accent-soft)' : 'transparent';
  if (!active && hover) { color = 'var(--fg)'; background = 'var(--surface-3)'; }
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', border: 0, borderRadius: 11, background, color, cursor: 'pointer', ...style }}
    >
      {children}
    </button>
  );
}
