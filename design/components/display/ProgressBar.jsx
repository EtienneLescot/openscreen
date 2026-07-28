import React from 'react';

/**
 * OpenScreen ProgressBar — thin track with an emerald (or gradient)
 * fill. Used for the recipe step progress and generic determinate
 * progress. Height defaults to the 3px recipe bar.
 */
export function ProgressBar({ value = 0, height = 3, gradient = true, style = {} }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div style={{ height, background: 'var(--surface-3)', position: 'relative', borderRadius: height / 2, overflow: 'hidden', ...style }}>
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: `${pct}%`,
        background: gradient ? 'linear-gradient(90deg, var(--brand-lo), var(--brand))' : 'var(--accent)',
      }} />
    </div>
  );
}
