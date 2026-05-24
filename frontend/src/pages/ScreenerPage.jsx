// src/pages/ScreenerPage.jsx
// India Stock Screener — multi-tab: Technical | Intraday | Deals | Events | Insider

import { useState, useMemo, useCallback, useEffect, lazy, Suspense } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getScreenerResults, refreshScreener, fmtIST } from '../lib/api'
import { useDataStore, useTerminalStore, useTheme } from '../store'
import ErrorBoundary from '../components/common/ErrorBoundary'

const DealsPanel      = lazy(() => import('../components/market/DealsPanel'))
const EventsCalendar  = lazy(() => import('../components/market/EventsCalendar'))
const InsiderPanel    = lazy(() => import('../components/market/InsiderPanel'))
const IntradayPanel   = lazy(() => import('../components/market/IntradayPanel'))

const SCREENER_TABS = [
  { id: 'technical', label: 'Technical',  icon: '📊' },
  { id: 'intraday',  label: 'Intraday',   icon: '⚡' },
  { id: 'deals',     label: 'Block Deals',icon: '🏦' },
  { id: 'events',    label: 'Events',     icon: '📅' },
  { id: 'insider',   label: 'Insider',    icon: '👥' },
]

// ─── Category config ──────────────────────────────────────────────
// Order and labels match backend CATEGORIES keys.
const CATEGORIES = [
  // ── Daily signals ──────────────────────────────────────────────
  { id: 'bullish_breakout',             emoji: '🚀', title: 'Bullish Breakout',         subtitle: 'Broke above resistance with volume',        type: 'bull' },
  { id: 'bearish_breakdown',            emoji: '🔻', title: 'Bearish Breakdown',         subtitle: 'Broke below support with volume',            type: 'bear' },
  { id: 'oversold_bounce',              emoji: '⬆️', title: 'Oversold Bounce Setup',     subtitle: 'RSI < 35 + at lower Bollinger Band',        type: 'bull' },
  { id: 'overbought_reversal',          emoji: '⚠️', title: 'Overbought — Reversal Risk', subtitle: 'RSI > 70 + at upper Bollinger Band',       type: 'bear' },
  { id: 'golden_cross',                 emoji: '✨', title: 'Golden Cross',              subtitle: 'EMA(50) crossed above EMA(200)',             type: 'bull' },
  { id: 'death_cross',                  emoji: '💀', title: 'Death Cross',               subtitle: 'EMA(50) crossed below EMA(200)',             type: 'bear' },
  { id: 'gap_up',                       emoji: '⬆', title: 'Gap Up — Momentum',          subtitle: 'Opened ≥1.5% above prior close',            type: 'bull' },
  { id: 'gap_down',                     emoji: '⬇', title: 'Gap Down — Weakness',        subtitle: 'Opened ≥1.5% below prior close',            type: 'bear' },
  { id: 'volume_surge',                 emoji: '📊', title: 'Volume Surge',              subtitle: 'Volume ≥ 2.5× 20-day average',              type: 'neutral' },
  { id: 'consolidation',                emoji: '🔄', title: 'Under Consolidation',       subtitle: 'Tight range — breakout imminent',            type: 'neutral' },
  { id: 'near_resistance',              emoji: '🛑', title: 'Near Resistance',           subtitle: 'Within 1.5% of swing high',                 type: 'watch' },
  { id: 'near_support',                 emoji: '🟢', title: 'Near Support',              subtitle: 'Within 1.5% of swing low',                  type: 'watch' },
  // ── Multi-timeframe signals ────────────────────────────────────
  { id: 'weekly_high_breakout',         emoji: '📈', title: 'Weekly High Breakout',      subtitle: 'Closed above prior week\'s high w/ volume', type: 'bull' },
  { id: 'weekly_low_breakdown',         emoji: '📉', title: 'Weekly Low Breakdown',      subtitle: 'Closed below prior week\'s low w/ volume',  type: 'bear' },
  { id: 'weekly_consolidation_breakout', emoji: '💥', title: 'Weekly Consol. Breakout',  subtitle: '3-week tight range → breakout above',       type: 'bull' },
  { id: 'monthly_consolidation_breakout', emoji: '🌋', title: 'Monthly Consol. Breakout', subtitle: '21-day tight range → breakout above',     type: 'bull' },
  { id: '4h_near_high',                 emoji: '⏱', title: '4H Near High',               subtitle: 'Within 0.5% of 4-hour candle high',        type: 'watch' },
  { id: '4h_near_low',                  emoji: '⏱', title: '4H Near Low',                subtitle: 'Within 0.5% of 4-hour candle low',         type: 'watch' },
]

// ─── SVG icons ────────────────────────────────────────────────────

function BullIcon({ size = 18, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M3 18c0 0 1-3 4-4l2 2 3-5 3 3 3-6" stroke={color} strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="19" cy="8" r="2" fill={color} opacity=".5"/>
      <path d="M19 10v2M17 8h-1" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  )
}

function BearIcon({ size = 18, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M3 8c0 0 1 3 4 4l2-2 3 5 3-3 3 6" stroke={color} strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="19" cy="16" r="2" fill={color} opacity=".5"/>
      <path d="M19 14v-2M17 16h-1" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  )
}

function NeutralIcon({ size = 18, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 12h16" stroke={color} strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M4 8h8M4 16h8" stroke={color} strokeWidth="1.2" strokeLinecap="round" opacity=".5"/>
    </svg>
  )
}

// Mini candlestick chart (3 bars)
function MiniCandles({ type, color }) {
  const bars = type === 'bull'
    ? [{ h: 10, body: [3, 8] }, { h: 13, body: [5, 11] }, { h: 16, body: [8, 14] }]
    : type === 'bear'
    ? [{ h: 16, body: [8, 14] }, { h: 13, body: [5, 11] }, { h: 10, body: [3, 8] }]
    : [{ h: 12, body: [5, 9] }, { h: 14, body: [6, 11] }, { h: 12, body: [5, 9] }]

  return (
    <svg width="30" height="20" viewBox="0 0 30 20">
      {bars.map((b, i) => (
        <g key={i} transform={`translate(${i * 10 + 5}, 0)`}>
          <line x1="0" y1={20 - b.h} x2="0" y2="20" stroke={color} strokeWidth="1" opacity=".4"/>
          <rect x="-2.5" y={20 - b.body[1]} width="5" height={b.body[1] - b.body[0]}
            fill={color} opacity=".85" rx="0.5"/>
        </g>
      ))}
    </svg>
  )
}

// ─── Company avatar ────────────────────────────────────────────────
function Avatar({ symbol, color }) {
  const abbr = symbol.replace(/[^A-Z]/g, '').slice(0, 2) || symbol.slice(0, 2)
  return (
    <div style={{
      width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
      background: `${color}18`, border: `1.5px solid ${color}40`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <span style={{ fontSize: 11, fontWeight: 800, color, letterSpacing: -0.5 }}>
        {abbr}
      </span>
    </div>
  )
}

// ─── Level bar (for drill-down multi-TF section) ─────────────────
function LevelBar({ hi, lo, label, color, price, t }) {
  const range = hi - lo
  const pos   = range > 0 ? Math.min(Math.max((price - lo) / range, 0), 1) : 0.5
  const fmtP  = v => v >= 1000 ? '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '₹' + Number(v).toFixed(2)
  const pct   = (a, b) => b > 0 ? ((a - b) / b * 100).toFixed(1) : '0.0'
  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 8, color: t.textMuted, fontFamily: t.fontUI, fontWeight: 600, letterSpacing: 0.4 }}>{label}</span>
        <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>{fmtP(lo)} – {fmtP(hi)}</span>
      </div>
      <div style={{ height: 5, background: `${t.border}50`, borderRadius: 3, position: 'relative' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pos * 100}%`, background: `linear-gradient(90deg, ${t.bull}50, ${color})`, borderRadius: 3 }} />
        <div style={{ position: 'absolute', top: '50%', left: `${pos * 100}%`, transform: 'translate(-50%,-50%)', width: 8, height: 8, borderRadius: '50%', background: color, border: `1.5px solid ${t.bgCard}`, boxShadow: `0 0 4px ${color}` }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 7, color: t.textMuted, fontFamily: t.fontUI }}>+{pct(price, lo)}% from low</span>
        <span style={{ fontSize: 7, color: t.textMuted, fontFamily: t.fontUI }}>{pct(hi, price)}% to high</span>
      </div>
    </div>
  )
}

// ─── Drill-down panel ─────────────────────────────────────────────
function DrillDownPanel({ stock, catMeta, t, onClose, onTrade }) {
  const price     = stock.price || 0
  const swingHigh = stock.swing_high   || price
  const swingLow  = stock.swing_low    || price
  const atrPct    = stock.atr_pct      || 0
  const rsi       = stock.rsi          || 0
  const volRatio  = stock.vol_ratio    || 1
  const h4High    = stock['4h_high']   || price
  const h4Low     = stock['4h_low']    || price
  const wkHigh    = stock.weekly_high  || price
  const wkLow     = stock.weekly_low   || price
  const mthHigh   = stock.monthly_high || price
  const mthLow    = stock.monthly_low  || price

  const typeColor = catMeta.type === 'bull' ? t.bull : catMeta.type === 'bear' ? t.bear : t.amber
  const rsiColor  = rsi > 70 ? t.bear : rsi < 30 ? t.bull : rsi > 60 ? t.amber : t.text

  const fmtP = v => v >= 1000 ? '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '₹' + Number(v).toFixed(2)

  const swingRange = swingHigh - swingLow
  const relPos = swingRange > 0 ? Math.min(Math.max((price - swingLow) / swingRange, 0), 1) : 0.5

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)', zIndex: 800 }} />
      <div className="fade-in" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        zIndex: 801, width: 420,
        background: t.bgCard, border: `1px solid ${t.border}`,
        borderTop: `3px solid ${typeColor}`,
        borderRadius: t.radiusLg, boxShadow: t.shadowLg,
        overflow: 'hidden', maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar symbol={stock.symbol} color={typeColor} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: t.text, fontFamily: t.fontUI }}>{stock.symbol}</div>
              <div style={{ fontSize: 10, color: typeColor, fontFamily: t.fontUI, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span>{catMeta.emoji}</span><span>{catMeta.title}</span>
              </div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>{fmtP(price)}</div>
            {stock.change_pct != null && (
              <div style={{ fontSize: 10, color: stock.change_pct >= 0 ? t.bull : t.bear, fontFamily: t.fontUI }}>
                {stock.change_pct >= 0 ? '▲' : '▼'} {Math.abs(stock.change_pct).toFixed(2)}%
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '14px 16px', overflowY: 'auto' }}>

          {/* 20-bar Swing S/R bar */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: t.bull, fontFamily: t.fontUI, fontWeight: 600 }}>SUPPORT {fmtP(swingLow)}</span>
              <span style={{ fontSize: 8, color: t.textMuted, fontFamily: t.fontUI }}>20-BAR SWING</span>
              <span style={{ fontSize: 9, color: t.bear, fontFamily: t.fontUI, fontWeight: 600 }}>RESIST. {fmtP(swingHigh)}</span>
            </div>
            <div style={{ height: 8, background: `linear-gradient(90deg, ${t.bull}30 0%, ${t.bear}30 100%)`, borderRadius: 4, position: 'relative', border: `1px solid ${t.border}` }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${relPos * 100}%`, background: `linear-gradient(90deg, ${t.bull}60, ${typeColor})`, borderRadius: 4, transition: 'width 0.4s ease' }} />
              <div style={{ position: 'absolute', top: '50%', left: `${relPos * 100}%`, transform: 'translate(-50%,-50%)', width: 12, height: 12, borderRadius: '50%', background: typeColor, border: `2px solid ${t.bgCard}`, boxShadow: `0 0 6px ${typeColor}` }} />
            </div>
          </div>

          {/* Multi-timeframe level bars */}
          <div style={{ background: t.bgActive, borderRadius: t.radius, padding: '10px 12px', border: `1px solid ${t.border}`, marginBottom: 12 }}>
            <div style={{ fontSize: 8, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8, fontWeight: 600 }}>Multi-Timeframe Levels</div>
            <LevelBar hi={h4High}  lo={h4Low}  label="4H HIGH / LOW"     color={t.cyan}    price={price} t={t} />
            <LevelBar hi={wkHigh}  lo={wkLow}  label="WEEKLY HIGH / LOW" color={t.amber}   price={price} t={t} />
            <LevelBar hi={mthHigh} lo={mthLow} label="MONTHLY HIGH / LOW" color={typeColor} price={price} t={t} />
          </div>

          {/* Metrics grid — 3 columns */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 7, marginBottom: 12 }}>
            {[
              { label: 'RSI (14)',  value: rsi.toFixed(1),            color: rsiColor,  note: rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : 'Neutral' },
              { label: 'ATR %',    value: `${atrPct.toFixed(2)}%`,   color: t.text,    note: atrPct > 3 ? 'High Vol' : 'Normal' },
              { label: 'Vol Ratio',value: `${volRatio.toFixed(2)}×`, color: volRatio >= 2.5 ? t.amber : volRatio >= 1.5 ? t.cyan : t.text, note: volRatio >= 1.5 ? 'Elevated' : 'Normal' },
              { label: 'EMA 50',   value: fmtP(stock.ema50 || 0),   color: t.text,    note: price > (stock.ema50||0) ? '↑ Above' : '↓ Below' },
              { label: 'EMA 200',  value: fmtP(stock.ema200 || 0),  color: t.text,    note: price > (stock.ema200||0) ? '↑ Above' : '↓ Below' },
              { label: 'Setup',    value: catMeta.title,             color: typeColor, note: catMeta.subtitle },
            ].map(({ label, value, color, note }) => (
              <div key={label} style={{ background: t.bgCard, borderRadius: t.radius, padding: '7px 9px', border: `1px solid ${t.border}` }}>
                <div style={{ fontSize: 7, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color, fontFamily: t.fontUI, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
                {note && <div style={{ fontSize: 7, color: t.textDim, fontFamily: t.fontUI, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note}</div>}
              </div>
            ))}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button onClick={() => { onTrade(stock.symbol, 'BUY'); onClose() }}
              style={{ padding: '10px 0', fontSize: 12, fontWeight: 700, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: t.radius, border: 'none', background: t.bull, color: '#fff', boxShadow: `0 4px 12px ${t.bull}40` }}
            >BUY</button>
            <button onClick={() => { onTrade(stock.symbol, 'SELL'); onClose() }}
              style={{ padding: '10px 0', fontSize: 12, fontWeight: 700, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: t.radius, border: 'none', background: t.bear, color: '#fff', boxShadow: `0 4px 12px ${t.bear}40` }}
            >SELL</button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Single stock row ──────────────────────────────────────────────
function StockRow({ stock, catType, t, onTrade, onAddWatch, onDrillDown }) {
  const [hov, setHov] = useState(false)
  const tickers  = useDataStore(s => s.tickers)
  const tick     = tickers[stock.symbol] || {}
  const price    = tick.price ?? stock.price
  const chgNum   = parseFloat(tick.change ?? stock.change_pct ?? 0)
  const isBull   = catType === 'bull' || (!isNaN(chgNum) && chgNum >= 0)
  const sigColor = catType === 'bull' ? t.bull : catType === 'bear' ? t.bear : t.amber

  // Format bar time → "Apr 26 · 15:30"
  const sigTime = useMemo(() => fmtIST(new Date(), 'datetime'), [])

  const fmtPrice = typeof price === 'number'
    ? price >= 1000
      ? '₹' + price.toLocaleString('en-IN', { maximumFractionDigits: 0 })
      : '₹' + price.toFixed(2)
    : '—'

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={() => onDrillDown(stock)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 14px',
        background: hov ? `${sigColor}08` : 'transparent',
        borderBottom: `1px solid ${t.border}`,
        transition: 'background 0.12s',
        cursor: 'pointer',
      }}
    >
      {/* Avatar */}
      <Avatar symbol={stock.symbol} color={sigColor} />

      {/* Symbol + price */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 700, color: t.text,
          fontFamily: t.fontUI, letterSpacing: 0.1,
        }}>
          {stock.symbol}
        </div>
        <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI, marginTop: 1 }}>
          {fmtPrice}
        </div>
      </div>

      {/* Mini candles */}
      <MiniCandles type={catType} color={sigColor} />

      {/* Add to watchlist */}
      <button
        onClick={(e) => { e.stopPropagation(); onAddWatch(stock.symbol) }}
        title="Add to watchlist"
        style={{
          width: 22, height: 22, borderRadius: 4, flexShrink: 0,
          background: hov ? `${t.accent}20` : `${t.border}30`,
          border: `1px solid ${hov ? t.accent : t.border}`,
          color: hov ? t.accent : t.textDim,
          cursor: 'pointer', fontSize: 12, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.12s',
        }}
      >+</button>

      {/* Time + change */}
      <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 90 }}>
        <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginBottom: 2 }}>
          {sigTime}
        </div>
        <div style={{
          fontSize: 11, fontWeight: 700, fontFamily: t.fontUI,
          color: isNaN(chgNum) ? t.textDim : chgNum >= 0 ? t.bull : t.bear,
        }}>
          {isNaN(chgNum) ? '—' : `${chgNum >= 0 ? '▲' : '▼'} ${Math.abs(chgNum).toFixed(2)}%`}
        </div>
      </div>

      {/* Bull / bear icon */}
      <div style={{ flexShrink: 0 }}>
        {catType === 'bull' ? (
          <BullIcon size={20} color={t.bull} />
        ) : catType === 'bear' ? (
          <BearIcon size={20} color={t.bear} />
        ) : (
          <NeutralIcon size={20} color={t.amber} />
        )}
      </div>

      {/* Trade button on hover */}
      {hov && (
        <button
          onClick={(e) => { e.stopPropagation(); onTrade(stock.symbol, catType === 'bear' ? 'SELL' : 'BUY') }}
          style={{
            padding: '3px 8px', borderRadius: 3, fontSize: 8,
            fontFamily: t.fontUI, fontWeight: 700, cursor: 'pointer',
            flexShrink: 0,
            background: catType === 'bear' ? `${t.bear}20` : `${t.bull}20`,
            border: `1px solid ${catType === 'bear' ? t.bear : t.bull}50`,
            color: catType === 'bear' ? t.bear : t.bull,
          }}
        >
          {catType === 'bear' ? 'SELL' : 'BUY'}
        </button>
      )}
    </div>
  )
}

// ─── Category box ──────────────────────────────────────────────────
function CategoryBox({ meta, catData, t, onTrade, onAddWatch, onDrillDown }) {
  const [open, setOpen] = useState(true)

  const typeColor = meta.type === 'bull'    ? t.bull
                  : meta.type === 'bear'    ? t.bear
                  : meta.type === 'watch'   ? t.amber
                  : t.cyan

  const stocks = (catData?.stocks || []).filter(s => s.market === 'india')
  if (!stocks.length) return null

  return (
    <div style={{
      borderRadius: 10,
      overflow: 'hidden',
      background: t.bgCard,
      border: `1px solid ${typeColor}30`,
      boxShadow: t.shadowCard,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Box header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px',
          background: `linear-gradient(90deg, ${typeColor}14 0%, transparent 100%)`,
          borderBottom: `1px solid ${typeColor}25`,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {/* Category emoji */}
        <span style={{ fontSize: 16, lineHeight: 1 }}>{meta.emoji}</span>

        {/* Title block */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12, fontWeight: 800, color: typeColor,
            fontFamily: t.fontUI, letterSpacing: 0.2,
          }}>
            {meta.title.toUpperCase()}
          </div>
          <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 1 }}>
            {meta.subtitle}
          </div>
        </div>

        {/* Count pill */}
        <span style={{
          padding: '2px 10px', borderRadius: 20,
          fontSize: 10, fontWeight: 700,
          background: `${typeColor}20`,
          color: typeColor,
          border: `1px solid ${typeColor}40`,
          fontFamily: t.fontUI,
          flexShrink: 0,
        }}>
          {stocks.length}
        </span>

        {/* Collapse chevron */}
        <span style={{
          fontSize: 10, color: t.textDim,
          transform: open ? 'rotate(0)' : 'rotate(-90deg)',
          transition: 'transform 0.15s',
          flexShrink: 0,
        }}>▾</span>
      </div>

      {/* Stock list */}
      {open && (
        <div style={{ overflowY: 'auto', maxHeight: 320 }}>
          {stocks.map((stock, i) => (
            <StockRow
              key={`${stock.symbol}-${i}`}
              stock={stock}
              catType={meta.type}
              t={t}
              onTrade={onTrade}
              onAddWatch={onAddWatch}
              onDrillDown={onDrillDown}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Summary strip ─────────────────────────────────────────────────
function SummaryStrip({ data, t }) {
  if (!data?.categories) return null
  const cats    = data.categories
  const bullish = [
    'bullish_breakout', 'oversold_bounce', 'golden_cross', 'gap_up',
    'weekly_high_breakout', 'weekly_consolidation_breakout', 'monthly_consolidation_breakout',
  ].reduce((s, k) => s + (cats[k]?.stocks?.filter(x => x.market === 'india').length || 0), 0)
  const bearish = [
    'bearish_breakdown', 'overbought_reversal', 'death_cross', 'gap_down', 'weekly_low_breakdown',
  ].reduce((s, k) => s + (cats[k]?.stocks?.filter(x => x.market === 'india').length || 0), 0)
  const neutral = [
    'consolidation', 'near_resistance', 'near_support', 'volume_surge', '4h_near_high', '4h_near_low',
  ].reduce((s, k) => s + (cats[k]?.stocks?.filter(x => x.market === 'india').length || 0), 0)

  const total = data.total_scanned || 0

  const Stat = ({ label, val, color }) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 14px', borderRadius: 6,
      background: `${color}10`, border: `1px solid ${color}25`,
    }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 800, color, fontFamily: t.fontUI }}>{val}</span>
    </div>
  )

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '10px 16px', borderBottom: `1px solid ${t.border}`,
      background: t.headerGrad, flexShrink: 0,
    }}>
      <span style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI }}>
        {total} NSE stocks scanned
      </span>
      <div style={{ width: 1, height: 16, background: t.border }} />
      <Stat label="Bullish Setups" val={bullish} color={t.bull} />
      <Stat label="Bearish Setups" val={bearish} color={t.bear} />
      <Stat label="Watch Setups"   val={neutral}  color={t.amber} />
      {data.last_scan && (
        <span style={{ marginLeft: 'auto', fontSize: 8, color: t.textMuted, fontFamily: t.fontUI }}>
          Last scan: <strong style={{ color: t.textDim }}>{data.last_scan}</strong>
        </span>
      )}
    </div>
  )
}

// ─── Page header ───────────────────────────────────────────────────
function PageHeader({ onRefresh, refreshing, t }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '11px 16px', borderBottom: `1px solid ${t.border}`,
      background: t.headerGrad, flexShrink: 0,
    }}>
      {/* Icon + title */}
      <div style={{
        width: 34, height: 34, borderRadius: 8,
        background: `${t.accent}18`, border: `1px solid ${t.accent}30`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <span style={{ fontSize: 16 }}>📈</span>
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 800, color: t.text, fontFamily: t.fontUI, letterSpacing: 0.2 }}>
          INDIA STOCK SCREENER
        </div>
        <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 1 }}>
          NSE · Technical strategy categories · Scans at 9:30 AM & 1:30 PM IST
        </div>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Legend */}
        {[
          { label: 'Bullish', color: t.bull },
          { label: 'Bearish', color: t.bear },
          { label: 'Watch',   color: t.amber },
          { label: 'Neutral', color: t.cyan },
        ].map(({ label, color }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
            <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>{label}</span>
          </div>
        ))}

        <div style={{ width: 1, height: 16, background: t.border, margin: '0 4px' }} />

        {/* Refresh button */}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: 6, cursor: refreshing ? 'default' : 'pointer',
            fontSize: 10, fontFamily: t.fontUI, fontWeight: 600,
            background: refreshing ? `${t.border}30` : `${t.accent}18`,
            border: `1px solid ${refreshing ? t.border : t.accent}`,
            color: refreshing ? t.textDim : t.accent,
            transition: 'all 0.15s',
          }}
        >
          <span style={{ display: 'inline-block', animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>
            ↻
          </span>
          {refreshing ? 'Scanning…' : 'Refresh'}
        </button>
      </div>
    </div>
  )
}

// ─── Loading skeleton ──────────────────────────────────────────────
function LoadingState({ t }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14,
    }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{
          borderRadius: 10, border: `1px solid ${t.border}`,
          background: t.bgCard, overflow: 'hidden',
        }}>
          <div style={{
            height: 58, background: `${t.border}20`,
            borderBottom: `1px solid ${t.border}`,
          }} />
          {Array.from({ length: 3 }).map((_, j) => (
            <div key={j} style={{
              height: 58, borderBottom: `1px solid ${t.border}`,
              display: 'flex', alignItems: 'center', padding: '0 14px', gap: 10,
            }}>
              <div style={{ width: 38, height: 38, borderRadius: '50%', background: `${t.border}40` }} />
              <div style={{ flex: 1 }}>
                <div style={{ height: 10, width: 80, borderRadius: 3, background: `${t.border}50`, marginBottom: 5 }} />
                <div style={{ height: 8,  width: 50, borderRadius: 3, background: `${t.border}30` }} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────
export default function ScreenerPage() {
  const t               = useTheme()
  const openTicket      = useTerminalStore(s => s.openOrderTicket)
  const addWatch        = useTerminalStore(s => s.addWatchlistSymbol)
  const screenerLastScan = useDataStore(s => s.screenerLastScan)
  const qc              = useQueryClient()

  const [activeTab, setActiveTab] = useState('technical')
  const [selectedStock, setSelectedStock] = useState(null)
  const [selectedCatMeta, setSelectedCatMeta] = useState(null)

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey:             ['screenerResults'],
    queryFn:              () => getScreenerResults('india'),
    staleTime:            Infinity,   // never auto-refetch — user-triggered only
    gcTime:               Infinity,   // never garbage-collect — persists across navigation
    // Poll every 3 s while backend scan is in progress; stop once we get real data
    refetchInterval:      (query) => query.state.data?.scanning ? 3000 : false,
    refetchOnMount:       false,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (screenerLastScan) refetch()
  }, [screenerLastScan])  // eslint-disable-line react-hooks/exhaustive-deps

  const { mutate: doRefresh, isPending: refreshing } = useMutation({
    mutationFn: () => refreshScreener('india'),
    onSuccess:  (fresh) => qc.setQueryData(['screenerResults'], fresh),
  })

  const onTrade    = useCallback((sym, side = 'BUY') => openTicket(sym, side), [openTicket])
  const onAddWatch = useCallback((sym) => addWatch('india', sym), [addWatch])
  const onDrillDown = useCallback((stock, catMeta) => {
    setSelectedStock(stock)
    setSelectedCatMeta(catMeta)
  }, [])

  // Treat "scanning" sentinel the same as loading so spinner shows instead of empty grid
  const showSpin = isLoading || (isFetching && !data) || data?.scanning === true

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {selectedStock && selectedCatMeta && (
        <DrillDownPanel
          stock={selectedStock}
          catMeta={selectedCatMeta}
          t={t}
          onClose={() => { setSelectedStock(null); setSelectedCatMeta(null) }}
          onTrade={onTrade}
        />
      )}

      {/* ── Tab navigation ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2,
        padding: '8px 16px 0', borderBottom: `1px solid ${t.border}`,
        flexShrink: 0, background: t.bg, flexWrap: 'wrap',
      }}>
        {SCREENER_TABS.map(tab => (
          <button key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '6px 14px', borderRadius: '6px 6px 0 0',
              fontSize: 12, cursor: 'pointer', border: 'none',
              borderBottom: activeTab === tab.id ? `2px solid ${t.accent}` : '2px solid transparent',
              background: activeTab === tab.id ? t.surface : 'transparent',
              color: activeTab === tab.id ? t.text : t.muted,
              fontWeight: activeTab === tab.id ? 600 : 400,
              transition: 'all 0.12s',
            }}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
        {activeTab === 'technical' && (
          <button
            onClick={() => doRefresh()}
            disabled={refreshing || isFetching}
            style={{
              marginLeft: 'auto', marginBottom: 2,
              padding: '4px 12px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
              border: `1px solid ${t.border}`, background: t.surface, color: t.muted,
              opacity: (refreshing || isFetching) ? 0.5 : 1,
            }}
          >
            {(refreshing || isFetching) ? '↻ Scanning…' : '↻ Refresh'}
          </button>
        )}
      </div>

      {/* ── Non-technical tabs ── */}
      {activeTab !== 'technical' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Suspense fallback={
            <div style={{ padding: 40, textAlign: 'center', color: t.muted, fontSize: 13 }}>Loading…</div>
          }>
            {activeTab === 'intraday' && <IntradayPanel />}
            {activeTab === 'deals'    && <DealsPanel />}
            {activeTab === 'events'   && <EventsCalendar />}
            {activeTab === 'insider'  && <InsiderPanel />}
          </Suspense>
        </div>
      )}

      {/* ── Technical screener (existing) ── */}
      {activeTab === 'technical' && (
        <>
        <SummaryStrip data={data} t={t} />
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>

        {/* Initial loading */}
        {showSpin && (
          <div>
            <div style={{
              padding: '28px 20px', textAlign: 'center',
              color: t.textMuted, fontFamily: t.fontUI, marginBottom: 20,
            }}>
              <div style={{
                fontSize: 28, marginBottom: 10,
                display: 'inline-block', animation: 'spin 1.2s linear infinite',
              }}>↻</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim, marginBottom: 4 }}>
                Scanning NSE stocks…
              </div>
              <div style={{ fontSize: 9, color: t.textMuted }}>
                Analysing 72 NSE stocks across 18 technical strategies + 4H intraday — ~45 seconds
              </div>
            </div>
            <LoadingState t={t} />
          </div>
        )}

        {/* No data */}
        {!showSpin && !data && (
          <div style={{
            padding: '80px 20px', textAlign: 'center',
            color: t.textMuted, fontFamily: t.fontUI, fontSize: 11,
          }}>
            No screener data yet. Click <strong style={{ color: t.accent }}>Refresh</strong> to run the first scan.
          </div>
        )}

        {/* Category grid — masonry via 4 flex columns */}
        {!showSpin && data && (() => {
          // Collect non-empty category cards in display order
          const visibleMetas = CATEGORIES.filter(meta => {
            const catData = data.categories?.[meta.id]
            return catData && (catData.stocks || []).some(s => s.market === 'india')
          })

          if (visibleMetas.length === 0) {
            return (
              <div style={{ padding: '60px 20px', textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI, fontSize: 10 }}>
                No NSE stocks matched any screener criteria in this scan.
                Markets may be closed or data not yet loaded. Click Refresh.
              </div>
            )
          }

          // Distribute cards into 4 columns (left-to-right fill → natural masonry)
          const N = 4
          const cols = Array.from({ length: N }, () => [])
          visibleMetas.forEach((meta, i) => cols[i % N].push(meta))

          return (
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              {cols.map((col, ci) => (
                <div key={ci} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
                  {col.map(meta => (
                    <ErrorBoundary key={meta.id} scope={`SCREENER:${meta.id}`}>
                      <CategoryBox
                        meta={meta}
                        catData={data.categories[meta.id]}
                        t={t}
                        onTrade={onTrade}
                        onAddWatch={onAddWatch}
                        onDrillDown={(stock) => onDrillDown(stock, meta)}
                      />
                    </ErrorBoundary>
                  ))}
                </div>
              ))}
            </div>
          )
        })()}
        </div>
        </>
      )}
    </div>
  )
}
