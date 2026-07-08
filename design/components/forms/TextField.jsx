import React from 'react';

/**
 * OpenScreen TextField — one primitive for both single-line inputs and
 * the multiline composer (same border/fill/radius vocabulary).
 * `multiline` swaps <input> for an auto-height <textarea>.
 * `leadingIcon` renders a search/glyph inside a bordered wrapper.
 */
export function TextField({
  value,
  onChange,
  placeholder,
  multiline = false,
  leadingIcon = null,
  rows = 2,
  style = {},
  wrapStyle = {},
  ...rest
}) {
  const shared = {
    width: '100%',
    minWidth: 0,
    border: 0,
    background: 'transparent',
    fontFamily: 'var(--font-display)',
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--fg)',
    outline: 'none',
    resize: 'none',
  };

  const control = multiline ? (
    <textarea
      value={value}
      onChange={(e) => onChange && onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{ ...shared, minHeight: 28, ...style }}
      {...rest}
    />
  ) : (
    <input
      value={value}
      onChange={(e) => onChange && onChange(e.target.value)}
      placeholder={placeholder}
      style={{ ...shared, ...style }}
      {...rest}
    />
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: multiline ? 'flex-start' : 'center',
        gap: 10,
        padding: multiline ? '9px 11px' : '10px 14px',
        border: '1px solid var(--border)',
        borderRadius: multiline ? 14 : 10,
        background: 'var(--surface-1)',
        ...wrapStyle,
      }}
    >
      {leadingIcon}
      {control}
    </div>
  );
}
