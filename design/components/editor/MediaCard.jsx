import React from 'react';

/**
 * OpenScreen MediaCard — a clip tile in the media library. Gradient
 * thumbnail with a film-strip glyph, a drag-handle affordance, and a
 * name/duration/size footer. Selected → 1.5px emerald border.
 */
export function MediaCard({
  name,
  duration,
  size,
  from = '#10b981',
  to = '#0d986a',
  selected = false,
  draggable = true,
  onClick,
  onDragStart,
  onDragEnd,
  style = {},
}) {
  return (
    <button
      draggable={draggable}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{
        display: 'flex', flexDirection: 'column', padding: 0,
        border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 12, background: 'var(--surface)', overflow: 'hidden',
        cursor: 'grab', textAlign: 'left', ...style,
      }}
    >
      <div style={{ position: 'relative', height: 84, display: 'grid', placeItems: 'center', background: `linear-gradient(135deg, ${from}, ${to})` }}>
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2" /><path d="M7 4v16M17 4v16M2.5 9h4.5M2.5 15h4.5M17 9h4.5M17 15h4.5" /></svg>
        <span aria-hidden="true" style={{ position: 'absolute', top: 7, left: 7, width: 22, height: 22, display: 'grid', placeItems: 'center', borderRadius: 6, background: 'rgba(8,10,13,0.45)', backdropFilter: 'blur(6px)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="rgba(255,255,255,0.9)"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 12px' }}>
        {selected && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted)' }}>{duration}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--meta)' }}>{size}</span>
          </div>
        </div>
      </div>
    </button>
  );
}
