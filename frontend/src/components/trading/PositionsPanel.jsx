// src/components/trading/PositionsPanel.jsx
// Live positions with real-time MTM P&L, Greeks, and close controls.
// Close flow: click CLOSE → partial-close modal with qty + MARKET/LIMIT choice.
// `compact` prop renders a trimmed view for the main 4-panel grid.

import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { closePosition } from '../../lib/api'
import { useDataStore, useTerminalStore, useTheme } from '../../store'

// Overlay live WebSocket LTP onto a position and recompute unrealised P&L.
// day_pnl is left from the REST response — it requires previous-close which
// the ticker feed doesn't carry.
function enrich(p, tickers) {
  const tick = tickers[p.symbol]
  if (!tick?.ltp) return p
  const ltp      = tick.ltp
  const sign     = p.side === 'SHORT' ? -1 : 1
  const unrl_pnl = (ltp - p.avg) * p.qty * sign
  const unrl_pct = p.avg > 0 ? ((ltp - p.avg) / p.avg) * 100 : 0
  return { ...p, ltp, unrl_pnl, unrl_pct, _updatedAt: tick._flashAt }
}

const SIDE_COLOR = (side, t) => side === 'LONG' ? t.bull : t.bear

function PnlCell({ value, pct, t, isModern }) {
  const v = value ?? 0
  const positive = v >= 0
  const color = positive ? t.bull : t.bear
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ color, fontSize: 9, fontWeight: 600, textShadow: isModern ? `0 0 6px ${color}` : 'none' }}>
        {positive ? '+' : ''}{Math.abs(v) >= 1000
          ? `${(v / 1000).toFixed(2)}K`
          : v.toFixed(0)}
      </div>
      {pct != null && (
        <div style={{ color: positive ? t.bull : t.bear, fontSize: 8, opacity: 0.7 }}>
          {positive ? '+' : ''}{(pct ?? 0).toFixed(2)}%
        </div>
      )}
    </div>
  )
}

function PositionRow({ p, onOpenClose, t, isModern, closing }) {
  const sideColor = SIDE_COLOR(p.side, t)

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '90px 40px 36px 50px 64px 64px 80px 80px 50px 48px',
      padding: '4px 8px',
      borderBottom: `1px solid ${isModern ? 'rgba(0,200,255,0.06)' : t.border}`,
      alignItems: 'center',
      fontFamily: t.font,
      background: p._updatedAt && Date.now() - p._updatedAt < 800
        ? (isModern ? 'rgba(0,255,148,0.04)' : 'rgba(0,230,118,0.03)')
        : 'transparent',
    }}>
      {/* Symbol + entry time */}
      <div>
        <div style={{ color: t.cyan, fontSize: 10, fontWeight: 500, textShadow: isModern ? `0 0 6px ${t.cyan}60` : 'none' }}>{p.symbol}</div>
        <div style={{ color: t.textDim, fontSize: 8 }}>
          {p.exch} · {p.product}
          {p.entry_time && <span style={{ color: t.textDim, marginLeft: 3 }}>@ {p.entry_time}</span>}
        </div>
      </div>

      {/* Side */}
      <span style={{ color: sideColor, fontSize: 9, fontWeight: 700, textShadow: isModern ? `0 0 6px ${sideColor}` : 'none' }}>{p.side}</span>

      {/* Qty */}
      <span style={{ color: t.text, fontSize: 9, textAlign: 'right' }}>{p.qty}</span>

      {/* Avg entry */}
      <span style={{ color: t.textMuted, fontSize: 9, textAlign: 'right' }}>
        {p.avg >= 1000 ? p.avg.toLocaleString() : p.avg}
      </span>

      {/* LTP — glows briefly when a live WebSocket tick arrives */}
      <span style={{
        color: t.text, fontSize: 10, fontWeight: 500, textAlign: 'right',
        transition: 'text-shadow 0.4s',
        textShadow: p._updatedAt && Date.now() - p._updatedAt < 800
          ? `0 0 8px ${t.cyan}` : 'none',
      }}>
        {p.ltp >= 1000 ? p.ltp.toLocaleString() : p.ltp}
      </span>

      {/* Unrealised P&L */}
      <PnlCell value={p.unrl_pnl} pct={p.unrl_pct} t={t} isModern={isModern} />

      {/* Realised P&L */}
      <PnlCell value={p.realized_pnl} t={t} isModern={isModern} />

      {/* Day P&L */}
      <PnlCell value={p.day_pnl} t={t} isModern={isModern} />

      {/* Delta */}
      <span style={{ color: p.delta >= 0 ? t.bull : t.bear, fontSize: 9, textAlign: 'right' }}>
        {p.delta > 0 ? '+' : ''}{p.delta}
      </span>

      {/* Close button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={() => onOpenClose(p)}
          disabled={closing === p.symbol}
          title={`Close ${p.symbol} position`}
          style={{
            background: 'none',
            border: `1px solid ${t.bear}60`,
            color: t.bear, fontSize: 8,
            padding: '2px 5px', cursor: closing === p.symbol ? 'not-allowed' : 'pointer',
            borderRadius: 2, fontFamily: t.font,
            opacity: closing === p.symbol ? 0.4 : 1,
            transition: 'all 0.12s',
          }}
          onMouseEnter={e => { if (closing !== p.symbol) { e.currentTarget.style.background = `${t.bear}18`; e.currentTarget.style.borderColor = t.bear }}}
          onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.borderColor = `${t.bear}60` }}
        >
          {closing === p.symbol ? '…' : 'CLOSE'}
        </button>
      </div>
    </div>
  )
}

// Partial-close modal — floats over the panel
function CloseModal({ pos, t, onConfirm, onCancel, submitting }) {
  const [closeQty,   setCloseQty]   = useState(String(pos.qty))
  const [closeType,  setCloseType]  = useState('MARKET')
  const [closePrice, setClosePrice] = useState(String(pos.ltp || ''))

  const currency  = pos.currency === 'USD' ? '$' : '₹'
  const maxQty    = pos.qty
  const validQty  = parseFloat(closeQty) > 0 && parseFloat(closeQty) <= maxQty

  const inputStyle = {
    width: '100%', boxSizing: 'border-box',
    background: t.bgInput, border: `1px solid ${t.border}`,
    color: t.text, fontFamily: t.fontUI, fontSize: 12,
    padding: '7px 10px', borderRadius: t.radius, outline: 'none',
  }

  return createPortal(
    <>
      <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(3px)', zIndex: 800 }} />
      <div className="fade-in" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        zIndex: 801, width: 320,
        maxHeight: 'calc(100vh - 32px)',
        display: 'flex', flexDirection: 'column',
        background: t.bgCard, border: `1px solid ${t.border}`,
        borderTop: `3px solid ${t.bear}`,
        borderRadius: t.radiusLg, boxShadow: t.shadowLg, overflow: 'hidden',
      }}>
        {/* Header — always visible */}
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <span style={{ fontSize: 12, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>Close {pos.symbol}</span>
            <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI, marginLeft: 8 }}>
              Max: {maxQty} · LTP: {currency}{pos.ltp?.toLocaleString()}
            </span>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: t.textMuted, fontSize: 18, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
          {/* Qty */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                Quantity to Close
              </label>
              <button
                type="button"
                onClick={() => setCloseQty(String(maxQty))}
                style={{ fontSize: 9, color: t.accent, fontFamily: t.fontUI, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >ALL</button>
            </div>
            <input
              type="number"
              value={closeQty}
              onChange={e => setCloseQty(e.target.value)}
              min="0"
              max={maxQty}
              step="1"
              style={{ ...inputStyle, borderColor: !validQty && closeQty ? t.bear : t.border }}
              onFocus={e => { e.target.style.borderColor = t.accent; e.target.style.boxShadow = `0 0 0 3px ${t.accentBg}` }}
              onBlur={e => { e.target.style.borderColor = !validQty && closeQty ? t.bear : t.border; e.target.style.boxShadow = 'none' }}
            />
            {!validQty && closeQty && (
              <span style={{ fontSize: 9, color: t.bear, fontFamily: t.fontUI }}>Max qty: {maxQty}</span>
            )}
          </div>

          {/* Close type */}
          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>Close Type</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {['MARKET', 'LIMIT'].map(ct => (
                <button
                  key={ct}
                  type="button"
                  onClick={() => setCloseType(ct)}
                  style={{
                    padding: '7px 0', fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
                    cursor: 'pointer', borderRadius: t.radius,
                    border: `1px solid ${closeType === ct ? t.accent : t.border}`,
                    background: closeType === ct ? t.accentBg : 'transparent',
                    color: closeType === ct ? t.accent : t.textDim,
                    transition: 'all 0.12s',
                  }}
                >{ct}</button>
              ))}
            </div>
          </div>

          {/* Limit price (if LIMIT) */}
          {closeType === 'LIMIT' && (
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>
                Limit Price <span style={{ color: t.textDim, fontWeight: 400, fontSize: 9 }}>(LTP: {currency}{pos.ltp?.toLocaleString()})</span>
              </label>
              <input
                type="number"
                value={closePrice}
                onChange={e => setClosePrice(e.target.value)}
                step="0.01"
                style={inputStyle}
                onFocus={e => { e.target.style.borderColor = t.accent; e.target.style.boxShadow = `0 0 0 3px ${t.accentBg}` }}
                onBlur={e => { e.target.style.borderColor = t.border; e.target.style.boxShadow = 'none' }}
              />
            </div>
          )}

          {/* Estimated close value */}
          {validQty && (
            <div style={{ padding: '8px 10px', background: t.bgActive, border: `1px solid ${t.border}`, borderRadius: t.radius, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI }}>Close value</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>
                {currency}{(parseFloat(closeQty) * (closeType === 'LIMIT' && closePrice ? parseFloat(closePrice) : pos.ltp)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            </div>
          )}

          {/* Confirm button */}
          <button
            type="button"
            disabled={!validQty || submitting || (closeType === 'LIMIT' && !closePrice)}
            onClick={() => onConfirm(parseFloat(closeQty), closeType, closeType === 'LIMIT' ? parseFloat(closePrice) : null)}
            style={{
              width: '100%', padding: '10px 0', fontSize: 12, fontWeight: 700, fontFamily: t.fontUI,
              cursor: (!validQty || submitting) ? 'not-allowed' : 'pointer',
              borderRadius: t.radius, border: 'none',
              background: (!validQty || submitting) ? `${t.bear}40` : t.bear,
              color: '#fff', opacity: (!validQty || submitting) ? 0.6 : 1,
              boxShadow: (!validQty || submitting) ? 'none' : `0 4px 12px ${t.bear}40`,
              transition: 'all 0.15s',
            }}
          >
            {submitting ? 'Closing…' : `CLOSE ${closeQty || '0'} × ${pos.symbol} @ ${closeType}`}
          </button>
        </div>
      </div>
    </>,
    document.body
  )
}

export default function PositionsPanel({ compact = false }) {
  const positions = useDataStore((s) => s.positions)
  const tickers   = useDataStore((s) => s.tickers)
  const t = useTheme()
  const isModern = t.name === 'modern'
  const [closing,    setClosing]    = useState(null)
  const [closeModal, setCloseModal] = useState(null)
  const openTicket = useTerminalStore((s) => s.openOrderTicket)

  // Enrich REST positions with live WS prices
  const base    = positions
  const rows    = base.map(p => enrich(p, tickers))
  const display = compact ? rows.slice(0, 6) : rows

  const totalUnrl = rows.reduce((s, p) => s + (p.unrl_pnl || 0), 0)
  const totalReal = rows.reduce((s, p) => s + (p.realized_pnl || 0), 0)
  const totalDay  = rows.reduce((s, p) => s + (p.day_pnl  || 0), 0)

  const handleClose = useCallback(async (qty, type, price) => {
    if (!closeModal) return
    const sym    = closeModal.symbol
    const market = closeModal.market || 'india'
    setClosing(sym)
    try {
      await closePosition(sym, qty, { type, price, market })
      toast.success(`${sym}: close order placed (${qty} × ${type === 'MARKET' ? 'MKT' : price})`)
      setCloseModal(null)
    } catch {
      toast.error('Close order failed')
    } finally {
      setClosing(null)
    }
  }, [closeModal])

  const pnlColor = (v) => v >= 0 ? t.bull : t.bear

  const COLS = ['SYMBOL', 'SIDE', 'QTY', 'AVG', 'LTP', 'UNRL P&L', 'REALIZED', 'DAY P&L', 'DELTA', '']

  return (
    <div style={{ background: t.bgPanel, display: 'flex', flexDirection: 'column', overflow: 'hidden', backdropFilter: isModern ? t.panelGlass : 'none' }}>

      {/* Partial-close modal */}
      {closeModal && (
        <CloseModal
          pos={closeModal}
          t={t}
          onConfirm={handleClose}
          onCancel={() => setCloseModal(null)}
          submitting={closing === closeModal?.symbol}
        />
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${t.border}`, height: 44, padding: '0 16px', flexShrink: 0, gap: 12 }}>
        <span style={{ color: t.text, fontSize: 13, fontWeight: 700, fontFamily: t.fontUI, letterSpacing: -0.2 }}>Positions</span>
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontUI, background: t.bgActive, padding: '2px 8px', borderRadius: 20 }}>
          {rows.length} open
        </span>

        {/* P&L summary chips */}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          {[
            { label: 'Unrealised', value: totalUnrl },
            { label: 'Realised',   value: totalReal },
            { label: 'Day P&L',    value: totalDay  },
          ].map(({ label, value }) => (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', padding: '3px 10px', background: t.bgActive, borderRadius: t.radius, border: `1px solid ${t.border}` }}>
              <span style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI }}>{label}</span>
              <span style={{ fontSize: 11, fontWeight: 700, fontFamily: t.fontUI, color: pnlColor(value) }}>
                {(value ?? 0) >= 0 ? '+' : ''}{Math.abs(value ?? 0) >= 1000 ? `${((value ?? 0) / 1000).toFixed(1)}K` : (value ?? 0).toFixed(0)}
              </span>
            </div>
          ))}
          <button
            onClick={() => openTicket(null, 'BUY')}
            style={{ padding: '0 14px', height: 28, background: t.bullBg, border: `1px solid ${t.bull}40`, borderRadius: t.radius, color: t.bull, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: t.fontUI }}
            title="New Order (Ctrl+O)"
          >+ Order</button>
        </div>
      </div>

      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '90px 40px 36px 50px 64px 64px 80px 80px 50px 48px',
        padding: '5px 8px', borderBottom: `1px solid ${t.border}`,
        fontSize: 10, color: t.textMuted, letterSpacing: 0.3,
        flexShrink: 0, fontFamily: t.fontUI, fontWeight: 500,
      }}>
        {COLS.map((c, i) => (
          <span key={c || '_close'} style={{ textAlign: i >= 2 ? 'right' : 'left' }}>{c}</span>
        ))}
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {display.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 60, color: t.textDim, fontSize: 10, fontFamily: t.font }}>
            NO OPEN POSITIONS
          </div>
        ) : display.map(p => (
          <PositionRow
            key={p.symbol}
            p={p}
            onOpenClose={setCloseModal}
            t={t}
            isModern={isModern}
            closing={closing}
          />
        ))}
      </div>

      {/* Footer totals — full view only */}
      {!compact && rows.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '90px 40px 36px 50px 64px 64px 80px 80px 50px 48px',
          padding: '4px 8px', borderTop: `1px solid ${t.border}`,
          fontSize: 9, fontFamily: t.font,
          background: t.bgRow, flexShrink: 0,
        }}>
          <span style={{ color: t.textDim, fontSize: 8 }}>TOTAL ({rows.length})</span>
          <span /><span /><span /><span />
          <div style={{ textAlign: 'right', color: pnlColor(totalUnrl), fontWeight: 600 }}>
            {(totalUnrl ?? 0) >= 0 ? '+' : ''}{(totalUnrl ?? 0).toFixed(0)}
          </div>
          <div style={{ textAlign: 'right', color: pnlColor(totalReal), fontWeight: 600 }}>
            {(totalReal ?? 0) >= 0 ? '+' : ''}{(totalReal ?? 0).toFixed(0)}
          </div>
          <div style={{ textAlign: 'right', color: pnlColor(totalDay), fontWeight: 600 }}>
            {(totalDay ?? 0) >= 0 ? '+' : ''}{(totalDay ?? 0).toFixed(0)}
          </div>
          <span /><span />
        </div>
      )}
    </div>
  )
}
