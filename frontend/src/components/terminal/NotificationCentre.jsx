// src/components/terminal/NotificationCentre.jsx
// Bell icon + slide-down panel showing persistent notification history.
// Unread badge clears when the panel is opened.

import { useState } from 'react'
import { useDataStore } from '../../store'
import { fmtIST } from '../../lib/api'

const TYPE_META = {
  bot:   { icon: '🤖', color: '#22c55e' },
  flip:  { icon: '↺',  color: '#ef4444' },
  alert: { icon: '⊘',  color: '#ef4444' },
  price: { icon: '🔔', color: '#F59E0B' },
}

export default function NotificationCentre({ t }) {
  const [open, setOpen] = useState(false)

  const notifications    = useDataStore(s => s.notifications)
  const markAllRead      = useDataStore(s => s.markAllRead)
  const clearNotifications = useDataStore(s => s.clearNotifications)

  const unread = notifications.filter(n => !n.read).length

  function handleOpen() {
    setOpen(o => {
      if (!o) markAllRead()
      return !o
    })
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* Bell button */}
      <button
        onClick={handleOpen}
        title="Notifications"
        style={{
          width: 34, height: 34, borderRadius: '50%',
          background: 'transparent',
          border: `1px solid ${unread > 0 ? t.amber : t.border}`,
          cursor: 'pointer', position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'border-color 0.15s',
          flexShrink: 0,
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = t.accent }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = unread > 0 ? t.amber : t.border }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={unread > 0 ? t.amber : t.textMuted} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -3, right: -3,
            minWidth: 16, height: 16, borderRadius: 8,
            background: t.bear, color: '#fff',
            fontSize: 9, fontWeight: 700, fontFamily: t.fontUI,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 3px',
          }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 98 }} />
          <div className="fade-in" style={{
            position: 'absolute', right: 0, top: 42, width: 330,
            background: t.bgCard, border: `1px solid ${t.border}`,
            borderRadius: t.radiusLg, boxShadow: t.shadowLg,
            zIndex: 99, overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', padding: '11px 14px',
              borderBottom: `1px solid ${t.border}`,
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: t.text, fontFamily: t.fontUI, letterSpacing: 0.5, flex: 1 }}>
                NOTIFICATIONS
              </span>
              {notifications.length > 0 && (
                <button
                  onClick={clearNotifications}
                  style={{
                    fontSize: 9, color: t.textDim, fontFamily: t.fontUI,
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: '2px 6px', borderRadius: 4, transition: 'color 0.12s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = t.bear }}
                  onMouseLeave={e => { e.currentTarget.style.color = t.textDim }}
                >
                  Clear all
                </button>
              )}
            </div>

            {/* List */}
            <div style={{ maxHeight: 400, overflowY: 'auto', scrollbarWidth: 'thin' }}>
              {notifications.length === 0 ? (
                <div style={{
                  padding: '36px 20px', textAlign: 'center',
                  fontSize: 11, color: t.textDim, fontFamily: t.fontUI,
                }}>
                  No notifications yet
                </div>
              ) : (
                notifications.map(n => {
                  const meta = TYPE_META[n.type] || { icon: '●', color: t.textMuted }
                  return (
                    <div key={n.id} style={{
                      display: 'flex', gap: 10, padding: '10px 14px',
                      borderBottom: `1px solid ${t.border}20`,
                      background: n.read ? 'transparent' : `${t.accent}05`,
                      transition: 'background 0.15s',
                    }}>
                      <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1, color: meta.color }}>
                        {meta.icon}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 11, fontWeight: 600, color: t.text,
                          fontFamily: t.fontUI, marginBottom: 2,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {n.title}
                        </div>
                        {n.body && (
                          <div style={{
                            fontSize: 10, color: t.textMuted, fontFamily: t.fontUI,
                            lineHeight: 1.4, marginBottom: 4,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {n.body}
                          </div>
                        )}
                        <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>
                          {fmtIST(n.ts, 'datetime')}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
