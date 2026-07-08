import React from 'react';

/**
 * OpenScreen Select — native dropdown styled to match. Used for
 * caption style, layout preset, transcript language, etc.
 */
export function Select({
  options = [],
  value,
  onChange,
  fullWidth = true,
  style = {},
  ...rest
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange && onChange(e.target.value)}
      style={{
        width: fullWidth ? '100%' : undefined,
        height: 36,
        padding: '0 11px',
        borderRadius: 10,
        border: '1px solid var(--border)',
        background: 'var(--surface-2)',
        color: 'var(--fg-2)',
        fontFamily: 'var(--font-display)',
        fontSize: 12.5,
        fontWeight: 500,
        outline: 'none',
        cursor: 'pointer',
        ...style,
      }}
      {...rest}
    >
      {options.map((opt) => {
        const val = typeof opt === 'string' ? opt : opt.value;
        const label = typeof opt === 'string' ? opt : opt.label;
        return <option key={val} value={val}>{label}</option>;
      })}
    </select>
  );
}
