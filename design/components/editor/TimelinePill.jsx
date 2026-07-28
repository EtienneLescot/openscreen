import React from 'react';

/**
 * OpenScreen TimelinePill — a labelled marker on a timeline lane.
 * tone maps to the four lane accents. `fixedWidth` (tag mode) sizes to
 * content; otherwise it spans a range via left/width percentages.
 */
export function TimelinePill({
  tone = 'accent',
  icon = null,
  children,
  leftPct = 0,
  widthPct = null,
  style = {},
}) {
  const map = {
    accent: { c: 'var(--accent)', w: 'var(--accent-soft)' },
    annotation: { c: 'var(--annotation)', w: 'var(--annotation-wash)' },
    speed: { c: 'var(--speed)', w: 'var(--speed-wash)' },
    danger: { c: 'var(--danger)', w: 'var(--danger-soft)' },
  };
  const t = map[tone] || map.accent;
  return (
    <span
      style={{
        position: 'absolute',
        top: 1,
        left: `${leftPct}%`,
        width: widthPct == null ? 'max-content' : `${widthPct}%`,
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '0 9px 0 7px',
        borderRadius: 6,
        border: `1.5px solid ${t.c}`,
        background: t.w,
        color: tone === 'danger' ? 'var(--danger)' : 'var(--fg)',
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {icon}
      {children}
    </span>
  );
}
