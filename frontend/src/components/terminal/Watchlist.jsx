// src/components/terminal/Watchlist.jsx
// Tabbed institutional watchlist: India Equity · Crypto · NSE F&O · Commodities · Big Moves
// Each tab filters by asset class.  Every row has a TradingView shortcut button.
// Live LTP/CHG% overlaid from tickers WebSocket store — signal price is fallback only.

import { useMemo, useRef, useEffect, useState } from 'react'
import { useDataStore, useTerminalStore, useTheme } from '../../store'
import { EmptyState } from '../common/LoadingSkeleton'

// ── Tab definitions ───────────────────────────────────────────
const TABS = [
  { key: 'india',     label: 'INDIA NSE/BSE', markets: ['india', 'india_stock']           },
  { key: 'crypto',    label: 'CRYPTO',         markets: ['crypto']                         },
  { key: 'fo',        label: 'NSE F&O',        markets: ['india_fo'], tags: ['FUT','OPT']  },
  { key: 'commodity', label: 'COMMODITIES',    markets: ['commodity'], tags: ['MCX','NCDEX','COMEX'] },
  { key: 'bigmoves',  label: 'BIG MOVES',      filter: r => parseFloat(r.vol) >= 2.5       },
]

const FILTERS = ['ALL', 'GO', 'WATCH']

// ── Dev mock data per asset class ─────────────────────────────
const DEV_INDIA = [
  { symbol: 'RELIANCE',   name: 'Reliance Industries', market: 'india',  tag: 'NSE',   price: '₹3,018.00', chg: '+1.24', vol: '3.2', score: 8.4, verdict: 'GO',    entry_price: 3018,  smc_structure: 'choch_bullish' },
  { symbol: 'TCS',        name: 'Tata Consultancy',    market: 'india',  tag: 'NSE',   price: '₹3,890.00', chg: '+0.88', vol: '2.1', score: 7.6, verdict: 'GO',    entry_price: 3890,  smc_structure: 'bullish_bos'   },
  { symbol: 'HDFCBANK',   name: 'HDFC Bank',           market: 'india',  tag: 'NSE',   price: '₹1,736.00', chg: '-0.52', vol: '1.8', score: 6.1, verdict: 'WATCH', entry_price: 1736,  smc_structure: 'ranging'       },
  { symbol: 'INFY',       name: 'Infosys',             market: 'india',  tag: 'NSE',   price: '₹1,595.00', chg: '+0.33', vol: '1.4', score: 5.9, verdict: 'WATCH', entry_price: 1595,  smc_structure: 'choch_bearish' },
  { symbol: 'ICICIBANK',  name: 'ICICI Bank',          market: 'india',  tag: 'NSE',   price: '₹1,310.00', chg: '+0.62', vol: '2.5', score: 7.2, verdict: 'GO',    entry_price: 1310,  smc_structure: 'bullish_bos'   },
  { symbol: 'WIPRO',      name: 'Wipro Ltd',           market: 'india',  tag: 'NSE',   price: '₹512.00',   chg: '-0.18', vol: '1.2', score: 5.2, verdict: 'WATCH', entry_price: 512,   smc_structure: 'bearish_bos'   },
  { symbol: 'AXISBANK',   name: 'Axis Bank',           market: 'india',  tag: 'NSE',   price: '₹1,142.00', chg: '+1.05', vol: '2.8', score: 7.8, verdict: 'GO',    entry_price: 1142,  smc_structure: 'choch_bullish' },
  { symbol: 'MARUTI',     name: 'Maruti Suzuki',       market: 'india',  tag: 'NSE',   price: '₹12,450.00',chg: '+0.44', vol: '1.6', score: 6.4, verdict: 'WATCH', entry_price: 12450, smc_structure: 'ranging'       },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance',       market: 'india',  tag: 'NSE',   price: '₹6,820.00', chg: '+1.88', vol: '3.1', score: 8.1, verdict: 'GO',    entry_price: 6820,  smc_structure: 'bullish_bos'   },
  { symbol: 'TATAMOTORS', name: 'Tata Motors',         market: 'india',  tag: 'NSE',   price: '₹924.00',   chg: '+2.41', vol: '3.8', score: 8.6, verdict: 'GO',    entry_price: 924,   smc_structure: 'choch_bullish' },
  { symbol: 'NIFTY50',    name: 'Nifty 50 Index',      market: 'india',  tag: 'INDEX', price: '₹24,459.00',chg: '-0.48', vol: '—',   score: null,verdict: 'WATCH', entry_price: 24459 },
  { symbol: 'BANKNIFTY',  name: 'Bank Nifty Index',    market: 'india',  tag: 'INDEX', price: '₹57,235.00',chg: '-0.24', vol: '—',   score: null,verdict: 'WATCH', entry_price: 57235 },
]

const DEV_CRYPTO = [
  { symbol: 'BTCUSD',   name: 'Bitcoin Perpetual',   market: 'crypto', tag: 'PERP', price: '$88,420.00', chg: '+1.87', vol: '2.8', score: 7.9, verdict: 'GO',    entry_price: 88420,  smc_structure: 'bullish_bos'   },
  { symbol: 'ETHUSD',   name: 'Ethereum Perpetual',  market: 'crypto', tag: 'PERP', price: '$3,180.00',  chg: '-0.34', vol: '1.9', score: 5.8, verdict: 'WATCH', entry_price: 3180,   smc_structure: 'bearish_bos'   },
  { symbol: 'SOLUSD',   name: 'Solana Perpetual',    market: 'crypto', tag: 'PERP', price: '$148.50',    chg: '+2.41', vol: '3.5', score: 7.1, verdict: 'GO',    entry_price: 148.50, smc_structure: 'choch_bullish' },
  { symbol: 'BNBUSD',   name: 'BNB Perpetual',       market: 'crypto', tag: 'PERP', price: '$608.00',    chg: '+0.55', vol: '1.6', score: 5.5, verdict: 'WATCH', entry_price: 608,    smc_structure: 'ranging'       },
  { symbol: 'AVAXUSD',  name: 'Avalanche Perpetual', market: 'crypto', tag: 'PERP', price: '$36.80',     chg: '+3.12', vol: '4.1', score: 8.2, verdict: 'GO',    entry_price: 36.80,  smc_structure: 'choch_bullish' },
  { symbol: 'XRPUSD',   name: 'XRP Perpetual',       market: 'crypto', tag: 'PERP', price: '$2.18',      chg: '+0.92', vol: '2.3', score: 6.8, verdict: 'GO',    entry_price: 2.18,   smc_structure: 'bullish_bos'   },
  { symbol: 'ADAUSD',   name: 'Cardano Perpetual',   market: 'crypto', tag: 'PERP', price: '$0.7840',    chg: '+1.44', vol: '2.0', score: 6.2, verdict: 'WATCH', entry_price: 0.784,  smc_structure: 'ranging'       },
  { symbol: 'DOTUSD',   name: 'Polkadot Perpetual',  market: 'crypto', tag: 'PERP', price: '$7.24',      chg: '-1.02', vol: '1.7', score: 4.9, verdict: 'WATCH', entry_price: 7.24,   smc_structure: 'bearish_bos'   },
  { symbol: 'LINKUSD',  name: 'Chainlink Perpetual', market: 'crypto', tag: 'PERP', price: '$18.64',     chg: '+2.88', vol: '3.2', score: 7.5, verdict: 'GO',    entry_price: 18.64,  smc_structure: 'bullish_bos'   },
  { symbol: 'MATICUSD', name: 'Polygon Perpetual',   market: 'crypto', tag: 'PERP', price: '$0.5920',    chg: '+1.18', vol: '2.6', score: 6.9, verdict: 'GO',    entry_price: 0.592,  smc_structure: 'choch_bullish' },
]

const DEV_FO = [
  { symbol: 'NIFTY-FUT',     name: 'Nifty Futures (Apr)',     market: 'india_fo', tag: 'FUT', price: '₹24,485.00', chg: '-0.46', vol: '2.2', score: null, verdict: 'WATCH', entry_price: 24485  },
  { symbol: 'BANKNIFTY-FUT', name: 'BankNifty Futures (Apr)', market: 'india_fo', tag: 'FUT', price: '₹57,280.00', chg: '-0.21', vol: '2.5', score: null, verdict: 'WATCH', entry_price: 57280  },
  { symbol: 'FINNIFTY-FUT',  name: 'FinNifty Futures (Apr)',  market: 'india_fo', tag: 'FUT', price: '₹23,148.00', chg: '-0.38', vol: '1.8', score: null, verdict: 'WATCH', entry_price: 23148  },
  { symbol: 'RELIANCE-FUT',  name: 'Reliance Futures (Apr)',  market: 'india_fo', tag: 'FUT', price: '₹3,024.00',  chg: '+1.28', vol: '3.0', score: 8.2,  verdict: 'GO',    entry_price: 3024   },
  { symbol: 'TCS-FUT',       name: 'TCS Futures (Apr)',       market: 'india_fo', tag: 'FUT', price: '₹3,896.00',  chg: '+0.90', vol: '2.1', score: 7.4,  verdict: 'GO',    entry_price: 3896   },
  { symbol: 'NIFTY-CE-24500',name: 'NIFTY 24500 CE (Apr)',    market: 'india_fo', tag: 'OPT', price: '₹142.00',    chg: '+18.2', vol: '4.8', score: null, verdict: 'WATCH', entry_price: 142    },
  { symbol: 'NIFTY-PE-24000',name: 'NIFTY 24000 PE (Apr)',    market: 'india_fo', tag: 'OPT', price: '₹95.00',     chg: '+12.4', vol: '3.9', score: null, verdict: 'WATCH', entry_price: 95     },
]

const DEV_COMMODITY = [
  { symbol: 'GOLD',       name: 'Gold MCX',             market: 'commodity', tag: 'MCX',   price: '₹72,450',  chg: '+0.38', vol: '1.4', score: 6.8, verdict: 'GO',    entry_price: 72450  },
  { symbol: 'SILVER',     name: 'Silver MCX',           market: 'commodity', tag: 'MCX',   price: '₹88,200',  chg: '+0.62', vol: '1.8', score: 6.2, verdict: 'WATCH', entry_price: 88200  },
  { symbol: 'CRUDEOIL',   name: 'Crude Oil MCX',        market: 'commodity', tag: 'MCX',   price: '₹6,845',   chg: '-1.12', vol: '2.6', score: 5.4, verdict: 'WATCH', entry_price: 6845   },
  { symbol: 'NATURALGAS', name: 'Natural Gas MCX',      market: 'commodity', tag: 'MCX',   price: '₹248',     chg: '+2.84', vol: '3.4', score: 7.2, verdict: 'GO',    entry_price: 248    },
  { symbol: 'COPPER',     name: 'Copper MCX',           market: 'commodity', tag: 'MCX',   price: '₹842',     chg: '+0.45', vol: '1.5', score: 5.8, verdict: 'WATCH', entry_price: 842    },
  { symbol: 'ALUMINIUM',  name: 'Aluminium MCX',        market: 'commodity', tag: 'MCX',   price: '₹218',     chg: '-0.28', vol: '1.1', score: 4.6, verdict: 'WATCH', entry_price: 218    },
  { symbol: 'ZINC',       name: 'Zinc MCX',             market: 'commodity', tag: 'MCX',   price: '₹256',     chg: '+1.05', vol: '1.9', score: 5.5, verdict: 'WATCH', entry_price: 256    },
  { symbol: 'NICKEL',     name: 'Nickel MCX',           market: 'commodity', tag: 'MCX',   price: '₹1,842',   chg: '+1.62', vol: '2.1', score: 6.1, verdict: 'GO',    entry_price: 1842   },
  { symbol: 'LEAD',       name: 'Lead MCX',             market: 'commodity', tag: 'MCX',   price: '₹184',     chg: '-0.54', vol: '1.2', score: 4.2, verdict: 'WATCH', entry_price: 184    },
  { symbol: 'COTTON',     name: 'Cotton NCDEX',         market: 'commodity', tag: 'NCDEX', price: '₹56,400',  chg: '+0.18', vol: '0.9', score: 4.0, verdict: 'WATCH', entry_price: 56400  },
]

// Combined mock for BIG MOVES tab (derived dynamically, no separate array needed)
const ALL_DEV_MOCK = [...DEV_INDIA, ...DEV_CRYPTO, ...DEV_FO, ...DEV_COMMODITY]

// ── TradingView URL builder ───────────────────────────────────
function tvUrl(symbol, market) {
  const sym = symbol.toUpperCase()
  if (market === 'crypto') {
    const base = sym.replace(/USD(T|C)?$/, '').replace('PERP', '')
    return `https://www.tradingview.com/chart/?symbol=BINANCE:${base}USDT`
  }
  if (market === 'commodity') {
    return `https://www.tradingview.com/chart/?symbol=MCX:${sym}1!`
  }
  if (market === 'india_fo') {
    const base = sym.replace(/-FUT$/, '').replace(/-CE.*/, '').replace(/-PE.*/, '')
    return `https://www.tradingview.com/chart/?symbol=NSE:${base}1!`
  }
  // India equity / index
  return `https://www.tradingview.com/chart/?symbol=NSE:${sym}`
}

// ── Helpers (same as before) ──────────────────────────────────
function toNum(raw) {
  if (raw == null) return null
  if (typeof raw === 'number') return raw
  const n = parseFloat(String(raw).replace(/[^0-9.-]/g, ''))
  return isNaN(n) ? null : n
}

function fmtPrice(num, market) {
  if (num == null) return null
  const prefix = market === 'crypto' ? '$' : '₹'
  const decimals = num < 10 ? 4 : num < 100 ? 2 : 2
  return `${prefix}${num.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

function fmtChg(raw) {
  if (raw == null) return null
  const s = String(raw).replace(/%/g, '').trim()
  const n = parseFloat(s)
  if (isNaN(n)) return null
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

// ── Flash hook ────────────────────────────────────────────────
function useFlash(numericPrice) {
  const prev  = useRef(null)
  const timer = useRef(null)
  const [flash, setFlash] = useState(null)

  useEffect(() => {
    if (numericPrice == null) return
    if (prev.current === null) { prev.current = numericPrice; return }
    if (prev.current !== numericPrice) {
      setFlash(numericPrice > prev.current ? 'up' : 'down')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setFlash(null), 600)
      prev.current = numericPrice
    }
  }, [numericPrice])

  useEffect(() => () => clearTimeout(timer.current), [])
  return flash
}

// ── Tag colour helper ─────────────────────────────────────────
function tagStyle(tag, market, t, isModern) {
  const isCrypto = market === 'crypto'
  const isCommodity = market === 'commodity' || tag === 'MCX' || tag === 'NCDEX' || tag === 'COMEX'
  const isFO = tag === 'FUT' || tag === 'OPT'
  const isIndex = tag === 'INDEX'
  const color = isCrypto ? t.purple
    : isCommodity ? t.amber
    : isFO ? t.cyan
    : isIndex ? t.accent
    : t.cyan

  return {
    fontSize: 7, padding: '1px 3px', borderRadius: t.radius,
    background: `${color}18`,
    color,
    fontFamily: t.font,
    border: isModern ? `1px solid ${color}30` : 'none',
  }
}

// ── WatchRow ──────────────────────────────────────────────────
function WatchRow({ r, live, isActive, t, isModern, onSelect, onOrderBuy, onOrderSell }) {
  const flashNum = live?.num ?? toNum(r.entry_price)
  const flash    = useFlash(flashNum)

  const flashBg = flash === 'up'
    ? (isModern ? 'rgba(0,255,148,0.12)' : 'rgba(0,230,118,0.08)')
    : flash === 'down'
      ? (isModern ? 'rgba(255,45,85,0.12)' : 'rgba(255,59,78,0.08)')
      : null

  const ltpDisplay = live?.display ?? r.price ?? (r.entry_price ? fmtPrice(r.entry_price, r.market) : '—')
  const chgDisplay = fmtChg(live?.chg) ?? fmtChg(r.chg) ?? '—'
  const chgNum     = parseFloat(chgDisplay)
  const chartUrl   = tvUrl(r.symbol, r.market)

  return (
    <div
      onClick={() => onSelect(r)}
      style={{
        display: 'grid',
        gridTemplateColumns: '80px 72px 52px 50px 52px 42px 44px 38px 1fr',
        padding: '4px 8px',
        borderBottom: `1px solid ${isModern ? 'rgba(0,200,255,0.06)' : 'rgba(31,40,48,.5)'}`,
        borderLeft: isActive ? `2px solid ${t.accent}` : '2px solid transparent',
        cursor: 'pointer',
        alignItems: 'center',
        background: flashBg ?? (isActive ? t.bgActive : 'transparent'),
        transition: flashBg ? 'none' : 'background 0.15s',
        boxShadow: isActive && isModern ? `inset 0 0 20px ${t.accentBg}` : 'none',
      }}
      onMouseEnter={(e) => { if (!isActive && !flashBg) e.currentTarget.style.background = t.bgRow }}
      onMouseLeave={(e) => { if (!isActive && !flashBg) e.currentTarget.style.background = isActive ? t.bgActive : 'transparent' }}
    >
      {/* Symbol + name + SMC structure */}
      <div>
        <div style={{ color: t.cyan, fontSize: 10, fontWeight: 500, fontFamily: t.font, textShadow: isModern ? `0 0 8px ${t.cyan}60` : 'none' }}>
          {r.symbol}
        </div>
        <div style={{ color: t.textMuted, fontSize: 8, fontFamily: t.font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.name || r.company_name}
        </div>
        {(() => {
          const struct = r.smc_structure || r.smc_analysis?.structure
          if (!struct || struct === 'ranging') return null
          const isBull = struct.includes('bull') || struct === 'choch_bullish'
          const color  = isBull ? t.bull : t.bear
          return (
            <div style={{
              fontSize: 7, color, fontFamily: t.font, marginTop: 1,
              letterSpacing: 0.3, fontWeight: 600,
              textShadow: isModern ? `0 0 4px ${color}` : 'none',
            }}>
              {struct.replace(/_/g, ' ').toUpperCase()}
            </div>
          )
        })()}
      </div>

      {/* LTP — live, with flash colour */}
      <div style={{ textAlign: 'right', fontSize: 10, fontWeight: 600, fontFamily: t.font, color: flash === 'up' ? t.bull : flash === 'down' ? t.bear : t.text, transition: 'color 0.3s' }}>
        {ltpDisplay}
      </div>

      {/* Bid */}
      <div style={{ textAlign: 'right', fontSize: 9, fontFamily: t.font, color: t.bull, opacity: 0.85 }}>
        {live?.bid ?? r.bid ?? '—'}
      </div>

      {/* Ask */}
      <div style={{ textAlign: 'right', fontSize: 9, fontFamily: t.font, color: t.bear, opacity: 0.85 }}>
        {live?.ask ?? r.ask ?? '—'}
      </div>

      {/* CHG% — live */}
      <div style={{ textAlign: 'right', fontSize: 9, fontFamily: t.font, color: chgNum >= 0 ? t.bull : t.bear, textShadow: isModern ? `0 0 6px currentColor` : 'none', fontWeight: 500 }}>
        {chgDisplay}
      </div>

      {/* VOL× */}
      <div style={{ textAlign: 'right', fontSize: 9, fontFamily: t.font, color: parseFloat(r.vol) > 2 ? t.bull : t.textMuted }}>
        {r.vol && r.vol !== '—' ? `${r.vol}×` : '—'}
      </div>

      {/* Score */}
      <div style={{
        textAlign: 'right', fontSize: 9, fontWeight: 600, fontFamily: t.font,
        color: (r.score || r.overall_score) >= 7 ? t.bull : (r.score || r.overall_score) >= 5 ? t.amber : t.textMuted,
        textShadow: isModern ? `0 0 6px currentColor` : 'none',
      }}>
        {r.score || r.overall_score || '—'}
      </div>

      {/* Tag badge */}
      <div style={{ textAlign: 'center' }}>
        <span style={tagStyle(r.tag, r.market, t, isModern)}>
          {r.tag || (r.market === 'crypto' ? 'PERP' : 'NSE')}
        </span>
      </div>

      {/* Signal + TradingView + B/S */}
      <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
        <span style={{
          fontSize: 9, fontWeight: 600, fontFamily: t.font,
          color: r.verdict === 'GO' ? t.bull : r.verdict === 'WATCH' ? t.amber : t.textDim,
          textShadow: isModern && r.verdict === 'GO' ? t.glowBull : 'none',
          marginRight: 2,
        }}>
          {r.verdict === 'GO' ? '● GO' : r.verdict === 'WATCH' ? '◐ WATCH' : '— SCAN'}
        </span>

        {/* TradingView chart button */}
        <a
          href={chartUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={`Open ${r.symbol} on TradingView`}
          style={{
            background: 'none',
            border: `1px solid ${t.accent}40`,
            color: t.accent,
            fontSize: 7,
            padding: '1px 4px',
            cursor: 'pointer',
            borderRadius: 2,
            fontFamily: t.font,
            lineHeight: 1.2,
            textDecoration: 'none',
            display: 'inline-flex', alignItems: 'center',
            textShadow: isModern ? t.glowAccent : 'none',
          }}
        >TV↗</a>

        <button
          onClick={(e) => { e.stopPropagation(); onOrderBuy(r.symbol) }}
          title={`Buy ${r.symbol}`}
          style={{ background: 'none', border: `1px solid ${t.bull}50`, color: t.bull, fontSize: 7, padding: '1px 4px', cursor: 'pointer', borderRadius: 2, fontFamily: t.font, lineHeight: 1.2 }}
        >B</button>

        <button
          onClick={(e) => { e.stopPropagation(); onOrderSell(r.symbol) }}
          title={`Sell ${r.symbol}`}
          style={{ background: 'none', border: `1px solid ${t.bear}50`, color: t.bear, fontSize: 7, padding: '1px 4px', cursor: 'pointer', borderRadius: 2, fontFamily: t.font, lineHeight: 1.2 }}
        >S</button>
      </div>
    </div>
  )
}

// ── Watchlist ─────────────────────────────────────────────────
export default function Watchlist() {
  const [tabIdx, setTabIdx] = useState(0)
  const [filter, setFilter] = useState('ALL')

  const signals        = useDataStore((s) => s.signals)
  const tickers        = useDataStore((s) => s.tickers)
  const activeSignal   = useTerminalStore((s) => s.activeSignal)
  const setActiveSignal = useTerminalStore((s) => s.setActiveSignal)
  const setDepthSymbol = useTerminalStore((s) => s.setDepthSymbol)
  const openTicket     = useTerminalStore((s) => s.openOrderTicket)
  const t     = useTheme()
  const isModern = t.name === 'modern'

  const activeTab = TABS[tabIdx]

  // Merge real signals with per-class dev mock so each tab has something to show.
  const allRows = useMemo(() => {
    if (signals.length > 0) return signals
    if (!import.meta.env.DEV) return []
    return ALL_DEV_MOCK
  }, [signals])

  // Filter rows by active tab's asset class
  const tabRows = useMemo(() => {
    if (activeTab.filter) return allRows.filter(activeTab.filter)
    return allRows.filter(r =>
      activeTab.markets?.includes(r.market) ||
      activeTab.tags?.some(tag => r.tag === tag),
    )
  }, [allRows, activeTab])

  // Apply verdict filter
  const visible = useMemo(
    () => tabRows.filter(r => filter === 'ALL' || r.verdict === filter),
    [tabRows, filter],
  )

  // Build live-price lookup map from WebSocket tickers
  const liveMap = useMemo(() => {
    const map = {}
    for (const row of tabRows) {
      const tick = tickers[row.symbol] || tickers[row.symbol?.replace('.NS', '')]
      if (!tick) continue
      const num = toNum(tick.price)
      map[row.symbol] = {
        num,
        display: num != null ? fmtPrice(num, row.market) : null,
        chg: tick.change ?? null,
        bid: tick.bid ?? null,
        ask: tick.ask ?? null,
      }
    }
    return map
  }, [tickers, tabRows])

  const goCount    = tabRows.filter(r => r.verdict === 'GO').length
  const watchCount = tabRows.filter(r => r.verdict === 'WATCH').length

  function handleSelect(row) {
    setActiveSignal(row)
    setDepthSymbol(row.symbol)
  }

  return (
    <div style={{
      background: t.bgPanel,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
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
          WATCHLIST
        </span>
        <span style={{ padding: '0 8px', color: t.textDim, fontSize: 9, fontFamily: t.font, letterSpacing: 0.3 }}>
          {goCount} GO · {watchCount} WATCH
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex' }}>
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '0 8px', height: '100%', borderLeft: `1px solid ${t.border}`,
              background: 'none', border: 'none',
              color: filter === f ? (f === 'GO' ? t.bull : f === 'WATCH' ? t.amber : t.accent) : t.textDim,
              fontSize: 9, cursor: 'pointer', display: 'flex', alignItems: 'center',
              fontFamily: t.font, textShadow: filter === f && isModern ? `0 0 8px currentColor` : 'none',
            }}>{f}</button>
          ))}
        </div>
      </div>

      {/* Asset-class tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${t.border}`, flexShrink: 0, overflowX: 'auto' }}>
        {TABS.map((tab, i) => {
          const isActive = tabIdx === i
          // Tab accent colours per asset class
          const tabColor = tab.key === 'crypto' ? t.purple
            : tab.key === 'commodity' ? t.amber
            : tab.key === 'fo' ? t.cyan
            : tab.key === 'bigmoves' ? t.bull
            : t.accent
          return (
            <div
              key={tab.key}
              onClick={() => setTabIdx(i)}
              style={{
                padding: '0 10px', height: 20, flexShrink: 0,
                display: 'flex', alignItems: 'center',
                fontSize: 9, color: isActive ? tabColor : t.textDim,
                cursor: 'pointer', borderRight: `1px solid ${t.border}`,
                letterSpacing: 0.3,
                borderBottom: isActive ? `1px solid ${tabColor}` : 'none',
                fontFamily: t.font,
                textShadow: isActive && isModern ? `0 0 8px ${tabColor}` : 'none',
                whiteSpace: 'nowrap',
              }}
            >{tab.label}</div>
          )
        })}
      </div>

      {tabRows.length === 0 ? (
        <EmptyState
          label={`NO ${activeTab.label.toUpperCase()} DATA`}
          hint="Signal pipeline hasn't run for this asset class yet."
          icon="◯"
        />
      ) : (
        <>
          {/* Column headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '80px 72px 52px 50px 52px 42px 44px 38px 1fr',
            padding: '3px 8px',
            borderBottom: `1px solid ${t.border}`,
            fontSize: 8, color: t.textDim, letterSpacing: 0.4,
            flexShrink: 0, fontFamily: t.font,
          }}>
            <span>SYMBOL</span>
            <span style={{ textAlign: 'right' }}>LTP</span>
            <span style={{ textAlign: 'right', color: t.bull }}>BID</span>
            <span style={{ textAlign: 'right', color: t.bear }}>ASK</span>
            <span style={{ textAlign: 'right' }}>CHG%</span>
            <span style={{ textAlign: 'right' }}>VOL×</span>
            <span style={{ textAlign: 'right' }}>SCORE</span>
            <span style={{ textAlign: 'center' }}>TAG</span>
            <span style={{ textAlign: 'right' }}>SIGNAL</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {visible.map(row => (
              <WatchRow
                key={`${row.symbol}-${row.tag}`}
                r={row}
                live={liveMap[row.symbol] ?? null}
                isActive={activeSignal?.symbol === row.symbol}
                t={t}
                isModern={isModern}
                onSelect={handleSelect}
                onOrderBuy={(sym) => openTicket(sym, 'BUY')}
                onOrderSell={(sym) => openTicket(sym, 'SELL')}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
