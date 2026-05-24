// src/components/common/ConfirmDialog.jsx
// ────────────────────────────────────────────────────────
// Terminal-styled confirm dialog. Used for destructive actions
// (kill switch, delete user, etc) so a mis-click doesn't halt trading.

import { useEffect } from 'react'

export default function ConfirmDialog({
  open, title, body, confirmLabel = 'CONFIRM', cancelLabel = 'CANCEL',
  danger = true, onConfirm, onCancel,
}) {
  useEffect(() => {
    if (!open) return
    function esc(e) { if (e.key === 'Escape') onCancel?.() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(6,8,9,.88)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 2000, fontFamily: '"IBM Plex Mono", monospace',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 420, background: '#0a0d10',
          border: `1px solid ${danger ? '#ff3b4e' : '#ff8c00'}`,
          borderRadius: 3, overflow: 'hidden',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{
          background: danger ? 'rgba(255,59,78,.12)' : 'rgba(255,140,0,.12)',
          borderBottom: `1px solid ${danger ? '#ff3b4e' : '#ff8c00'}`,
          padding: '10px 14px',
          color: danger ? '#ff3b4e' : '#ff8c00',
          fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        }}>
          ⚡ {title}
        </div>
        <div style={{ padding: 16, color: '#c8d8e8', fontSize: 11, lineHeight: 1.6 }}>
          {body}
        </div>
        <div style={{
          padding: '0 16px 14px', display: 'flex', gap: 8, justifyContent: 'flex-end',
        }}>
          <button
            onClick={onCancel}
            autoFocus
            style={{
              background: '#14191f', color: '#6a8099',
              border: '1px solid #1f2830', padding: '6px 14px',
              fontSize: 10, cursor: 'pointer',
              fontFamily: '"IBM Plex Mono", monospace', borderRadius: 2,
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              background: danger ? '#c02030' : '#ff8c00',
              color: danger ? '#fff' : '#000',
              border: `1px solid ${danger ? '#ff3b4e' : '#ff8c00'}`,
              padding: '6px 16px', fontSize: 10, fontWeight: 700,
              cursor: 'pointer', fontFamily: '"IBM Plex Mono", monospace',
              borderRadius: 2, letterSpacing: 0.5,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
