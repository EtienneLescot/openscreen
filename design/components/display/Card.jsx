import React from 'react';

/**
 * OpenScreen Card — the flat bordered surface container. `elevation`
 * "card" (resting) or "pop" (floating). `level` picks the fill surface.
 * Optional `title` renders a bordered header.
 */
export function Card({
  children,
  title = null,
  headerRight = null,
  elevation = 'card',
  level = 1,
  radius = 14,
  padding = 14,
  style = {},
  bodyStyle = {},
}) {
  const fills = { 0: 'var(--surface)', 1: 'var(--surface-1)', 2: 'var(--surface-2)' };
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: radius,
        background: fills[level] || fills[1],
        boxShadow: elevation === 'pop' ? 'var(--elev-pop)' : 'var(--elev-card)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {title && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '11px 13px 10px',
          borderBottom: '1px solid var(--border-soft)',
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>{title}</span>
          {headerRight && <span style={{ marginLeft: 'auto' }}>{headerRight}</span>}
        </div>
      )}
      <div style={{ padding, ...bodyStyle }}>{children}</div>
    </div>
  );
}
