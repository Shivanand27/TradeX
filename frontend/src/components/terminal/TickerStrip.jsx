// src/components/terminal/TickerStrip.jsx
// Animated auto-scrolling ticker — India row + Crypto row.
// CSS animation defined in index.html (.ticker-track).

import { useMemo, useState } from 'react'
import { useDataStore, useTerminalStore, useTheme } from '../../store'

const INDIA_SYMBOLS = [
  { key: 'NIFTY50',   label: 'NIFTY 50',   prefix: '' },
  { key: 'BANKNIFTY', label: 'BANK NIFTY', prefix: '' },
  { key: 'INDIAVIX',  label: 'INDIA VIX',  prefix: '' },
  { key: 'USDINR',    label: 'USD/INR',    prefix: '₹' },
  { key: 'DXY',       label: 'DXY',        prefix: '' },
  { key: 'SENSEX',    label: 'SENSEX',     prefix: '' },
]

const CRYPTO_SYMBOLS = [
  { key: 'BTCUSD',  label: 'BTC',  prefix: '$' },
  { key: 'ETHUSD',  label: 'ETH',  prefix: '$' },
  { key: 'SOLUSD',  label: 'SOL',  prefix: '$' },
  { key: 'BNBUSD',  label: 'BNB',  prefix: '$' },
  { key: 'XRPUSD',  label: 'XRP',  prefix: '$' },
  { key: 'AVAXUSD', label: 'AVAX', prefix: '$' },
]

function fmtPrice(price, prefix) {
  if (price == null || price === '—') return '—'
  // Strip commas — backend may send pre-formatted strings like "56,000.75"
  // parseFloat("56,000.75") = 56 without this, causing the truncation bug
  const raw = typeof price === 'string' ? price.replace(/,/g, '') : price
  const n = parseFloat(raw)
  if (isNaN(n)) return String(price)
  if (n >= 1000)  return `${prefix}${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (n >= 100)   return `${prefix}${n.toFixed(2)}`
  if (n >= 1)     return `${prefix}${n.toFixed(3)}`
  if (n >= 0.01)  return `${prefix}${n.toFixed(4)}`
  return `${prefix}${n.toFixed(6)}`
}

function TickerItem({ label, symbolKey, price, change, accentColor, t, onSymbolClick }) {
  const [hov, setHov] = useState(false)
  const chgNum   = parseFloat(String(change || '').replace(/[^0-9.-]/g, ''))
  const positive = !isNaN(chgNum) && chgNum >= 0
  const chgColor = isNaN(chgNum) || change === '—' ? t.textDim : positive ? t.bull : t.bear
  const arrow    = isNaN(chgNum) || change === '—' ? '' : positive ? ' ▲' : ' ▼'

  return (
    <span
      onClick={() => onSymbolClick && onSymbolClick(symbolKey)}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={onSymbolClick ? `Click to trade ${symbolKey}` : undefined}
      style={{
        display:    'inline-flex',
        alignItems: 'center',
        gap:        6,
        padding:    '0 20px',
        borderRight:`1px solid ${t.border}`,
        height:     '100%',
        whiteSpace: 'nowrap',
        cursor:     onSymbolClick ? 'pointer' : 'default',
        background: hov && onSymbolClick ? `${accentColor}08` : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <span style={{ fontSize: 10, color: hov && onSymbolClick ? accentColor : accentColor, fontFamily: t.font, fontWeight: 500, letterSpacing: 0.3 }}>
        {label}
      </span>
      <span style={{ fontSize: 10, color: t.text, fontFamily: t.font }}>
        {price}
      </span>
      {change && change !== '—' && (
        <span style={{ fontSize: 9, color: chgColor, fontFamily: t.font }}>
          {!isNaN(chgNum) ? ((chgNum >= 0 ? '+' : '') + chgNum.toFixed(2) + '%') : change}
          {arrow}
        </span>
      )}
    </span>
  )
}

function TickerRow({ symbols, accentColor, t, onSymbolClick }) {
  const tickers = useDataStore(s => s.tickers)

  const items = useMemo(() => symbols.map(d => {
    const live = tickers[d.key] || tickers[d.label]
    return {
      label:     d.label,
      symbolKey: d.key,
      price:     fmtPrice(live?.price, d.prefix),
      change:    live?.change ?? '—',
    }
  }), [tickers, symbols])

  // Duplicate the list so the scroll loop is seamless
  const doubled = [...items, ...items]

  return (
    <div style={{
      height:      22,
      background:  t.bgPanel,
      borderBottom:`1px solid ${t.border}`,
      overflow:    'hidden',
      flexShrink:  0,
      display:     'flex',
      alignItems:  'center',
    }}>
      <div
        className="ticker-track"
        style={{ display: 'inline-flex', alignItems: 'center', height: '100%' }}
      >
        {doubled.map((item, i) => (
          <TickerItem key={i} {...item} accentColor={accentColor} t={t} onSymbolClick={onSymbolClick} />
        ))}
      </div>
    </div>
  )
}

export default function TickerStrip() {
  const t           = useTheme()
  const openTicket  = useTerminalStore(s => s.openOrderTicket)

  // Only India symbols trigger the order ticket (crypto tickers are index-like, not directly tradeable)
  const handleIndiaClick  = (sym) => openTicket(sym, 'BUY')
  const handleCryptoClick = (sym) => openTicket(sym, 'BUY')

  return (
    <>
      <TickerRow symbols={INDIA_SYMBOLS}  accentColor={t.accent} t={t} onSymbolClick={handleIndiaClick} />
      <TickerRow symbols={CRYPTO_SYMBOLS} accentColor={t.purple} t={t} onSymbolClick={handleCryptoClick} />
    </>
  )
}
