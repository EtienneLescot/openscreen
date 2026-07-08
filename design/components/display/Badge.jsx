import React from 'react';

/**
 * OpenScreen Badge — the small status pill. Optional leading dot.
 * tones: accent (default) · neutral · danger · warn. `soft` uses the
 * tinted fill (default); pass soft={false} for a bordered outline.
 */
export function Badge({
  children,
  tone = 'accent',
  dot = false,
  soft = true,
  mono = true,
  style = {},
}) {
  const map = {
    accent: { fg: 'var(--accent)', bg: 'var(--accent-soft)', bd: 'var(--accent-border)', dot: 'var(--accent)' },
    neutral: { fg: 'var(--muted)', bg: 'var(--surface-2)', bd: 'var(--border)', dot: 'var(--muted)' },
    danger: { fg: 'var(--danger)', bg: 'var(--danger-soft)', bd: 'var(--danger)', dot: 'var(--danger)' },
    warn: { fg: 'var(--annotation)', bg: 'var(--annotation-wash)', bd: 'var(--annotation)', dot: 'var(--annotation)' },
  };
  const c = map[tone] || map.accent;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: dot ? '3px 9px 3px 7px' : '3px 9px',
        borderRadius: 9999,
        background: soft ? c.bg : 'transparent',
        border: soft ? 'none' : `1px solid ${c.bd}`,
        color: c.fg,
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-display)',
        fontSize: mono ? 9.5 : 11.5,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {dot && <span style={{ width: 4, height: 4, borderRadius: '50%', background: c.dot }} />}
      {children}
    </span>
  );
}
