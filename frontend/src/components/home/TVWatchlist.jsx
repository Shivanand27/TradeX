// src/components/home/TVWatchlist.jsx
// Modern watchlist sidebar: grouped by asset class, live prices, B/S buttons.
// Collapsed: 44px icon strip. Expanded: 220px.

import { useState, useRef, useEffect } from 'react'
import { useDataStore, useTerminalStore, useTheme } from '../../store'
import { getPrices } from '../../lib/api'

const SYMBOL_SUGGESTIONS = {
  india: [
    'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','AXISBANK','WIPRO','MARUTI',
    'BAJFINANCE','TATAMOTORS','SBIN','LT','KOTAKBANK','ASIANPAINT','TITAN',
    'NESTLEIND','ONGC','POWERGRID','ULTRACEMCO','SUNPHARMA','DRREDDY','DIVISLAB',
    'CIPLA','BHARTIARTL','JSWSTEEL','TATASTEEL','HINDALCO','COALINDIA','NTPC',
    'ADANIPORTS','ADANIENT','BAJAJFINSV','HCLTECH','TECHM','GRASIM','INDUSINDBK',
    'EICHERMOT','HEROMOTOCO','BPCL','IOC','M&M','TATACONSUM','APOLLOHOSP',
    'HINDUNILVR','BRITANNIA','ITC','PIDILITIND','DMART','NIFTY50','BANKNIFTY',
  ],
  crypto: [
    'BTCUSD','ETHUSD','SOLUSD','BNBUSD','XRPUSD','AVAXUSD','ADAUSD','DOTUSD',
    'LINKUSD','MATICUSD','LTCUSD','UNIUSD','AAVEUSD','ATOMUSD','NEARUSD',
    'FILUSD','ALGOUSD','ICPUSD','TRXUSD','XLMUSD','VETUSD','FTMUSD','SANDUSD',
    'MANAUSD','AXSUSD','GALAUSD','APEUSD','SHIBUSD','DOGEUSD','PEPE',
  ],
  fo: [
    'NIFTY-FUT','BANKNIFTY-FUT','FINNIFTY-FUT','RELIANCE-FUT','TCS-FUT',
    'HDFCBANK-FUT','INFY-FUT','ICICIBANK-FUT','WIPRO-FUT','SBIN-FUT',
    'AXISBANK-FUT','TATAMOTORS-FUT','BAJFINANCE-FUT','LT-FUT','KOTAKBANK-FUT',
  ],
  commodities: [
    'GOLD','SILVER','CRUDEOIL','NATURALGAS','COPPER','ALUMINIUM','ZINC',
    'NICKEL','LEAD','COTTON','CASTOR','PEPPER','TURMERIC','CARDAMOM',
  ],
}

const GROUP_DEFS = [
  { key: 'india',       label: 'India NSE/BSE', icon: '🇮🇳', colorKey: 'accent',  market: 'india',     prefix: '₹' },
  { key: 'crypto',      label: 'Crypto Perps',  icon: '₿',  colorKey: 'purple',  market: 'crypto',    prefix: '$' },
  { key: 'fo',          label: 'NSE F&O',       icon: 'Φ',  colorKey: 'cyan',    market: 'india_fo',  prefix: '₹' },
  { key: 'commodities', label: 'Commodities',   icon: '⚡',  colorKey: 'amber',   market: 'commodity', prefix: '₹' },
]

function groupColor(key, t) {
  return { india: t.accent, crypto: t.purple, fo: t.cyan, commodities: t.amber }[key] || t.accent
}

function fmt(price, prefix) {
  if (price == null) return '—'
  const n = parseFloat(price)
  if (isNaN(n)) return String(price)
  if (n >= 100000) return `${prefix}${(n / 100000).toFixed(2)}L`
  if (n >= 1000)   return `${prefix}${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  if (n < 1)       return `${prefix}${n.toFixed(5)}`
  return `${prefix}${n.toFixed(2)}`
}

function SymbolRow({ sym, market, prefix, t, isActive, onSelect, onBuy, onSell, onRemove }) {
  const [hovered, setHovered]  = useState(false)
  const tickers  = useDataStore(s => s.tickers)
  // Try several key formats: WS sends BTCUSDT / RELIANCE.NS, but watchlist stores BTCUSD / RELIANCE
  const tick     = tickers[sym]
    || tickers[sym + '.NS']                    // india: RELIANCE → RELIANCE.NS
    || tickers[sym.replace(/USD$/, 'USDT')]    // crypto: BTCUSD → BTCUSDT
    || tickers[sym.replace('.NS', '')]         // reverse (safety)
  const price    = tick?.price
  const change   = tick?.change ?? tick?.chg
  const chgNum   = parseFloat(String(change || '').replace(/[^0-9.-]/g, ''))
  const positive = !isNaN(chgNum) && chgNum >= 0
  const chgColor = isNaN(chgNum) || !change || change === '—' ? t.textDim : positive ? t.bull : t.bear
  const _priceNum = typeof price === 'number' ? price : parseFloat(String(price || '').replace(/[^0-9.]/g, ''))
  const displayed = fmt(isNaN(_priceNum) ? null : _priceNum, prefix)

  return (
    <div
      onClick={() => onSelect(sym, market)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display:     'flex',
        alignItems:  'center',
        padding:     '7px 10px',
        gap:         6,
        cursor:      'pointer',
        background:  isActive ? t.bgActive : hovered ? 'rgba(255,255,255,0.03)' : 'transparent',
        borderLeft:  isActive ? `2px solid ${t.accent}` : '2px solid transparent',
        borderRadius:`0 ${t.radius}px ${t.radius}px 0`,
        transition:  'background 0.1s',
        position:    'relative',
      }}
    >
      {/* Symbol + change */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: t.text, fontFamily: t.font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sym}
        </div>
        <div style={{ fontSize: 9, color: chgColor, fontFamily: t.font, marginTop: 1 }}>
          {change && change !== '—' ? `${positive ? '+' : ''}${chgNum.toFixed(2)}%` : '—'}
        </div>
      </div>

      {/* Price */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: t.text, fontFamily: t.font }}>{displayed}</div>
      </div>

      {/* B/S/× buttons — show on hover */}
      {hovered ? (
        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          <button
            onClick={e => { e.stopPropagation(); onBuy(sym) }}
            style={{
              background: t.bullBg, border: `1px solid ${t.bull}40`, color: t.bull,
              fontSize: 8, padding: '2px 5px', cursor: 'pointer',
              borderRadius: t.radiusSm, fontFamily: t.font, fontWeight: 700,
            }}
          >B</button>
          <button
            onClick={e => { e.stopPropagation(); onSell(sym) }}
            style={{
              background: t.bearBg, border: `1px solid ${t.bear}40`, color: t.bear,
              fontSize: 8, padding: '2px 5px', cursor: 'pointer',
              borderRadius: t.radiusSm, fontFamily: t.font, fontWeight: 700,
            }}
          >S</button>
          <button
            onClick={e => { e.stopPropagation(); onRemove() }}
            title="Remove from watchlist"
            style={{
              background: 'transparent', border: `1px solid ${t.border}`, color: t.textDim,
              fontSize: 10, padding: '2px 5px', cursor: 'pointer',
              borderRadius: t.radiusSm, fontFamily: t.font, lineHeight: 1,
            }}
          >×</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 2, flexShrink: 0, opacity: 0.4 }}>
          <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font, padding: '2px 4px' }}>B</span>
          <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font, padding: '2px 4px' }}>S</span>
        </div>
      )}
    </div>
  )
}

function GroupSection({ group, t, activeSymbol, onSelect, onBuy, onSell, onRemove }) {
  const [collapsed, setCollapsed] = useState(false)
  const symbols = useTerminalStore(s => s.watchlistSidebarSymbols[group.key] || [])
  const color   = groupColor(group.key, t)

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 10px', cursor: 'pointer',
          borderRadius: t.radius, margin: '0 4px',
        }}
        onMouseEnter={e => e.currentTarget.style.background = `rgba(255,255,255,0.03)`}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 3, height: 12, background: color, borderRadius: 2, flexShrink: 0 }} />
          <span style={{ fontSize: 10, fontWeight: 600, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.3 }}>
            {group.label.toUpperCase()}
          </span>
          <span style={{ fontSize: 9, color: t.textDim }}>({symbols.length})</span>
        </div>
        <span style={{ fontSize: 9, color: t.textDim }}>{collapsed ? '▶' : '▼'}</span>
      </div>
      {!collapsed && symbols.map(sym => (
        <SymbolRow
          key={sym} sym={sym} market={group.market} prefix={group.prefix}
          t={t} isActive={activeSymbol === sym}
          onSelect={onSelect} onBuy={onBuy} onSell={onSell}
          onRemove={() => onRemove(group.key, sym)}
        />
      ))}
    </div>
  )
}

export default function TVWatchlist() {
  const t             = useTheme()
  const open          = useTerminalStore(s => s.watchlistSidebarOpen)
  const toggle        = useTerminalStore(s => s.toggleWatchlistSidebar)
  const activeSignal  = useTerminalStore(s => s.activeSignal)
  const setActiveSignal = useTerminalStore(s => s.setActiveSignal)
  const openTicket    = useTerminalStore(s => s.openOrderTicket)
  const addSymbol     = useTerminalStore(s => s.addWatchlistSymbol)
  const removeSymbol  = useTerminalStore(s => s.removeWatchlistSymbol)
  const updateTicker  = useDataStore(s => s.updateTicker)

  // Seed tickers store on mount and every 60 s — covers off-hours and cold starts
  // where the WebSocket hasn't pushed prices yet.
  useEffect(() => {
    let cancelled = false

    async function fetchAll() {
      const { india: indiaSyms = [], commodities: commSyms = [] } =
        useTerminalStore.getState().watchlistSidebarSymbols ?? {}

      const fetches = [
        indiaSyms.length  ? getPrices(indiaSyms,  'india')     : null,
        commSyms.length   ? getPrices(commSyms,   'commodity') : null,
      ]

      const [indiaRes, commRes] = await Promise.allSettled(fetches)

      if (cancelled) return

      for (const res of [indiaRes, commRes]) {
        if (res?.status !== 'fulfilled' || !res.value) continue
        for (const [sym, tick] of Object.entries(res.value?.prices ?? {})) {
          if (tick?.price == null) continue
          const pct = tick.change_pct ?? 0
          updateTicker(sym, {
            price:  tick.price,
            change: `${pct >= 0 ? '+' : ''}${Number(pct).toFixed(2)}%`,
          })
        }
      }
    }

    fetchAll()
    const timer = setInterval(fetchAll, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [updateTicker])

  const [addMode, setAddMode]   = useState(false)
  const [addGroup, setAddGroup] = useState('india')
  const [addInput, setAddInput] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputRef = useRef(null)

  const suggestions = addInput.trim().length >= 1
    ? (SYMBOL_SUGGESTIONS[addGroup] || []).filter(s =>
        s.toLowerCase().startsWith(addInput.trim().toLowerCase())
      ).slice(0, 8)
    : []

  function handleAdd(sym) {
    const val = (sym || addInput).trim().toUpperCase()
    if (!val) return
    addSymbol(addGroup, val)
    setAddInput(''); setAddMode(false); setShowSuggestions(false)
  }

  function handleInputChange(e) {
    setAddInput(e.target.value)
    setShowSuggestions(true)
  }

  function handleInputKeyDown(e) {
    if (e.key === 'Enter') handleAdd()
    if (e.key === 'Escape') { setShowSuggestions(false); setAddMode(false) }
  }

  // Close suggestions when clicking outside
  useEffect(() => {
    if (!showSuggestions) return
    function handleClick(e) {
      if (inputRef.current && !inputRef.current.closest('[data-add-form]')?.contains(e.target)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showSuggestions])

  const W = open ? 220 : 44

  return (
    <div style={{
      width: W, minWidth: W, background: t.bgPanel,
      borderRight: `1px solid ${t.border}`,
      display: 'flex', flexDirection: 'column',
      transition: 'width 0.2s ease, min-width 0.2s ease',
      overflow: 'hidden', flexShrink: 0,
    }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        justifyContent: open ? 'space-between' : 'center',
        height: 40, padding: open ? '0 10px' : 0,
        borderBottom: `1px solid ${t.border}`, flexShrink: 0,
      }}>
        {open && (
          <span style={{ fontSize: 11, fontWeight: 600, color: t.textMuted, fontFamily: t.fontUI }}>
            WATCHLIST
          </span>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          {open && (
            <button
              onClick={() => setAddMode(m => !m)}
              title="Add symbol"
              style={{
                background: t.accentBg, border: `1px solid ${t.accent}40`,
                color: t.accent, fontSize: 14, width: 24, height: 24,
                borderRadius: t.radius, cursor: 'pointer', lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >+</button>
          )}
          <button
            onClick={toggle}
            title={open ? 'Collapse' : 'Expand'}
            style={{
              background: 'rgba(255,255,255,0.04)', border: `1px solid ${t.border}`,
              color: t.textDim, fontSize: 10, width: 24, height: 24,
              borderRadius: t.radius, cursor: 'pointer', lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >{open ? '◀' : '▶'}</button>
        </div>
      </div>

      {/* Add form */}
      {open && addMode && (
        <div data-add-form style={{ padding: '8px 10px', borderBottom: `1px solid ${t.border}`, background: t.bgActive }}>
          <select
            value={addGroup} onChange={e => { setAddGroup(e.target.value); setAddInput(''); setShowSuggestions(false) }}
            style={{
              width: '100%', background: t.bgInput, border: `1px solid ${t.border}`,
              color: t.text, fontSize: 10, padding: '4px 6px',
              borderRadius: t.radius, fontFamily: t.fontUI, marginBottom: 6, outline: 'none',
            }}
          >
            {GROUP_DEFS.map(g => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
          <div style={{ position: 'relative', display: 'flex', gap: 4 }}>
            <input
              ref={inputRef}
              value={addInput}
              onChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              onFocus={() => addInput.trim().length >= 1 && setShowSuggestions(true)}
              placeholder="Symbol…"
              autoFocus
              style={{
                flex: 1, background: t.bgInput, border: `1px solid ${t.accent}60`,
                color: t.text, fontSize: 10, padding: '5px 8px',
                borderRadius: t.radius, fontFamily: t.font, outline: 'none',
              }}
            />
            <button
              onClick={() => handleAdd()}
              style={{
                background: t.accent, border: 'none', color: '#fff',
                fontSize: 10, padding: '5px 10px', cursor: 'pointer',
                borderRadius: t.radius, fontFamily: t.fontUI, fontWeight: 600,
              }}
            >ADD</button>
            {/* Suggestion dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0,
                width: 'calc(100% - 44px)',
                background: t.bgPanel, border: `1px solid ${t.accent}50`,
                borderRadius: t.radius, zIndex: 999, marginTop: 2,
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                overflow: 'hidden',
              }}>
                {suggestions.map(sym => (
                  <div
                    key={sym}
                    onMouseDown={e => { e.preventDefault(); handleAdd(sym) }}
                    style={{
                      padding: '6px 10px', fontSize: 10, color: t.text,
                      fontFamily: t.font, cursor: 'pointer',
                      borderBottom: `1px solid ${t.border}`,
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = t.bgActive}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <span style={{ color: t.accent, fontWeight: 600 }}>
                      {sym.slice(0, addInput.trim().length)}
                    </span>
                    {sym.slice(addInput.trim().length)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Groups list */}
      {open && (
        <div style={{ flex: 1, overflowY: 'auto', paddingTop: 4 }}>
          {GROUP_DEFS.map(group => (
            <GroupSection
              key={group.key} group={group} t={t}
              activeSymbol={activeSignal?.symbol}
              onSelect={(sym, mkt) => setActiveSignal({ symbol: sym, market: mkt })}
              onBuy={sym => openTicket(sym, 'BUY')}
              onSell={sym => openTicket(sym, 'SELL')}
              onRemove={removeSymbol}
            />
          ))}
        </div>
      )}

      {/* Collapsed icon strip */}
      {!open && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8, gap: 8 }}>
          {GROUP_DEFS.map((g, i) => {
            const colors = ['accent', 'purple', 'cyan', 'amber'].map(k => t[k])
            return (
              <div key={g.key} onClick={toggle} title={g.label} style={{
                width: 28, height: 28, borderRadius: t.radius,
                background: `${colors[i]}14`, color: colors[i],
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, cursor: 'pointer', border: `1px solid ${colors[i]}25`,
              }}>
                {g.icon}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
