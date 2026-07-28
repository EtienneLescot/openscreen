import React from 'react';

/**
 * OpenScreen Slider — the labelled range control inside inspector cards.
 * Renders the whole card: label (left) + mono value in emerald (right)
 * above a filled range track. Pass `card={false}` for a bare track.
 */
export function Slider({
  label,
  value = 0,
  min = 0,
  max = 100,
  step = 1,
  format,
  onChange,
  card = true,
  style = {},
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const trackStyle = {
    width: '100%',
    display: 'block',
    backgroundImage: `linear-gradient(var(--accent),var(--accent)), linear-gradient(var(--surface-3),var(--surface-3))`,
    backgroundSize: `${pct}% 5px, 100% 5px`,
  };
  const display = format ? format(value) : value;

  const input = (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange && onChange(Number(e.target.value))}
      style={trackStyle}
    />
  );

  if (!card) return input;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--surface)',
        padding: '11px 13px',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--fg-2)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)', marginLeft: 'auto' }}>{display}</span>
      </div>
      {input}
    </div>
  );
}
