// src/components/trading/OrderBlotter.jsx
// Full order lifecycle table — pending, filled, partial, cancelled, rejected.
// Cancel All: bulk cancel all open/pending orders (with confirmation).
// Slippage: avg_fill vs intended price, shown under AVG FILL column.
// `compact` prop shows a trimmed 8-row version for the main terminal grid.

import { useState, useCallback } from 'react'
import toast from 'react-hot-toast'
import { cancelOrder, modifyOrder } from '../../lib/api'
import { useDataStore, useTerminalStore, useTheme } from '../../store'

const STATUS_COLORS = (s, t) => ({
  PENDING:   t.amber,
  OPEN:      t.amber,
  TRIGGERED: t.purple,
  PARTIAL:   t.cyan,
  FILLED:    t.bull,
  CANCELLED: t.textMuted,
  REJECTED:  t.bear,
}[s] || t.textDim)

const SIDE_COLOR = (side, t) => side === 'BUY' ? t.bull : t.bear

const FILTERS = ['OPEN', 'FILLED', 'CANCELLED']

// slippage = avg_fill - price (BUY: positive = overpaid; SELL: negative = underreceived)
function calcSlippage(o) {
  if (!o.avg_fill || !o.price || o.type === 'MARKET') return null
  return o.avg_fill - o.price
}

const GRID_COLS = '58px 86px 36px 44px 46px 60px 60px 68px 70px 64px'

// Pencil SVG icon for modify
function PencilIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function OrderRow({ o, onCancel, onModify, modifyingId, t, isModern, cancelling }) {
  const canCancel   = o.status === 'PENDING' || o.status === 'OPEN' || o.status === 'TRIGGERED'
  const canModify   = (o.status === 'PENDING' || o.status === 'OPEN') && o.type !== 'MARKET' && o.type !== 'IOC'
  const isModifying = modifyingId === o.id
  const statusColor = STATUS_COLORS(o.status, t)
  const fillPct     = o.qty > 0 ? Math.round((o.filled / o.qty) * 100) : 0
  const slip        = calcSlippage(o)
  const slipColor   = slip == null ? t.textDim
    : (o.side === 'BUY' ? (slip > 0 ? t.bear : t.bull) : (slip < 0 ? t.bear : t.bull))

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: GRID_COLS,
      padding: '3px 8px',
      borderBottom: isModifying
        ? `1px solid ${t.amber}40`
        : `1px solid ${isModern ? 'rgba(0,200,255,0.06)' : t.border}`,
      alignItems: 'center',
      fontSize: 9,
      fontFamily: t.font,
      background: isModifying
        ? `${t.amber}06`
        : o._updatedAt && Date.now() - o._updatedAt < 800
          ? (isModern ? 'rgba(0,200,255,0.06)' : 'rgba(255,140,0,0.04)')
          : 'transparent',
    }}>
      {/* Time */}
      <span style={{ color: t.textMuted }}>{o.time}</span>

      {/* Symbol + exchange sub-label */}
      <div>
        <div style={{ color: t.cyan, fontWeight: 500, textShadow: isModern ? `0 0 6px ${t.cyan}60` : 'none' }}>{o.symbol}</div>
        <div style={{ color: t.textDim, fontSize: 8 }}>{o.exch} · {o.product}</div>
      </div>

      {/* Side */}
      <span style={{ color: SIDE_COLOR(o.side, t), fontWeight: 600 }}>{o.side}</span>

      {/* Type */}
      <span style={{ color: t.textDim }}>{o.type}</span>

      {/* Qty */}
      <span style={{ color: t.text, textAlign: 'right' }}>{o.qty}</span>

      {/* Price */}
      <span style={{ color: t.textMuted, textAlign: 'right' }}>
        {o.price ? o.price.toLocaleString() : 'MKT'}
      </span>

      {/* Filled qty + mini progress bar */}
      <div style={{ textAlign: 'right' }}>
        <span style={{ color: fillPct === 100 ? t.bull : fillPct > 0 ? t.cyan : t.textMuted }}>
          {o.filled}/{o.qty}
        </span>
        {o.qty > 0 && fillPct > 0 && fillPct < 100 && (
          <div style={{ height: 2, background: t.bgActive, borderRadius: 1, marginTop: 1 }}>
            <div style={{ width: `${fillPct}%`, height: '100%', background: t.cyan, borderRadius: 1 }} />
          </div>
        )}
      </div>

      {/* Avg fill + slippage sub-label */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ color: t.textMuted }}>{o.avg_fill ? o.avg_fill.toLocaleString() : '—'}</div>
        {slip != null && (
          <div style={{ color: slipColor, fontSize: 8 }}>
            {slip > 0 ? '+' : ''}{slip.toFixed(2)} slip
          </div>
        )}
      </div>

      {/* Status badge */}
      <span style={{ color: statusColor, fontWeight: 600, textShadow: isModern ? `0 0 6px ${statusColor}` : 'none', textAlign: 'right' }}>
        {o.status}
      </span>

      {/* Action buttons: modify + cancel */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
        {canModify && (
          <button
            onClick={() => onModify(o)}
            title="Modify order"
            style={{
              background: isModifying ? `${t.amber}20` : 'none',
              border: `1px solid ${isModifying ? t.amber : t.amber + '50'}`,
              color: t.amber,
              fontSize: 8, padding: '2px 4px',
              cursor: 'pointer', borderRadius: 2, fontFamily: t.font,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.12s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = `${t.amber}20` }}
            onMouseLeave={e => { if (!isModifying) e.currentTarget.style.background = 'none' }}
          >
            <PencilIcon />
          </button>
        )}
        {canCancel ? (
          <button
            onClick={() => onCancel(o)}
            disabled={cancelling === o.id}
            title="Cancel order"
            style={{
              background: 'none', border: `1px solid ${t.bear}60`, color: t.bear,
              fontSize: 8, padding: '1px 4px', cursor: cancelling === o.id ? 'not-allowed' : 'pointer',
              borderRadius: 2, fontFamily: t.font, opacity: cancelling === o.id ? 0.4 : 1,
              transition: 'all 0.12s',
            }}
            onMouseEnter={e => { if (cancelling !== o.id) e.currentTarget.style.background = `${t.bear}18` }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
          >
            {cancelling === o.id ? '…' : '✕'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export default function OrderBlotter({ compact = false, maxRows = null }) {
  const orders      = useDataStore((s) => s.orders)
  const updateOrder = useDataStore((s) => s.updateOrder)
  const filter      = useTerminalStore((s) => s.ordersFilter)
  const setFilter   = useTerminalStore((s) => s.setOrdersFilter)
  const openTicket  = useTerminalStore((s) => s.openOrderTicket)
  const t = useTheme()
  const isModern = t.name === 'modern'
  const [cancelling,       setCancelling]       = useState(null)
  const [cancelAllPending, setCancelAllPending] = useState(false)
  const [modifyingId,      setModifyingId]      = useState(null)
  const [modifyForm,       setModifyForm]       = useState({ price: '', qty: '' })
  const [modifyPending,    setModifyPending]    = useState(false)

  const rows = orders

  const filtered = rows.filter(o => {
    if (filter === 'OPEN') return ['PENDING', 'OPEN', 'TRIGGERED', 'PARTIAL'].includes(o.status)
    return o.status === filter
  })

  const limit   = maxRows ?? (compact ? 8 : null)
  const display = limit ? filtered.slice(0, limit) : filtered

  const openOrders = rows.filter(o => ['PENDING', 'OPEN', 'TRIGGERED', 'PARTIAL'].includes(o.status))
  const pending    = openOrders.length
  const filled     = rows.filter(o => o.status === 'FILLED').length

  const handleCancel = useCallback(async (order) => {
    const id     = typeof order === 'object' ? order.id     : order
    const market = typeof order === 'object' ? (order.market || 'india') : 'india'
    setCancelling(id)
    try {
      await cancelOrder(id, market)
      updateOrder(id, { status: 'CANCELLED' })
      toast.success(`Order ${id} cancelled`)
    } catch {
      toast.error('Cancel failed')
    } finally {
      setCancelling(null)
    }
  }, [updateOrder])

  const handleOpenModify = useCallback((o) => {
    if (modifyingId === o.id) {
      setModifyingId(null)
      return
    }
    setModifyForm({ price: o.price ?? '', qty: o.qty ?? '' })
    setModifyingId(o.id)
  }, [modifyingId])

  const handleModify = useCallback(async () => {
    const price = parseFloat(modifyForm.price)
    const qty   = parseInt(modifyForm.qty, 10)
    if (!modifyingId || isNaN(price) || price <= 0 || isNaN(qty) || qty <= 0) {
      toast.error('Enter a valid price and quantity')
      return
    }
    setModifyPending(true)
    try {
      await modifyOrder(modifyingId, { price, qty })
      updateOrder(modifyingId, { price, qty })
      toast.success('Order modified')
      setModifyingId(null)
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Modify failed')
    } finally {
      setModifyPending(false)
    }
  }, [modifyingId, modifyForm, updateOrder])

  const handleCancelAll = useCallback(async () => {
    if (openOrders.length === 0) return
    setCancelAllPending(false)
    const results = await Promise.allSettled(
      openOrders.map(o => cancelOrder(o.id, o.market || 'india').then(() => updateOrder(o.id, { status: 'CANCELLED' })))
    )
    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed    = results.length - succeeded
    if (succeeded > 0) toast.success(`${succeeded} order${succeeded > 1 ? 's' : ''} cancelled`)
    if (failed > 0)    toast.error(`${failed} cancel${failed > 1 ? 's' : ''} failed`)
  }, [openOrders, updateOrder])

  const COLS = ['TIME', 'SYMBOL', 'SIDE', 'TYPE', 'QTY', 'PRICE', 'FILLED', 'AVG FILL', 'STATUS', 'ACTIONS']

  return (
    <div style={{ background: t.bgPanel, display: 'flex', flexDirection: 'column', overflow: 'hidden', backdropFilter: isModern ? t.panelGlass : 'none' }}>

      {/* Cancel All confirmation banner */}
      {cancelAllPending && (
        <div style={{
          padding: '8px 16px', background: `${t.bear}18`,
          borderBottom: `1px solid ${t.bear}40`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ flex: 1, fontSize: 11, color: t.bear, fontFamily: t.fontUI, fontWeight: 600 }}>
            Cancel all {pending} open order{pending > 1 ? 's' : ''}?
          </span>
          <button
            onClick={handleCancelAll}
            style={{ padding: '4px 12px', fontSize: 11, fontWeight: 700, fontFamily: t.fontUI, background: t.bear, border: 'none', color: '#fff', borderRadius: t.radius, cursor: 'pointer' }}
          >CONFIRM</button>
          <button
            onClick={() => setCancelAllPending(false)}
            style={{ padding: '4px 10px', fontSize: 11, fontFamily: t.fontUI, background: 'transparent', border: `1px solid ${t.border}`, color: t.textMuted, borderRadius: t.radius, cursor: 'pointer' }}
          >CANCEL</button>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${t.border}`, height: 44, padding: '0 16px', flexShrink: 0, gap: 10 }}>
        <span style={{ color: t.text, fontSize: 13, fontWeight: 700, fontFamily: t.fontUI, letterSpacing: -0.2 }}>Orders</span>
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontUI, background: t.bgActive, padding: '2px 8px', borderRadius: 20 }}>
          {pending} pending · {filled} filled
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Cancel All button — only shown when open orders exist */}
          {pending > 0 && (
            <button
              onClick={() => setCancelAllPending(true)}
              style={{
                padding: '4px 10px', height: 28,
                background: `${t.bear}14`, border: `1px solid ${t.bear}50`,
                borderRadius: t.radius, color: t.bear,
                fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: t.fontUI,
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = `${t.bear}28` }}
              onMouseLeave={e => { e.currentTarget.style.background = `${t.bear}14` }}
              title={`Cancel all ${pending} open orders`}
            >Cancel All ({pending})</button>
          )}

          {FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '4px 10px', height: 28,
                background: filter === f ? t.accentBg : 'transparent',
                border: `1px solid ${filter === f ? t.accent : t.border}`,
                borderRadius: t.radius,
                color: filter === f ? t.accent : t.textMuted,
                fontSize: 11, fontWeight: filter === f ? 600 : 400,
                cursor: 'pointer', fontFamily: t.fontUI, transition: 'all 0.12s',
              }}
            >{f}</button>
          ))}
          <button
            onClick={() => openTicket(null, 'BUY')}
            style={{
              padding: '0 14px', height: 28, background: t.bullBg,
              border: `1px solid ${t.bull}40`, borderRadius: t.radius,
              color: t.bull, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: t.fontUI,
            }}
            title="New Order (Ctrl+O)"
          >+ Order</button>
        </div>
      </div>

      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: GRID_COLS,
        padding: '5px 8px', borderBottom: `1px solid ${t.border}`,
        fontSize: 10, color: t.textMuted, letterSpacing: 0.3,
        flexShrink: 0, fontFamily: t.fontUI, fontWeight: 500,
      }}>
        {COLS.map((c, i) => (
          <span key={c} style={{ textAlign: i >= 4 ? 'right' : 'left' }}>{c}</span>
        ))}
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {display.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 60, color: t.textDim, fontSize: 10, fontFamily: t.font }}>
            NO ORDERS
          </div>
        ) : display.map(o => (
          <div key={o.id}>
            <OrderRow
              o={o}
              onCancel={handleCancel}
              onModify={handleOpenModify}
              modifyingId={modifyingId}
              t={t}
              isModern={isModern}
              cancelling={cancelling}
            />

            {/* Inline modify form — expands below the row */}
            {modifyingId === o.id && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px 8px 12px',
                background: `${t.amber}08`,
                borderBottom: `1px solid ${t.amber}30`,
                borderLeft: `2px solid ${t.amber}80`,
              }}>
                <span style={{ fontSize: 8, color: t.amber, fontFamily: t.fontUI, fontWeight: 700, minWidth: 44, letterSpacing: 0.4 }}>
                  MODIFY
                </span>

                <label style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>PRICE</label>
                <input
                  type="number"
                  step="0.01"
                  value={modifyForm.price}
                  onChange={e => setModifyForm(f => ({ ...f, price: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') handleModify(); if (e.key === 'Escape') setModifyingId(null) }}
                  autoFocus
                  style={{
                    width: 88, background: t.bgActive,
                    border: `1px solid ${t.amber}60`, color: t.text,
                    fontSize: 11, padding: '3px 6px', borderRadius: 2,
                    fontFamily: t.font, outline: 'none',
                  }}
                  onFocus={e => { e.target.style.borderColor = t.amber }}
                  onBlur={e => { e.target.style.borderColor = `${t.amber}60` }}
                />

                <label style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>QTY</label>
                <input
                  type="number"
                  step="1"
                  value={modifyForm.qty}
                  onChange={e => setModifyForm(f => ({ ...f, qty: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') handleModify(); if (e.key === 'Escape') setModifyingId(null) }}
                  style={{
                    width: 64, background: t.bgActive,
                    border: `1px solid ${t.amber}60`, color: t.text,
                    fontSize: 11, padding: '3px 6px', borderRadius: 2,
                    fontFamily: t.font, outline: 'none',
                  }}
                  onFocus={e => { e.target.style.borderColor = t.amber }}
                  onBlur={e => { e.target.style.borderColor = `${t.amber}60` }}
                />

                <button
                  onClick={handleModify}
                  disabled={modifyPending}
                  style={{
                    padding: '3px 12px', fontSize: 9, fontWeight: 700,
                    fontFamily: t.fontUI, background: `${t.amber}22`,
                    border: `1px solid ${t.amber}70`, color: t.amber,
                    borderRadius: 2, cursor: modifyPending ? 'not-allowed' : 'pointer',
                    opacity: modifyPending ? 0.6 : 1, transition: 'all 0.12s',
                  }}
                  onMouseEnter={e => { if (!modifyPending) e.currentTarget.style.background = `${t.amber}38` }}
                  onMouseLeave={e => { e.currentTarget.style.background = `${t.amber}22` }}
                >{modifyPending ? '…' : 'SAVE'}</button>

                <button
                  onClick={() => setModifyingId(null)}
                  style={{
                    padding: '3px 10px', fontSize: 9, fontFamily: t.fontUI,
                    background: 'none', border: `1px solid ${t.border}`,
                    color: t.textMuted, borderRadius: 2, cursor: 'pointer',
                    transition: 'all 0.12s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = t.textDim }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = t.border }}
                >DISCARD</button>

                <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginLeft: 4 }}>
                  Enter to save · Esc to discard
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
