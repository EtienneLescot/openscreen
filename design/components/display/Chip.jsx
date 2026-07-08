import React from 'react';

/**
 * OpenScreen Chip — rounded action/filter pill with optional leading
 * icon. Used for the quick-action row above the composer. Hover gives
 * an accent wash + border.
 */
export function Chip({ children, icon = null, onClick, style = {} }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 11px',
        borderRadius: 9999,
        background: hover ? 'var(--accent-wash)' : 'var(--surface-1)',
        border: `1px solid ${hover ? 'var(--accent-border)' : 'var(--border)'}`,
        color: hover ? 'var(--fg)' : 'var(--fg-2)',
        fontFamily: 'var(--font-display)',
        fontSize: 11.5,
        fontWeight: 500,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {icon && <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>{icon}</span>}
      {children}
    </button>
  );
}
