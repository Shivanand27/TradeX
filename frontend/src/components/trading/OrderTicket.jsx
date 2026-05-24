// src/components/trading/OrderTicket.jsx
// Floating order entry overlay. Opened via Ctrl+O or the + ORDER button.
// Keyboard-driven: B/S = side, M/L = type, Enter = submit, Esc = close.
// Bracket order: entry + stop-loss + target in one form.
// Position sizer: Capital × Risk% / |Entry − SL| = Qty.
// Confirmation step: review before placing (prevents fat-finger submits).

import { useState, useEffect, useRef, useCallback } from 'react'
import toast from 'react-hot-toast'
import { placeOrder } from '../../lib/api'
import { useDataStore, useTerminalStore, useTheme } from '../../store'

const ORDER_TYPES = ['MARKET', 'LIMIT', 'SL', 'SL-M', 'IOC', 'FOK']
const PRODUCTS_NSE    = ['MIS', 'CNC', 'NRML']
const PRODUCTS_CRYPTO = ['Normal', 'Bracket']

function isNSE(sym) {
  const crypto = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'MATIC', 'AVAX', 'DOGE']
  return !crypto.some(c => sym?.toUpperCase().startsWith(c))
}

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export default function OrderTicket() {
  const open     = useTerminalStore((s) => s.orderTicketOpen)
  const initSym  = useTerminalStore((s) => s.orderTicketSymbol)
  const initSide = useTerminalStore((s) => s.orderTicketSide)
  const close    = useTerminalStore((s) => s.closeOrderTicket)
  const addOrder = useDataStore((s) => s.addOrder)
  const tickers  = useDataStore((s) => s.tickers)
  const t = useTheme()

  const [symbol,      setSymbol]      = useState('')
  const [side,        setSide]        = useState('BUY')
  const [type,        setType]        = useState('LIMIT')
  const [qty,         setQty]         = useState('')
  const [price,       setPrice]       = useState('')
  const [trigger,     setTrigger]     = useState('')
  const [product,     setProduct]     = useState('MIS')
  const [submitting,  setSubmitting]  = useState(false)

  // Bracket order
  const [bracketMode, setBracketMode] = useState(false)
  const [stopLoss,    setStopLoss]    = useState('')
  const [target,      setTarget]      = useState('')

  // Position sizer
  const [showSizer,   setShowSizer]   = useState(false)
  const [capital,     setCapital]     = useState('500000')
  const [riskPct,     setRiskPct]     = useState('1')

  // Confirmation step
  const [confirmStep, setConfirmStep] = useState(false)

  const symbolRef = useRef(null)
  const qtyRef    = useRef(null)

  useEffect(() => {
    if (open) {
      const sym = initSym || ''
      setSymbol(sym)
      setSide(initSide || 'BUY')
      setType('LIMIT')
      setQty('')
      setTrigger('')
      setStopLoss('')
      setTarget('')
      setProduct(isNSE(sym) ? 'MIS' : 'Normal')
      setBracketMode(false)
      setShowSizer(false)
      setConfirmStep(false)
      const ltp = tickers[sym]?.price
      setPrice(ltp ? String(ltp) : '')
      setTimeout(() => (sym ? qtyRef.current?.focus() : symbolRef.current?.focus()), 60)
    }
  }, [open, initSym, initSide, tickers])

  const ltpPrice = tickers[symbol?.toUpperCase()]?.price

  useEffect(() => {
    if (!open) return
    function handler(e) {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') { if (confirmStep) setConfirmStep(false); else close(); return }
      if (e.key === 'b' || e.key === 'B') { setSide('BUY');    e.preventDefault() }
      if (e.key === 's' || e.key === 'S') { setSide('SELL');   e.preventDefault() }
      if (e.key === 'm' || e.key === 'M') { setType('MARKET'); e.preventDefault() }
      if (e.key === 'l' || e.key === 'L') { setType('LIMIT');  e.preventDefault() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, close, confirmStep])

  const showPrice   = type !== 'MARKET' && type !== 'SL-M'
  const showTrigger = type === 'SL' || type === 'SL-M'

  const entryPrice = parseFloat(type === 'MARKET' ? ltpPrice : price) || 0
  const slPrice    = parseFloat(stopLoss) || 0
  const tgtPrice   = parseFloat(target) || 0

  // Auto-compute risk metrics
  const riskPerShare = entryPrice && slPrice ? Math.abs(entryPrice - slPrice) : 0
  const capitalF     = parseFloat(capital) || 0
  const riskPctF     = parseFloat(riskPct) || 1
  const suggestedQty = riskPerShare > 0 ? Math.floor((capitalF * riskPctF / 100) / riskPerShare) : 0
  const totalRisk    = suggestedQty > 0 ? suggestedQty * riskPerShare : parseFloat(qty || 0) * riskPerShare
  const rewardIfTgt  = tgtPrice && entryPrice && parseFloat(qty || 0) > 0
    ? Math.abs(tgtPrice - entryPrice) * parseFloat(qty)
    : null
  const rrRatio = riskPerShare > 0 && tgtPrice && entryPrice
    ? (Math.abs(tgtPrice - entryPrice) / riskPerShare).toFixed(2)
    : null

  const estimatedValue = qty && entryPrice
    ? parseFloat(qty) * entryPrice
    : null

  const handleReview = useCallback((e) => {
    e?.preventDefault()
    if (!symbol || !qty || parseFloat(qty) <= 0) {
      toast.error('Symbol and quantity required'); return
    }
    if (showPrice && (!price || parseFloat(price) <= 0)) {
      toast.error('Price required for ' + type); return
    }
    if (bracketMode) {
      if (!stopLoss || parseFloat(stopLoss) <= 0) { toast.error('Stop loss required for bracket order'); return }
      if (!target   || parseFloat(target)   <= 0) { toast.error('Target required for bracket order');    return }
      const sl  = parseFloat(stopLoss)
      const tgt = parseFloat(target)
      const ep  = entryPrice
      if (side === 'BUY'  && sl >= ep)  { toast.error('Stop loss must be below entry for BUY');  return }
      if (side === 'BUY'  && tgt <= ep) { toast.error('Target must be above entry for BUY');     return }
      if (side === 'SELL' && sl <= ep)  { toast.error('Stop loss must be above entry for SELL'); return }
      if (side === 'SELL' && tgt >= ep) { toast.error('Target must be below entry for SELL');    return }
    }
    setConfirmStep(true)
  }, [symbol, qty, price, showPrice, type, bracketMode, stopLoss, target, side, entryPrice])

  const handleConfirm = useCallback(async () => {
    setSubmitting(true)
    const payload = {
      symbol:    symbol.toUpperCase(),
      side,
      type,
      qty:       parseFloat(qty),
      price:     showPrice   ? parseFloat(price)   : null,
      trigger:   showTrigger ? parseFloat(trigger) : null,
      product,
      ...(bracketMode && {
        stop_loss: parseFloat(stopLoss),
        target:    parseFloat(target),
      }),
    }
    try {
      const result = await placeOrder(payload)
      addOrder({
        id:       result?.order_id || `ORD${Date.now()}`,
        time:     new Date().toTimeString().slice(0, 8),
        symbol:   payload.symbol,
        exch:     isNSE(payload.symbol) ? 'NSE' : 'DELTA',
        side:     payload.side,
        type:     payload.type,
        qty:      payload.qty,
        price:    payload.price,
        filled:   0,
        avg_fill: null,
        status:   'PENDING',
        product:  payload.product,
      })
      toast.success(`${side} ${qty} ${symbol.toUpperCase()} @ ${type === 'MARKET' ? 'MKT' : price}`)
      close()
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Order placement failed')
      setConfirmStep(false)
    } finally {
      setSubmitting(false)
    }
  }, [symbol, side, type, qty, price, trigger, product, showPrice, showTrigger, bracketMode, stopLoss, target, addOrder, close])

  if (!open) return null

  const isBuy      = side === 'BUY'
  const sideColor  = isBuy ? t.bull : t.bear
  const products   = isNSE(symbol) ? PRODUCTS_NSE : PRODUCTS_CRYPTO
  const currency   = isNSE(symbol) ? '₹' : '$'

  const inputStyle = {
    width: '100%', boxSizing: 'border-box',
    background: t.bgInput,
    border: `1px solid ${t.border}`,
    color: t.text,
    fontFamily: t.fontUI,
    fontSize: 13,
    padding: '8px 11px',
    borderRadius: t.radius,
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  }

  const labelStyle = {
    display: 'block',
    fontSize: 10,
    fontWeight: 600,
    color: t.textMuted,
    fontFamily: t.fontUI,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 5,
  }

  const focusHandlers = {
    onFocus: e => { e.target.style.borderColor = t.accent; e.target.style.boxShadow = `0 0 0 3px ${t.accentBg}` },
    onBlur:  e => { e.target.style.borderColor = t.border; e.target.style.boxShadow = 'none' },
  }

  const pillBtn = (active, color, label, onClick) => (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 10px', fontSize: 10, fontWeight: 600,
        fontFamily: t.fontUI, cursor: 'pointer', borderRadius: t.radius,
        border: `1px solid ${active ? color : t.border}`,
        background: active ? `${color}18` : 'transparent',
        color: active ? color : t.textDim,
        transition: 'all 0.12s',
        whiteSpace: 'nowrap',
      }}
    >{label}</button>
  )

  // ─── Confirmation view ───────────────────────────────────────────────────────
  if (confirmStep) {
    const rows = [
      ['Side',    <span style={{ color: sideColor, fontWeight: 700 }}>{side}</span>],
      ['Symbol',  <span style={{ color: t.text, fontWeight: 700 }}>{symbol.toUpperCase()}</span>],
      ['Type',    type],
      ['Qty',     qty],
      ['Price',   type === 'MARKET' ? 'MARKET' : `${currency}${fmt(price)}`],
      ...(showTrigger ? [['Trigger', `${currency}${fmt(trigger)}`]] : []),
      ...(bracketMode ? [
        ['Stop Loss', <span style={{ color: t.bear }}>{currency}{fmt(stopLoss)}</span>],
        ['Target',    <span style={{ color: t.bull }}>{currency}{fmt(target)}</span>],
        ...(rrRatio ? [['R:R Ratio', <span style={{ color: t.amber, fontWeight: 700 }}>1 : {rrRatio}</span>]] : []),
      ] : []),
      ['Product', product],
      ['Est. Value', estimatedValue != null ? `${currency}${estimatedValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'],
    ]

    return (
      <>
        <div onClick={() => setConfirmStep(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)', zIndex: 900 }} />
        <div className="fade-in" style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          zIndex: 901, width: 400,
          background: t.bgCard, border: `1px solid ${t.border}`, borderTop: `3px solid ${sideColor}`,
          borderRadius: t.radiusLg, boxShadow: t.shadowLg, overflow: 'hidden',
        }}>
          {/* Confirm header */}
          <div style={{ padding: '14px 18px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>⚠️</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>Review Order</span>
            </div>
            <button onClick={() => setConfirmStep(false)} style={{ background: 'transparent', border: 'none', color: t.textMuted, fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
          </div>

          {/* Order summary rows */}
          <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontUI, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase' }}>{label}</span>
                <span style={{ fontSize: 13, color: t.text, fontFamily: t.fontUI }}>{value}</span>
              </div>
            ))}
          </div>

          {/* Warning banner */}
          <div style={{ margin: '0 18px 14px', padding: '9px 12px', background: `${t.amber}14`, border: `1px solid ${t.amber}40`, borderRadius: t.radius }}>
            <span style={{ fontSize: 11, color: t.amber, fontFamily: t.fontUI }}>
              This order will be placed immediately. Verify all details before confirming.
            </span>
          </div>

          {/* Actions */}
          <div style={{ padding: '0 18px 18px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button
              type="button"
              onClick={() => setConfirmStep(false)}
              style={{
                padding: '11px 0', fontSize: 12, fontWeight: 700, fontFamily: t.fontUI,
                cursor: 'pointer', borderRadius: t.radius,
                border: `1px solid ${t.border}`, background: 'transparent', color: t.textMuted,
              }}
            >← BACK</button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
              style={{
                padding: '11px 0', fontSize: 12, fontWeight: 700, fontFamily: t.fontUI,
                cursor: submitting ? 'not-allowed' : 'pointer', borderRadius: t.radius,
                border: 'none', background: submitting ? `${sideColor}50` : sideColor,
                color: '#fff', opacity: submitting ? 0.7 : 1,
                boxShadow: submitting ? 'none' : `0 4px 12px ${sideColor}40`,
              }}
            >{submitting ? 'Placing…' : `CONFIRM ${side}`}</button>
          </div>
        </div>
      </>
    )
  }

  // ─── Main order form ─────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop */}
      <div onClick={close} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)', zIndex: 900 }} />

      {/* Ticket panel */}
      <div className="fade-in" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        zIndex: 901, width: 440,
        background: t.bgCard, border: `1px solid ${t.border}`, borderTop: `3px solid ${sideColor}`,
        borderRadius: t.radiusLg, boxShadow: t.shadowLg, overflow: 'hidden',
        maxHeight: '92vh', overflowY: 'auto',
      }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: `1px solid ${t.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: sideColor, boxShadow: `0 0 8px ${sideColor}80` }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: t.text, fontFamily: t.fontUI, letterSpacing: 0.3 }}>New Order</span>
            {bracketMode && (
              <span style={{ fontSize: 9, fontWeight: 700, color: t.amber, fontFamily: t.fontUI, background: `${t.amber}18`, border: `1px solid ${t.amber}40`, borderRadius: 4, padding: '2px 6px', letterSpacing: 0.5 }}>BRACKET</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {ltpPrice && (
              <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontUI }}>
                LTP <span style={{ color: t.text, fontWeight: 600 }}>{ltpPrice.toLocaleString()}</span>
              </span>
            )}
            <button
              onClick={close}
              style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${t.border}`, color: t.textMuted, width: 28, height: 28, borderRadius: t.radius, cursor: 'pointer', fontSize: 16, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.10)'; e.currentTarget.style.color = t.text }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = t.textMuted }}
            >×</button>
          </div>
        </div>

        <form onSubmit={handleReview} style={{ padding: '16px 18px' }}>

          {/* Symbol */}
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Symbol</label>
            <input
              ref={symbolRef}
              value={symbol}
              onChange={e => { setSymbol(e.target.value.toUpperCase()); setProduct(isNSE(e.target.value) ? 'MIS' : 'Normal') }}
              placeholder="RELIANCE / BTCUSD"
              autoComplete="off"
              style={inputStyle}
              {...focusHandlers}
            />
          </div>

          {/* Side toggle */}
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Side <span style={{ color: t.textDim, fontWeight: 400 }}>(B / S)</span></label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {['BUY', 'SELL'].map(s => {
                const active = side === s
                const col    = s === 'BUY' ? t.bull : t.bear
                const bg     = s === 'BUY' ? t.bullBg : t.bearBg
                return (
                  <button key={s} type="button" onClick={() => setSide(s)} style={{
                    padding: '9px 0', fontSize: 12, fontWeight: 700, fontFamily: t.fontUI,
                    cursor: 'pointer', borderRadius: t.radius,
                    border: `1px solid ${active ? col : t.border}`,
                    background: active ? bg : 'transparent',
                    color: active ? col : t.textDim, letterSpacing: 0.5, transition: 'all 0.12s',
                  }}>{s}</button>
                )
              })}
            </div>
          </div>

          {/* Order type + bracket toggle row */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Order Type</label>
              <div style={{ display: 'flex', gap: 5 }}>
                {pillBtn(bracketMode, t.amber, '⚡ Bracket', () => setBracketMode(v => !v))}
                {pillBtn(showSizer, t.cyan, '🎯 Sizer', () => setShowSizer(v => !v))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {ORDER_TYPES.map(ot => (
                <button key={ot} type="button" onClick={() => setType(ot)} style={{
                  padding: '5px 10px', fontSize: 10, fontWeight: 600, fontFamily: t.fontUI,
                  cursor: 'pointer', borderRadius: t.radius,
                  border: `1px solid ${type === ot ? t.accent : t.border}`,
                  background: type === ot ? t.accentBg : 'transparent',
                  color: type === ot ? t.accent : t.textDim, transition: 'all 0.12s',
                }}>{ot}</button>
              ))}
            </div>
          </div>

          {/* Position sizer panel */}
          {showSizer && (
            <div style={{ marginBottom: 12, padding: '12px', background: `${t.cyan}10`, border: `1px solid ${t.cyan}30`, borderRadius: t.radius }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: t.cyan, fontFamily: t.fontUI, letterSpacing: 0.5, marginBottom: 8 }}>POSITION SIZER</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={{ ...labelStyle, color: t.cyan }}>Capital ({currency})</label>
                  <input type="number" value={capital} onChange={e => setCapital(e.target.value)} placeholder="500000" style={{ ...inputStyle, borderColor: `${t.cyan}40` }} {...focusHandlers} />
                </div>
                <div>
                  <label style={{ ...labelStyle, color: t.cyan }}>Risk %</label>
                  <input type="number" value={riskPct} onChange={e => setRiskPct(e.target.value)} placeholder="1" step="0.1" min="0.1" max="10" style={{ ...inputStyle, borderColor: `${t.cyan}40` }} {...focusHandlers} />
                </div>
              </div>
              {suggestedQty > 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI }}>Suggested Qty: </span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: t.cyan, fontFamily: t.fontUI }}>{suggestedQty}</span>
                    <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI, marginLeft: 6 }}>
                      Risk: <span style={{ color: t.bear }}>{currency}{fmt(totalRisk, 0)}</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setQty(String(suggestedQty))}
                    style={{
                      padding: '4px 10px', fontSize: 10, fontWeight: 700, fontFamily: t.fontUI,
                      cursor: 'pointer', borderRadius: t.radius,
                      border: `1px solid ${t.cyan}`, background: `${t.cyan}20`, color: t.cyan,
                    }}
                  >APPLY</button>
                </div>
              ) : (
                <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI }}>
                  {bracketMode || stopLoss ? 'Enter entry price and stop loss to compute qty' : 'Enable Bracket or enter Stop Loss below'}
                </span>
              )}
            </div>
          )}

          {/* Qty + Price */}
          <div style={{ display: 'grid', gridTemplateColumns: showPrice ? '1fr 1fr' : '1fr', gap: 10, marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>Quantity</label>
              <input
                ref={qtyRef}
                type="number"
                value={qty}
                onChange={e => setQty(e.target.value)}
                placeholder="0"
                min="0"
                step="1"
                style={inputStyle}
                {...focusHandlers}
              />
            </div>
            {showPrice && (
              <div>
                <label style={labelStyle}>Price {ltpPrice && <span style={{ color: t.textDim, fontWeight: 400 }}>≈{ltpPrice.toLocaleString()}</span>}</label>
                <input
                  type="number"
                  value={price}
                  onChange={e => setPrice(e.target.value)}
                  placeholder="0.00"
                  step="0.01"
                  style={inputStyle}
                  {...focusHandlers}
                />
              </div>
            )}
          </div>

          {/* Trigger price (SL order type) */}
          {showTrigger && (
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Trigger Price</label>
              <input type="number" value={trigger} onChange={e => setTrigger(e.target.value)} placeholder="0.00" step="0.01" style={inputStyle} {...focusHandlers} />
            </div>
          )}

          {/* Bracket: Stop Loss + Target */}
          {bracketMode && (
            <div style={{ marginBottom: 12, padding: '12px', background: `${t.amber}08`, border: `1px solid ${t.amber}30`, borderRadius: t.radius }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: t.amber, fontFamily: t.fontUI, letterSpacing: 0.5, marginBottom: 8 }}>BRACKET LEGS</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={{ ...labelStyle, color: t.bear }}>Stop Loss ({currency})</label>
                  <input type="number" value={stopLoss} onChange={e => setStopLoss(e.target.value)} placeholder="0.00" step="0.01" style={{ ...inputStyle, borderColor: `${t.bear}40` }} {...focusHandlers} />
                </div>
                <div>
                  <label style={{ ...labelStyle, color: t.bull }}>Target ({currency})</label>
                  <input type="number" value={target} onChange={e => setTarget(e.target.value)} placeholder="0.00" step="0.01" style={{ ...inputStyle, borderColor: `${t.bull}40` }} {...focusHandlers} />
                </div>
              </div>
              {/* R:R display */}
              {riskPerShare > 0 && (
                <div style={{ display: 'flex', gap: 16 }}>
                  <span style={{ fontSize: 10, fontFamily: t.fontUI, color: t.textMuted }}>
                    Risk/share: <span style={{ color: t.bear }}>{currency}{fmt(riskPerShare)}</span>
                  </span>
                  {rrRatio && (
                    <span style={{ fontSize: 10, fontFamily: t.fontUI, color: t.textMuted }}>
                      R:R <span style={{ color: parseFloat(rrRatio) >= 2 ? t.bull : t.amber, fontWeight: 700 }}>1:{rrRatio}</span>
                      {parseFloat(rrRatio) < 1.5 && <span style={{ color: t.bear }}> ⚠ poor</span>}
                    </span>
                  )}
                  {rewardIfTgt != null && (
                    <span style={{ fontSize: 10, fontFamily: t.fontUI, color: t.textMuted }}>
                      Reward: <span style={{ color: t.bull }}>{currency}{fmt(rewardIfTgt, 0)}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Product */}
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Product</label>
            <div style={{ display: 'flex', gap: 5 }}>
              {products.map(prod => (
                <button key={prod} type="button" onClick={() => setProduct(prod)} style={{
                  padding: '5px 12px', fontSize: 10, fontWeight: 600, fontFamily: t.fontUI,
                  cursor: 'pointer', borderRadius: t.radius,
                  border: `1px solid ${product === prod ? t.cyan : t.border}`,
                  background: product === prod ? `${t.cyan}12` : 'transparent',
                  color: product === prod ? t.cyan : t.textDim, transition: 'all 0.12s',
                }}>{prod}</button>
              ))}
            </div>
          </div>

          {/* Estimated value */}
          {estimatedValue !== null && (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '9px 12px', marginBottom: 12,
              background: t.bgActive, border: `1px solid ${t.border}`, borderRadius: t.radius,
            }}>
              <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI, fontWeight: 600, letterSpacing: 0.3 }}>ESTIMATED VALUE</span>
              <span style={{ fontSize: 13, color: t.text, fontWeight: 700, fontFamily: t.fontUI }}>
                {currency}{estimatedValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            </div>
          )}

          {/* Review button (not submit — goes to confirm step) */}
          <button
            type="submit"
            style={{
              width: '100%', padding: '11px 0',
              fontSize: 13, fontWeight: 700, fontFamily: t.fontUI, letterSpacing: 0.3,
              cursor: 'pointer', borderRadius: t.radius, border: 'none',
              background: sideColor, color: '#fff',
              boxShadow: `0 4px 14px ${sideColor}40`, transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.1)' }}
            onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}
          >
            REVIEW ORDER → {side} {qty || '0'} {symbol || '—'}
          </button>

          {/* Keyboard hints */}
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center', gap: 14, fontSize: 10, color: t.textDim, fontFamily: t.fontUI }}>
            {[['ESC', 'close'], ['B/S', 'side'], ['M/L', 'type'], ['↵', 'review']].map(([k, v]) => (
              <span key={k}><span style={{ color: t.accent, fontWeight: 600 }}>{k}</span> {v}</span>
            ))}
          </div>
        </form>
      </div>
    </>
  )
}
