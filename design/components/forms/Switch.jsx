import React from 'react';

/**
 * OpenScreen Switch — the pill toggle used in inspector setting rows
 * (Blur background, Mirror webcam, Shrink on zoom, Show cursor…).
 * Track fills emerald when on; knob slides right.
 */
export function Switch({ checked = false, onChange, disabled = false, style = {} }) {
  const W = 38, H = 22, KNOB = 16, PAD = 3;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange && onChange(!checked)}
      style={{
        position: 'relative',
        width: W,
        height: H,
        flexShrink: 0,
        border: 0,
        borderRadius: 9999,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        background: checked ? 'var(--accent)' : 'var(--surface-3)',
        transition: 'background .18s var(--ease)',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: PAD,
          left: checked ? W - KNOB - PAD : PAD,
          width: KNOB,
          height: KNOB,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
          transition: 'left .18s var(--ease)',
        }}
      />
    </button>
  );
}
