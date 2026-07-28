import React from 'react';

/**
 * OpenScreen Button — the primary text action.
 * variants: primary (emerald fill) · secondary (surface + border) · ghost (transparent).
 * Icons are passed as children alongside a label, or use IconButton for icon-only.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  icon = null,
  iconRight = null,
  disabled = false,
  fullWidth = false,
  onClick,
  children,
  style = {},
  ...rest
}) {
  const sizes = {
    sm: { h: 28, px: 10, fs: 12, gap: 6, radius: 8 },
    md: { h: 32, px: 14, fs: 13, gap: 7, radius: 9 },
    lg: { h: 40, px: 18, fs: 14, gap: 9, radius: 12 },
  };
  const s = sizes[size] || sizes.md;

  const variants = {
    primary: {
      background: 'var(--accent)',
      color: '#fff',
      border: '1px solid var(--accent)',
      boxShadow: '0 2px 10px -3px var(--accent-soft)',
    },
    secondary: {
      background: 'var(--surface-1)',
      color: 'var(--fg-2)',
      border: '1px solid var(--border)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--fg-2)',
      border: '1px solid transparent',
    },
  };
  const v = variants[variant] || variants.primary;

  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s.gap,
    height: s.h,
    padding: `0 ${s.px}px`,
    borderRadius: s.radius,
    fontFamily: 'var(--font-display)',
    fontSize: s.fs,
    fontWeight: 600,
    lineHeight: 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    whiteSpace: 'nowrap',
    ...v,
    ...style,
  };

  const [hover, setHover] = React.useState(false);
  const hoverStyle = !disabled && hover ? (
    variant === 'primary' ? { background: 'var(--brand-lo)' }
      : variant === 'secondary' ? { borderColor: 'var(--border-hi)', color: 'var(--fg)' }
        : { background: 'var(--surface-1)', borderColor: 'var(--border)' }
  ) : {};

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...base, ...hoverStyle, width: fullWidth ? '100%' : undefined }}
      {...rest}
    >
      {icon}
      {children}
      {iconRight}
    </button>
  );
}
