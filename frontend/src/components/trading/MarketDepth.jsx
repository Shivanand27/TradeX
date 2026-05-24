// src/components/trading/MarketDepth.jsx
// Level 2 bid/ask ladder with volume bars and one-click order entry.
// Shows 5 bid + 5 ask levels. Symbol driven by activeSignal or depthSymbol.

import { useEffect, useRef } from 'react'
import { useDataStore, useTerminalStore, useTheme } from '../../store'
import { getMarketDepth } from '../../lib/api'

// Dev mock depth data keyed by symbol
const DEV_DEPTH = {
  RELIANCE: {
    bids: [
      { price: 3016.50, qty: 248,  orders: 5 },
      { price: 3015.00, qty: 512,  orders: 12 },
      { price: 3014.00, qty: 743,  orders: 18 },
      { price: 3013.00, qty: 1184, orders: 25 },
      { price: 3012.00, qty: 2001, orders: 40 },
    ],
    asks: [
      { price: 3018.00, qty: 302,  orders: 7 },
      { price: 3019.00, qty: 621,  orders: 14 },
      { price: 3020.00, qty: 855,  orders: 20 },
      { price: 3021.00, qty: 1122, orders: 28 },
      { price: 3022.00, qty: 1834, orders: 35 },
    ],
    ltp: 3018, ltpChg: '+0.62%',
  },
  BTCUSD: {
    bids: [
      { price: 88380, qty: 1.24, orders: 8 },
      { price: 88350, qty: 2.56, orders: 15 },
      { price: 88300, qty: 3.80, orders: 22 },
      { price: 88250, qty: 5.42, orders: 31 },
      { price: 88200, qty: 8.15, orders: 45 },
    ],
    asks: [
      { price: 88420, qty: 1.10, orders: 6 },
      { price: 88450, qty: 2.30, orders: 13 },
      { price: 88500, qty: 3.60, orders: 19 },
      { price: 88550, qty: 4.80, orders: 27 },
      { price: 88600, qty: 7.20, orders: 38 },
    ],
    ltp: 88420, ltpChg: '+1.87%',
  },
}

function getFallbackDepth(symbol) {
  if (!symbol) return null
  const base = symbol.replace('.NS', '').replace('.BO', '')
  return DEV_DEPTH[base] || null
}

function DepthLevel({ level, side, maxQty, onOrderClick, t, isModern }) {
  const isBid = side === 'bid'
  const barColor = isBid ? t.bull : t.bear
  const barPct = maxQty > 0 ? Math.min((level.qty / maxQty) * 100, 100) : 0
  const cumPct = maxQty > 0 ? Math.min((level.cumQty / maxQty) * 100, 100) : 0

  const formatPrice = (p) => p >= 10000
    ? p.toLocaleString()
    : p >= 100
      ? p.toFixed(2)
      : p.toFixed(4)

  const formatQty = (q) => q >= 1000 ? `${(q / 1000).toFixed(1)}K` : q % 1 !== 0 ? q.toFixed(3) : String(q)

  return (
    <div
      onClick={() => onOrderClick(level.price, isBid ? 'BUY' : 'SELL')}
      title={`${isBid ? 'BUY' : 'SELL'} at ${formatPrice(level.price)}`}
      style={{
        display: 'grid',
        gridTemplateColumns: isBid ? '1fr 1fr 1fr' : '1fr 1fr 1fr',
        padding: '2px 6px',
        fontSize: 9,
        fontFamily: t.font,
        cursor: 'pointer',
        position: 'relative',
        borderBottom: `1px solid ${isModern ? 'rgba(0,200,255,0.04)' : t.bgActive}`,
        alignItems: 'center',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = isModern ? 'rgba(255,255,255,0.04)' : t.bgRow}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      {/* Volume bar background */}
      <div style={{
        position: 'absolute',
        [isBid ? 'right' : 'left']: 0,
        top: 0, bottom: 0,
        width: `${barPct}%`,
        background: `${barColor}${isModern ? '18' : '10'}`,
        pointerEvents: 'none',
      }} />
      {/* Cumulative volume bar */}
      <div style={{
        position: 'absolute',
        [isBid ? 'right' : 'left']: 0,
        top: 0, bottom: 0,
        width: `${cumPct}%`,
        background: `${barColor}08`,
        borderRight: isBid ? 'none' : `1px solid ${barColor}20`,
        borderLeft: isBid ? `1px solid ${barColor}20` : 'none',
        pointerEvents: 'none',
      }} />

      {isBid ? (
        <>
          <span style={{ color: t.textMuted, textAlign: 'left', zIndex: 1 }}>
            {level.orders}
          </span>
          <span style={{ color: t.textMuted, textAlign: 'center', zIndex: 1 }}>
            {formatQty(level.qty)}
          </span>
          <span style={{ color: t.bull, fontWeight: 600, textAlign: 'right', zIndex: 1, textShadow: isModern ? `0 0 6px ${t.bull}60` : 'none' }}>
            {formatPrice(level.price)}
          </span>
        </>
      ) : (
        <>
          <span style={{ color: t.bear, fontWeight: 600, textAlign: 'left', zIndex: 1, textShadow: isModern ? `0 0 6px ${t.bear}60` : 'none' }}>
            {formatPrice(level.price)}
          </span>
          <span style={{ color: t.textMuted, textAlign: 'center', zIndex: 1 }}>
            {formatQty(level.qty)}
          </span>
          <span style={{ color: t.textMuted, textAlign: 'right', zIndex: 1 }}>
            {level.orders}
          </span>
        </>
      )}
    </div>
  )
}

export default function MarketDepth() {
  const depthSymbol  = useTerminalStore((s) => s.depthSymbol)
  const activeSignal = useTerminalStore((s) => s.activeSignal)
  const openTicket   = useTerminalStore((s) => s.openOrderTicket)
  const depth        = useDataStore((s) => s.depth)
  const updateDepth  = useDataStore((s) => s.updateDepth)
  const tickers      = useDataStore((s) => s.tickers)
  const t = useTheme()
  const isModern = t.name === 'modern'
  const pollRef = useRef(null)

  const symbol = depthSymbol || activeSignal?.symbol?.replace('.NS', '').replace('.BO', '') || 'RELIANCE'

  // Poll depth for current symbol every 2s
  useEffect(() => {
    async function fetchDepth() {
      try {
        const data = await getMarketDepth(symbol)
        updateDepth(symbol, data)
      } catch {
        // Silently fail — may not have backend endpoint yet
      }
    }
    if (!import.meta.env.DEV) {
      fetchDepth()
      pollRef.current = setInterval(fetchDepth, 2000)
    }
    return () => clearInterval(pollRef.current)
  }, [symbol, updateDepth])

  const data = depth[symbol] || (import.meta.env.DEV ? getFallbackDepth(symbol) : null)
  const livePrice = tickers[symbol]?.price

  if (!data) {
    return (
      <div style={{
        background: t.bgPanel,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        backdropFilter: isModern ? t.panelGlass : 'none',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center',
          background: t.headerGrad, borderBottom: `1px solid ${t.border}`,
          height: 22, flexShrink: 0,
        }}>
          <span style={{
            padding: '0 10px', color: t.accent, fontSize: 10, fontWeight: 500,
            letterSpacing: 0.4, fontFamily: t.font,
            textShadow: isModern ? t.glowAccent : 'none',
          }}>
            MARKET DEPTH · {symbol}
          </span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.textDim, fontSize: 10, fontFamily: t.font }}>
          SELECT A SYMBOL
        </div>
      </div>
    )
  }

  // Compute cumulative quantities
  let bidCum = 0
  const bidsWithCum = data.bids.map(b => { bidCum += b.qty; return { ...b, cumQty: bidCum } })
  let askCum = 0
  const asksWithCum = data.asks.map(a => { askCum += a.qty; return { ...a, cumQty: askCum } })

  const maxBid = bidsWithCum[bidsWithCum.length - 1]?.cumQty || 1
  const maxAsk = asksWithCum[asksWithCum.length - 1]?.cumQty || 1
  const maxQty = Math.max(maxBid, maxAsk)

  const totalBidQty = data.bids.reduce((s, b) => s + b.qty, 0)
  const totalAskQty = data.asks.reduce((s, a) => s + a.qty, 0)
  const bidPct = Math.round((totalBidQty / (totalBidQty + totalAskQty)) * 100)

  const ltp = livePrice || data.ltp
  const spread = data.asks[0]?.price && data.bids[0]?.price
    ? (data.asks[0].price - data.bids[0].price)
    : null

  return (
    <div style={{
      background: t.bgPanel,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      backdropFilter: isModern ? t.panelGlass : 'none',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        background: t.headerGrad, borderBottom: `1px solid ${t.border}`,
        height: 22, flexShrink: 0,
      }}>
        <span style={{
          padding: '0 10px', color: t.accent, fontSize: 10, fontWeight: 500,
          letterSpacing: 0.4, borderRight: `1px solid ${t.border}`,
          height: '100%', display: 'flex', alignItems: 'center',
          fontFamily: t.font, textShadow: isModern ? t.glowAccent : 'none',
        }}>
          DEPTH · {symbol}
        </span>
        {spread !== null && (
          <span style={{ padding: '0 8px', fontSize: 9, color: t.textDim, fontFamily: t.font }}>
            SPREAD: <span style={{ color: t.amber }}>{spread.toFixed(2)}</span>
          </span>
        )}
        <span style={{ marginLeft: 'auto', padding: '0 10px', fontSize: 9, color: t.textDim, fontFamily: t.font }}>
          CLICK LEVEL TO ORDER
        </span>
      </div>

      {/* Column headers */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        fontSize: 7, color: t.textDim, letterSpacing: 0.4,
        flexShrink: 0, fontFamily: t.font,
        borderBottom: `1px solid ${t.border}`,
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '3px 6px' }}>
          <span>ORDERS</span><span style={{ textAlign: 'center' }}>QTY</span><span style={{ textAlign: 'right', color: t.bull }}>BID</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '3px 6px', borderLeft: `1px solid ${t.border}` }}>
          <span style={{ color: t.bear }}>ASK</span><span style={{ textAlign: 'center' }}>QTY</span><span style={{ textAlign: 'right' }}>ORDERS</span>
        </div>
      </div>

      {/* Depth levels side by side */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        {/* Bids */}
        <div style={{ borderRight: `1px solid ${t.border}` }}>
          {bidsWithCum.map((level, i) => (
            <DepthLevel
              key={i} level={level} side="bid" maxQty={maxQty}
              onOrderClick={(p, s) => openTicket(symbol, s)}
              t={t} isModern={isModern}
            />
          ))}
        </div>
        {/* Asks */}
        <div>
          {asksWithCum.map((level, i) => (
            <DepthLevel
              key={i} level={level} side="ask" maxQty={maxQty}
              onOrderClick={(p, s) => openTicket(symbol, s)}
              t={t} isModern={isModern}
            />
          ))}
        </div>
      </div>

      {/* LTP + bid/ask ratio footer */}
      <div style={{
        display: 'flex', alignItems: 'center',
        borderTop: `1px solid ${t.border}`,
        height: 28, flexShrink: 0,
        padding: '0 8px', gap: 8,
      }}>
        {ltp && (
          <span style={{
            fontSize: 13, fontWeight: 700, color: t.text, fontFamily: t.font,
          }}>
            {ltp.toLocaleString()}
          </span>
        )}
        {data.ltpChg && (
          <span style={{
            fontSize: 9, color: data.ltpChg?.startsWith('+') ? t.bull : t.bear, fontFamily: t.font,
            textShadow: isModern ? `0 0 6px currentColor` : 'none',
          }}>{data.ltpChg}</span>
        )}

        {/* Bid/Ask pressure bar */}
        <div style={{ flex: 1, height: 4, background: t.bear + '40', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            width: `${bidPct}%`, height: '100%',
            background: t.bull,
            borderRadius: 2,
            transition: 'width 0.5s ease',
            boxShadow: isModern ? t.glowBull : 'none',
          }} />
        </div>
        <span style={{ fontSize: 8, color: t.bull, fontFamily: t.font }}>{bidPct}%</span>
        <span style={{ fontSize: 8, color: t.bear, fontFamily: t.font }}>{100 - bidPct}%</span>
      </div>
    </div>
  )
}
