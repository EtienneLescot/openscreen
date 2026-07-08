import React from 'react';

/**
 * OpenScreen SegmentedControl — the pill-in-a-trough tab switcher.
 * Used for Media/Edit/Rec stage modes, Image/Color/Gradient background
 * tabs, Screen/Window source, etc. The active segment gets a raised
 * surface chip; inactive segments are muted text.
 */
export function SegmentedControl({
  options = [],
  value,
  onChange,
  size = 'md',
  style = {},
}) {
  const s = size === 'sm'
    ? { pad: '6px 8px', fs: 11.5, trough: 2, radius: 8, inner: 6 }
    : { pad: '7px 14px', fs: 12.5, trough: 3, radius: 11, inner: 8 };

  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: s.trough,
        background: 'var(--surface-1)',
        border: '1px solid var(--border)',
        borderRadius: s.radius,
        ...style,
      }}
    >
      {options.map((opt) => {
        const val = typeof opt === 'string' ? opt : opt.value;
        const label = typeof opt === 'string' ? opt : opt.label;
        const active = val === value;
        return (
          <button
            key={val}
            role="tab"
            aria-selected={active}
            onClick={() => onChange && onChange(val)}
            style={{
              padding: s.pad,
              border: 0,
              borderRadius: s.inner,
              cursor: 'pointer',
              fontFamily: 'var(--font-display)',
              fontSize: s.fs,
              fontWeight: 600,
              lineHeight: 1,
              background: active ? 'var(--surface-hi)' : 'transparent',
              color: active ? 'var(--fg-emphasis)' : 'var(--muted)',
              boxShadow: active ? 'var(--elev-card)' : 'none',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
