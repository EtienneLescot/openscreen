import React from 'react';

/**
 * OpenScreen IconButton — square, icon-only. The workhorse of toolbars,
 * the topbar, and floating chrome. Ghost by default; `active` gives the
 * emerald-soft selected look; `tone="danger"` for destructive.
 */
export function IconButton({
  size = 32,
  active = false,
  tone = 'default',
  disabled = false,
  title,
  onClick,
  children,
  style = {},
  ...rest
}) {
  const [hover, setHover] = React.useState(false);

  const rest_ = { default: 'var(--muted)', danger: 'var(--muted)' }[tone];
  let color = active ? 'var(--accent)' : rest_;
  let background = active ? 'var(--accent-soft)' : 'transparent';

  if (!disabled && hover && !active) {
    if (tone === 'danger') { color = 'var(--danger)'; background = 'var(--danger-soft)'; }
    else { color = 'var(--fg)'; background = 'var(--surface-2)'; }
  }

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: size,
        height: size,
        display: 'grid',
        placeItems: 'center',
        borderRadius: size <= 28 ? 6 : 9,
        border: 0,
        background,
        color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
