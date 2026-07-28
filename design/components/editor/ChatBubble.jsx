import React from 'react';

/**
 * OpenScreen ChatBubble — a single agent-conversation row. Handles the
 * three roles: assistant (avatar + left bubble, meta header), user
 * (right, emerald-tinted), system (centered pill).
 */
export function ChatBubble({ role = 'assistant', author, time, children, avatar = null }) {
  if (role === 'system') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div style={{ maxWidth: '94%', padding: '6px 13px', borderRadius: 9999, background: 'var(--surface-1)', border: '1px solid var(--border-soft)', color: 'var(--muted)', fontSize: 11.5 }}>
          {children}
        </div>
      </div>
    );
  }
  if (role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', maxWidth: '86%' }}>
          {(author || time) && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 2px' }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>{author}</span>
              {time && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--meta)' }}>{time}</span>}
            </div>
          )}
          <div style={{ padding: '10px 14px', borderRadius: '15px 5px 15px 15px', background: 'var(--accent-soft)', border: '1px solid var(--accent-border)', color: 'var(--fg)', fontSize: 13, lineHeight: 1.55 }}>
            {children}
          </div>
        </div>
      </div>
    );
  }
  // assistant
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', flexShrink: 0, marginTop: 2, display: 'grid', placeItems: 'center', color: 'var(--accent)' }}>
        {avatar}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, maxWidth: '86%' }}>
        {(author || time) && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 2px' }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>{author}</span>
            {time && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--meta)' }}>{time}</span>}
          </div>
        )}
        <div style={{ padding: '11px 14px', borderRadius: '5px 15px 15px 15px', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg-2)', fontSize: 13, lineHeight: 1.55, boxShadow: 'var(--elev-card)' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
