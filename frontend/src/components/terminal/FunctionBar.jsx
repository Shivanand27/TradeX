// src/components/terminal/FunctionBar.jsx
// F1–F9 navigation bar + live P&L summary + connection status.
//
// F1 HOME     — Full market dashboard (India + Crypto outlook, news, watchlist)
// F2 SIGNALS  — AI + RF[DW] trade signals with popup modal + PnL
// F3 ORDERS   — Order blotter
// F4 POS      — Positions panel
// F5 RISK     — Risk monitor
// F6 NEWS     — Intel feed
// F7 BOTS     — Agent live thinking + execution logs
// F8 USERS    — Admin users panel
// F9 SETTINGS — Broker / system settings

import { useDataStore, useTerminalStore, useTheme } from '../../store'
import { ConnectionStatus } from '../common/LoadingSkeleton'

export const FKEYS = [
  { k: 'F1', label: 'HOME',     view: 'terminal',  admin: false },
  { k: 'F2', label: 'SIGNALS',  view: 'signals',   admin: false },
  { k: 'F3', label: 'ORDERS',   view: 'orders',    admin: false },
  { k: 'F4', label: 'POS',      view: 'positions', admin: false },
  { k: 'F5', label: 'RISK',     view: 'risk',      admin: false },
  { k: 'F6', label: 'NEWS',     view: 'news',      admin: false },
  { k: 'F7', label: 'BOTS',     view: 'bots',      admin: false },
  { k: 'F8', label: 'USERS',    view: 'users',     admin: true  },
  { k: 'F9', label: 'SETTINGS', view: 'settings',  admin: false },
]

export default function FunctionBar() {
  const activeView    = useTerminalStore((s) => s.activeView)
  const setActiveView = useTerminalStore((s) => s.setActiveView)
  const isAdmin       = useTerminalStore((s) => s.isAdmin)
  const paperMode     = useTerminalStore((s) => s.paperMode)
  const wsState       = useDataStore((s) => s.wsState)
  const pnlSummary    = useDataStore((s) => s.pnlSummary)
  const positions     = useDataStore((s) => s.positions)
  const orders        = useDataStore((s) => s.orders)
  const t = useTheme()
  const isModern = t.name === 'modern'

  const dayPnl = positions.length > 0
    ? positions.reduce((s, p) => s + (p.day_pnl || 0), 0)
    : (pnlSummary.day_pnl ?? 0)

  const pendingOrders = orders.filter(o => o.status === 'PENDING' || o.status === 'OPEN').length
  const pnlPositive   = dayPnl >= 0
  const pnlColor      = pnlPositive ? t.bull : t.bear

  return (
    <div style={{
      background: t.bgPanel,
      borderBottom: `1px solid ${t.border}`,
      display: 'flex',
      alignItems: 'center',
      height: 22,
      flexShrink: 0,
      backdropFilter: isModern ? t.panelGlass : 'none',
    }}>
      {FKEYS.filter(f => !f.admin || isAdmin).map(f => {
        const isActive = activeView === f.view
        const isBots   = f.view === 'bots'
        const btnColor = isBots ? t.cyan : t.accent
        return (
          <button
            key={f.k}
            onClick={() => setActiveView(f.view)}
            style={{
              padding: '0 9px',
              height: '100%',
              background: isActive && isModern ? `${btnColor}08` : 'none',
              border: 'none',
              borderRight: `1px solid ${t.border}`,
              color: isActive ? btnColor : t.textDim,
              fontSize: 9,
              cursor: 'pointer',
              letterSpacing: 0.3,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontFamily: t.font,
              borderBottom: isActive ? `1px solid ${btnColor}` : 'none',
              textShadow: isActive && isModern ? `0 0 8px ${btnColor}80` : 'none',
              transition: 'all 0.15s ease',
            }}
          >
            <span style={{
              background: isModern ? `${btnColor}14` : t.bgActive,
              color: isActive ? btnColor : t.cyan,
              padding: '1px 3px', borderRadius: t.radius,
              fontSize: 8,
              border: isModern ? `1px solid ${btnColor}25` : 'none',
            }}>
              {f.k}
            </span>
            {f.label}
          </button>
        )
      })}

      {/* Right side controls */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 0 }}>

        {/* Day P&L */}
        {(positions.length > 0 || pnlSummary.day_pnl !== 0) && (
          <div style={{
            padding: '0 10px', height: 22,
            display: 'flex', alignItems: 'center', gap: 6,
            borderLeft: `1px solid ${t.border}`,
          }}>
            <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>DAY P&L</span>
            <span style={{
              fontSize: 10, fontWeight: 600, fontFamily: t.font, color: pnlColor,
              textShadow: isModern ? `0 0 8px ${pnlColor}60` : 'none',
            }}>
              {pnlPositive ? '+' : ''}{dayPnl >= 1000 || dayPnl <= -1000
                ? `₹${(dayPnl / 1000).toFixed(1)}K`
                : `₹${dayPnl.toFixed(0)}`}
            </span>
          </div>
        )}

        {/* Pending orders badge */}
        {pendingOrders > 0 && (
          <div
            onClick={() => setActiveView('orders')}
            style={{
              padding: '0 10px', height: 22,
              display: 'flex', alignItems: 'center', gap: 4,
              borderLeft: `1px solid ${t.border}`,
              cursor: 'pointer',
            }}
          >
            <span style={{
              background: `${t.amber}20`, color: t.amber,
              fontSize: 8, fontWeight: 600, padding: '1px 5px',
              borderRadius: 10, fontFamily: t.font, border: `1px solid ${t.amber}50`,
            }}>
              {pendingOrders} PENDING
            </span>
          </div>
        )}

        {/* Ctrl+O hint */}
        <div style={{
          padding: '0 8px', height: 22,
          display: 'flex', alignItems: 'center',
          borderLeft: `1px solid ${t.border}`,
        }}>
          <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>
            <span style={{ color: t.accent }}>Ctrl+O</span> order
          </span>
        </div>

        {/* WebSocket connection */}
        <div style={{
          padding: '0 10px', height: 22,
          display: 'flex', alignItems: 'center',
          borderLeft: `1px solid ${t.border}`,
        }}>
          <ConnectionStatus wsState={wsState} />
        </div>

        {/* Live / Paper */}
        <div style={{
          padding: '0 10px', fontSize: 9,
          borderLeft: `1px solid ${t.border}`,
          color: paperMode ? t.amber : t.bull,
          display: 'flex', alignItems: 'center', height: 22,
          fontFamily: t.font,
          textShadow: !paperMode && isModern ? t.glowBull : 'none',
        }}>
          {paperMode ? 'PAPER' : '● LIVE'}
        </div>
      </div>
    </div>
  )
}
