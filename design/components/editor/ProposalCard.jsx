import React from 'react';

/**
 * OpenScreen ProposalCard — the agent's "Proposed cuts" card: a header
 * with total + confidence badge, a list of time-range rows with striped
 * clip chips, an apply/review action row, and a rationale footnote.
 */
export function ProposalCard({
  title = 'Proposed cuts',
  total,
  confidence = 'High confidence',
  items = [],
  rationale,
  applyLabel = 'Apply',
  onApply,
  onReview,
}) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 14, background: 'var(--surface-1)', overflow: 'hidden', boxShadow: 'var(--elev-card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px 10px', borderBottom: '1px solid var(--border-soft)' }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}><path d="M20 6 9 17l-5-5" /></svg>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', letterSpacing: '-0.01em' }}>{title}</span>
        {total != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--meta)' }}>−{total}</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 9999, background: 'var(--accent-soft)', color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, border: '1px solid var(--accent-border)' }}>
          <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--accent)' }} />{confidence}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 13px', borderBottom: '1px solid var(--border-soft)' }}>
            <span aria-hidden="true" style={{ width: 16, height: 9, borderRadius: 2, flexShrink: 0, background: 'var(--accent-wash)', backgroundImage: 'repeating-linear-gradient(45deg, var(--accent-stripe) 0, var(--accent-stripe) 3px, transparent 3px, transparent 6px)' }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg)' }}>{it.range}</span>
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted)' }}>−{it.dur}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px', background: 'var(--surface)' }}>
        <button onClick={onApply} style={{ flex: 1, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 8px -3px var(--accent-soft)' }}>{applyLabel}</button>
        <button onClick={onReview} style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-1)', color: 'var(--fg-2)', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>Review each</button>
      </div>
      {rationale && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '0 13px 12px' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--meta)', flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          <span style={{ fontSize: 10.5, color: 'var(--meta)', lineHeight: 1.45 }}>{rationale}</span>
        </div>
      )}
    </div>
  );
}
