// src/components/terminal/AlertsPanel.jsx
// Price alert manager — bell icon in CommandBar opens a dropdown panel.
// Alerts are checked server-side on every tick and broadcast via WS
// as a `price_alert_triggered` message (handled in useWebSocket).

import { useState, useCallback } from 'react'
import toast from 'react-hot-toast'
import { createAlert, deleteAlert } from '../../lib/api'
import { useDataStore, useTheme } from '../../store'

function BellIcon({ count, color, t }) {
  return (
    <div style={{ position: 'relative' }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path
          d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"
          stroke={count > 0 ? color : t.textMuted}
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" stroke={count > 0 ? color : t.textMuted} strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {count > 0 && (
        <div style={{
          position: 'absolute', top: -4, right: -4,
          width: 14, height: 14, borderRadius: '50%',
          background: color, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 8, fontWeight: 700, color: '#fff', lineHeight: 1,
        }}>
          {count > 9 ? '9+' : count}
        </div>
      )}
    </div>
  )
}

function AlertRow({ alert, onDelete, t }) {
  const ticker    = useDataStore(s => s.tickers[alert.symbol?.toUpperCase()])
  const ltp       = ticker?.price
  const triggered = alert.triggered
  const col       = triggered ? t.amber : t.bull
  const diff      = ltp != null ? (ltp - alert.target_price) : null

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
      borderBottom: `1px solid ${t.border}`,
      background: triggered ? `${t.amber}08` : 'transparent',
      opacity: triggered ? 0.7 : 1,
    }}>
      {/* Direction indicator */}
      <span style={{ fontSize: 12, width: 14, textAlign: 'center' }}>
        {alert.direction === 'above' ? '↑' : '↓'}
      </span>

      {/* Symbol + target */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: t.cyan, fontFamily: t.fontUI }}>{alert.symbol}</span>
          <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI }}>
            {alert.direction === 'above' ? '≥' : '≤'} {alert.target_price.toLocaleString()}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          {ltp != null && (
            <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>
              LTP: <span style={{ color: col }}>{ltp.toLocaleString()}</span>
              {diff != null && <span style={{ color: diff >= 0 ? t.bull : t.bear, marginLeft: 3 }}>
                ({diff >= 0 ? '+' : ''}{diff.toFixed(2)})
              </span>}
            </span>
          )}
          {triggered && (
            <span style={{ fontSize: 9, color: t.amber, fontFamily: t.fontUI, fontWeight: 600 }}>● TRIGGERED</span>
          )}
        </div>
      </div>

      {/* Delete */}
      <button
        onClick={() => onDelete(alert.id)}
        style={{
          background: 'none', border: 'none', color: t.textDim, cursor: 'pointer',
          fontSize: 14, lineHeight: 1, padding: '2px 4px',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = t.bear }}
        onMouseLeave={e => { e.currentTarget.style.color = t.textDim }}
        title="Remove alert"
      >×</button>
    </div>
  )
}

export default function AlertsPanel({ t }) {
  const [open,      setOpen]      = useState(false)
  const [symbol,    setSymbol]    = useState('')
  const [price,     setPrice]     = useState('')
  const [direction, setDirection] = useState('above')
  const [adding,    setAdding]    = useState(false)

  const priceAlerts     = useDataStore(s => s.priceAlerts)
  const addPriceAlert   = useDataStore(s => s.addPriceAlert)
  const removePriceAlert = useDataStore(s => s.removePriceAlert)

  const activeAlerts    = priceAlerts.filter(a => !a.triggered)
  const triggeredAlerts = priceAlerts.filter(a => a.triggered)

  const handleAdd = useCallback(async (e) => {
    e?.preventDefault()
    if (!symbol.trim() || !price || parseFloat(price) <= 0) {
      toast.error('Symbol and valid price required'); return
    }
    setAdding(true)
    const payload = {
      symbol:       symbol.toUpperCase().trim(),
      target_price: parseFloat(price),
      direction,
    }
    try {
      const result = await createAlert(payload)
      addPriceAlert({
        id:           result?.id || `ALT${Date.now()}`,
        symbol:       payload.symbol,
        target_price: payload.target_price,
        direction:    payload.direction,
        triggered:    false,
        created_at:   new Date().toISOString(),
      })
      toast.success(`Alert set: ${payload.symbol} ${payload.direction === 'above' ? '↑≥' : '↓≤'} ${payload.target_price}`)
      setSymbol(''); setPrice('')
    } catch {
      toast.error('Failed to create alert')
    } finally {
      setAdding(false)
    }
  }, [symbol, price, direction, addPriceAlert])

  const handleDelete = useCallback(async (id) => {
    try {
      await deleteAlert(id)
      removePriceAlert(id)
    } catch {
      toast.error('Failed to remove alert')
    }
  }, [removePriceAlert])

  const inputStyle = {
    background: t.bgInput, border: `1px solid ${t.border}`,
    color: t.text, fontFamily: t.fontUI, fontSize: 12,
    padding: '6px 10px', borderRadius: t.radius, outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* Bell trigger */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Price Alerts"
        style={{
          background: open ? t.accentBg : 'rgba(255,255,255,0.05)',
          border: `1px solid ${open ? t.accent : t.border}`,
          borderRadius: t.radius,
          padding: '5px 8px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.15s',
        }}
        onMouseEnter={e => { if (!open) { e.currentTarget.style.borderColor = t.borderHover }}}
        onMouseLeave={e => { if (!open) { e.currentTarget.style.borderColor = t.border }}}
      >
        <BellIcon count={activeAlerts.length} color={t.amber} t={t} />
      </button>

      {/* Panel dropdown */}
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 198 }} />
          <div className="fade-in" style={{
            position: 'absolute', top: 42, right: 0,
            width: 300, maxHeight: 480,
            background: t.bgCard, border: `1px solid ${t.border}`,
            borderRadius: t.radiusLg, boxShadow: t.shadowLg,
            zIndex: 199, display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>
                Price Alerts
              </span>
              <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI }}>
                {activeAlerts.length} active
              </span>
            </div>

            {/* Add alert form */}
            <form onSubmit={handleAdd} style={{ padding: '10px 12px', borderBottom: `1px solid ${t.border}` }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 6, marginBottom: 6 }}>
                <input
                  value={symbol}
                  onChange={e => setSymbol(e.target.value.toUpperCase())}
                  placeholder="Symbol"
                  style={{ ...inputStyle, width: '100%' }}
                  autoComplete="off"
                  onFocus={e => { e.target.style.borderColor = t.accent; e.target.style.boxShadow = `0 0 0 2px ${t.accentBg}` }}
                  onBlur={e => { e.target.style.borderColor = t.border; e.target.style.boxShadow = 'none' }}
                />
                <select
                  value={direction}
                  onChange={e => setDirection(e.target.value)}
                  style={{ ...inputStyle, width: '100%', cursor: 'pointer' }}
                >
                  <option value="above">↑ Above</option>
                  <option value="below">↓ Below</option>
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6 }}>
                <input
                  type="number"
                  value={price}
                  onChange={e => setPrice(e.target.value)}
                  placeholder="Target price"
                  step="0.01"
                  style={{ ...inputStyle, width: '100%' }}
                  onFocus={e => { e.target.style.borderColor = t.accent; e.target.style.boxShadow = `0 0 0 2px ${t.accentBg}` }}
                  onBlur={e => { e.target.style.borderColor = t.border; e.target.style.boxShadow = 'none' }}
                />
                <button
                  type="submit"
                  disabled={adding}
                  style={{
                    padding: '6px 12px', fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
                    background: t.accentBg, border: `1px solid ${t.accent}`,
                    color: t.accent, borderRadius: t.radius, cursor: adding ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >{adding ? '…' : '+ Add'}</button>
              </div>
            </form>

            {/* Active alerts */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {priceAlerts.length === 0 && (
                <div style={{ padding: '20px 14px', textAlign: 'center', color: t.textDim, fontSize: 11, fontFamily: t.fontUI }}>
                  No alerts set
                </div>
              )}
              {activeAlerts.length > 0 && (
                <>
                  {activeAlerts.map(a => (
                    <AlertRow key={a.id} alert={a} onDelete={handleDelete} t={t} />
                  ))}
                </>
              )}
              {triggeredAlerts.length > 0 && (
                <>
                  <div style={{ padding: '6px 12px', fontSize: 9, fontWeight: 600, color: t.amber, fontFamily: t.fontUI, letterSpacing: 0.5, background: `${t.amber}08`, borderBottom: `1px solid ${t.border}` }}>
                    TRIGGERED
                  </div>
                  {triggeredAlerts.map(a => (
                    <AlertRow key={a.id} alert={a} onDelete={handleDelete} t={t} />
                  ))}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
