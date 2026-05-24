// src/components/home/HomeDashboard.jsx

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getMarketSentiment } from '../../lib/api'
import { useDataStore, useTerminalStore, useTheme } from '../../store'
import TVWatchlist from './TVWatchlist'
import ErrorBoundary from '../common/ErrorBoundary'
import MarketPulse from './MarketPulse'

const HOME_TABS = ['OVERVIEW', 'STOCKS', 'CRYPTO', 'COMMODITIES']

// ─── Sub-tab bar ─────────────────────────────────────────────────
function SubTabBar({ activeTab, setTab, t }) {
  return (
    <div style={{
      display: 'flex', height: 36, borderBottom: `1px solid ${t.border}`,
      background: t.bgPanel, flexShrink: 0, paddingLeft: 8,
    }}>
      {HOME_TABS.map(tab => {
        const active = activeTab === tab
        return (
          <button key={tab} onClick={() => setTab(tab)} style={{
            padding: '0 18px', height: '100%', background: 'none', border: 'none',
            borderBottom: active ? `2px solid ${t.accent}` : '2px solid transparent',
            color: active ? t.accent : t.textMuted,
            fontSize: 11, fontWeight: active ? 700 : 400, cursor: 'pointer',
            fontFamily: t.fontUI, letterSpacing: 0.3,
            transition: 'color 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => { if (!active) e.currentTarget.style.color = t.text }}
          onMouseLeave={e => { if (!active) e.currentTarget.style.color = t.textMuted }}
          >{tab}</button>
        )
      })}
    </div>
  )
}

// ─── Section header — gradient banner ────────────────────────────
function SectionHdr({ label, sub, badge, color, icon, t, isModern }) {
  const c = color || t.accent
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '9px 14px',
      marginBottom: 14,
      background: isModern
        ? `linear-gradient(90deg, ${c}18 0%, ${c}05 60%, transparent 100%)`
        : `${c}0A`,
      borderLeft: `3px solid ${c}`,
      borderRadius: `0 ${t.radius}px ${t.radius}px 0`,
    }}>
      {icon && <span style={{ fontSize: 15, lineHeight: 1 }}>{icon}</span>}
      <div>
        <div style={{ fontSize: 12, fontWeight: 800, color: c, fontFamily: t.fontUI, letterSpacing: 0.4 }}>
          {label}
        </div>
        {sub && <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, marginTop: 1 }}>{sub}</div>}
      </div>
      {badge && (
        <div style={{
          marginLeft: 'auto', background: `${c}20`,
          border: `1px solid ${c}35`, borderRadius: 20,
          padding: '2px 10px', fontSize: 9, color: c,
          fontFamily: t.font, fontWeight: 700, letterSpacing: 0.3,
        }}>{badge}</div>
      )}
    </div>
  )
}

// ─── Metric card ─────────────────────────────────────────────────
function MetCard({ label, desc, value, change, color, sub, t, isModern, small }) {
  const chgNum  = parseFloat(change)
  const hasChg  = change !== undefined && !isNaN(chgNum)
  const isPos   = chgNum >= 0
  const chgColor = hasChg ? (isPos ? t.bull : t.bear) : t.textMuted
  const c = color || t.text

  return (
    <div style={{
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderLeft: `3px solid ${c}`,
      borderRadius: t.radius,
      padding: small ? '9px 12px' : '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 4,
      boxShadow: t.shadowCard,
      position: 'relative', overflow: 'hidden',
      transition: 'border-color 0.2s',
    }}>
      {isModern && (
        <div style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 80,
          background: `radial-gradient(ellipse at top right, ${c}09 0%, transparent 70%)`,
          pointerEvents: 'none',
        }} />
      )}
      <div style={{
        fontSize: 9, color: t.textMuted, fontFamily: t.fontUI,
        fontWeight: 600, letterSpacing: 0.7, textTransform: 'uppercase',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: small ? 16 : 22, fontWeight: 700, color: c,
        fontFamily: t.font, letterSpacing: -0.5, lineHeight: 1,
      }}>
        {value}
      </div>
      {hasChg && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          background: `${chgColor}14`, border: `1px solid ${chgColor}28`,
          borderRadius: 20, padding: '2px 7px', alignSelf: 'flex-start',
        }}>
          <span style={{ fontSize: 8, color: chgColor, fontFamily: t.font, fontWeight: 800 }}>
            {isPos ? '▲' : '▼'} {Math.abs(chgNum).toFixed(2)}%
          </span>
        </div>
      )}
      {(sub || desc) && (
        <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, marginTop: 1 }}>
          {sub || desc}
        </div>
      )}
    </div>
  )
}

// ─── Status chip ─────────────────────────────────────────────────
function StatusChip({ label, color, t }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: `${color}16`, border: `1px solid ${color}30`,
      borderRadius: 20, padding: '3px 8px',
    }}>
      <div style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 8, fontWeight: 700, color, fontFamily: t.font, letterSpacing: 0.4 }}>
        {label}
      </span>
    </div>
  )
}

// ─── VIX card ────────────────────────────────────────────────────
function VixCard({ vix, t, isModern }) {
  const level  = !vix ? 'UNKNOWN' : vix > 25 ? 'EXTREME FEAR' : vix > 20 ? 'HIGH' : vix > 15 ? 'ELEVATED' : vix > 12 ? 'NORMAL' : 'COMPLACENT'
  const color  = !vix ? t.textMuted : vix > 25 ? t.bear : vix > 20 ? '#F97316' : vix > 15 ? t.amber : t.bull
  const desc   = vix > 20 ? 'Options market pricing in large swings' : vix > 15 ? 'Moderate uncertainty' : 'Markets are calm'

  return (
    <div style={{
      background: isModern ? `linear-gradient(135deg, ${color}0C, ${t.bgCard})` : t.bgCard,
      border: `1px solid ${color}40`,
      borderRadius: t.radius, padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 5,
      boxShadow: isModern ? `0 0 20px ${color}18` : t.shadowCard,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, fontWeight: 600, letterSpacing: 0.7 }}>INDIA VIX</span>
        <StatusChip label={level} color={color} t={t} />
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color, fontFamily: t.font, letterSpacing: -1 }}>
        {vix ? vix.toFixed(2) : '—'}
      </div>
      <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI }}>{desc}</div>
      <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>Options Volatility Index</div>
    </div>
  )
}

// ─── Flow bar ────────────────────────────────────────────────────
function FlowBar({ label, sublabel, value, max, color, t }) {
  const pct  = max > 0 ? Math.min(Math.abs(value) / max * 100, 100) : 0
  const isPos = value >= 0
  const c    = isPos ? color : t.bear
  const absV = Math.abs(value)
  const fmt  = absV >= 10000 ? `₹${(absV / 1000).toFixed(1)}K Cr` : `₹${absV.toLocaleString('en-IN')} Cr`

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
        <div>
          <span style={{ fontSize: 10, color: t.text, fontFamily: t.font, fontWeight: 600 }}>{label}</span>
          {sublabel && <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginLeft: 5 }}>{sublabel}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 8, color: isPos ? t.bull : t.bear, fontFamily: t.fontUI, fontWeight: 600 }}>
            {isPos ? 'NET BUYING' : 'NET SELLING'}
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: c, fontFamily: t.font }}>
            {isPos ? '+' : '-'}{fmt}
          </span>
        </div>
      </div>
      <div style={{ height: 7, background: `${c}18`, borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%', background: c, borderRadius: 4,
          boxShadow: isModernCheck(t) ? `0 0 8px ${c}60` : 'none',
          transition: 'width 0.6s ease',
        }} />
      </div>
    </div>
  )
}

function isModernCheck(t) { return t.name === 'modern' }

// ─── Sector heatmap ──────────────────────────────────────────────
const SECTORS = [
  { key: 'BANK', label: 'Bank' }, { key: 'IT', label: 'IT' },
  { key: 'AUTO', label: 'Auto' }, { key: 'PHARMA', label: 'Pharma' },
  { key: 'FMCG', label: 'FMCG' }, { key: 'METAL', label: 'Metal' },
  { key: 'ENERGY', label: 'Energy' }, { key: 'REALTY', label: 'Realty' },
]

function SectorHeatmap({ sectorData, t, isModern }) {
  const maxAbs = Math.max(...SECTORS.map(s => Math.abs(sectorData?.[s.key] ?? 0)), 0.5)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5, marginBottom: 14 }}>
      {SECTORS.map(s => {
        const chg  = sectorData?.[s.key] ?? null
        const isPos = chg === null ? null : chg >= 0
        const color = chg === null ? t.textDim : isPos ? t.bull : t.bear
        const intensity = chg === null ? 0 : Math.min(Math.abs(chg) / maxAbs, 1)
        const bg = chg === null
          ? `${t.border}30`
          : isPos ? `rgba(16,185,129,${0.08 + intensity * 0.16})` : `rgba(239,68,68,${0.08 + intensity * 0.16})`
        const pct = chg === null ? 0 : Math.abs(chg) / maxAbs * 100

        return (
          <div key={s.key} style={{
            background: bg,
            border: `1px solid ${color}${chg === null ? '18' : '35'}`,
            borderRadius: t.radius, padding: '8px 8px 6px',
            position: 'relative', overflow: 'hidden',
            boxShadow: isModern && chg !== null ? `0 0 10px ${color}18` : 'none',
          }}>
            {/* Magnitude bar at bottom */}
            {chg !== null && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0,
                width: `${pct}%`, height: 2, background: color, opacity: 0.7,
              }} />
            )}
            <div style={{ fontSize: 8, color: t.textMuted, fontFamily: t.fontUI, fontWeight: 600, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color, fontFamily: t.font }}>
              {chg === null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Market breadth ───────────────────────────────────────────────
function BreadthBar({ breadth, t, isModern }) {
  const bull  = breadth?.bullish ?? 0
  const bear  = breadth?.bearish ?? 0
  const neut  = breadth?.neutral ?? 0
  const total = bull + bear + neut || 1
  const bullPct = (bull / total) * 100
  const bearPct = (bear / total) * 100
  const neutPct = (neut / total) * 100
  const mood    = breadth?.mood || 'mixed'
  const moodMap = { risk_on: { label: 'RISK ON', color: '#10B981' }, risk_off: { label: 'RISK OFF', color: '#EF4444' }, mixed: { label: 'MIXED', color: '#F59E0B' } }
  const m = moodMap[mood] || moodMap.mixed

  return (
    <div style={{
      background: t.bgCard, border: `1px solid ${t.border}`,
      borderRadius: t.radius, padding: '12px 14px', marginBottom: 14,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <span style={{ fontSize: 10, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>MARKET BREADTH</span>
          <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginLeft: 6 }}>stocks scanned</span>
        </div>
        <StatusChip label={m.label} color={m.color} t={t} />
      </div>
      <div style={{ display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden', marginBottom: 8, gap: 1 }}>
        {bullPct > 0 && <div style={{ width: `${bullPct}%`, background: t.bull, boxShadow: isModern ? `0 0 8px ${t.bull}60` : 'none' }} />}
        {neutPct > 0 && <div style={{ width: `${neutPct}%`, background: `${t.textDim}80` }} />}
        {bearPct > 0 && <div style={{ width: `${bearPct}%`, background: t.bear, boxShadow: isModern ? `0 0 8px ${t.bear}60` : 'none' }} />}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.bull, fontFamily: t.font }}>{bull}</div>
          <div style={{ fontSize: 7, color: t.textDim, fontFamily: t.fontUI }}>BULLISH</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.textMuted, fontFamily: t.font }}>{neut}</div>
          <div style={{ fontSize: 7, color: t.textDim, fontFamily: t.fontUI }}>NEUTRAL</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.bear, fontFamily: t.font }}>{bear}</div>
          <div style={{ fontSize: 7, color: t.textDim, fontFamily: t.fontUI }}>BEARISH</div>
        </div>
      </div>
    </div>
  )
}

// ─── Fear & Greed gauge ───────────────────────────────────────────
function FGGauge({ value, t, isModern }) {
  const zones = [
    { max: 25,  label: 'EXTREME FEAR',  color: '#EF4444' },
    { max: 45,  label: 'FEAR',          color: '#F97316' },
    { max: 55,  label: 'NEUTRAL',       color: '#94A3B8' },
    { max: 75,  label: 'GREED',         color: '#6ABAFF' },
    { max: 100, label: 'EXTREME GREED', color: '#10B981' },
  ]
  const zone  = zones.find(z => value <= z.max) || zones[zones.length - 1]
  const color = zone.color
  const angle = 180 - (value / 100) * 180
  const R = 38; const cx = 50; const cy = 46
  const toRad = d => (d * Math.PI) / 180
  const x = cx + R * Math.cos(toRad(angle))
  const y = cy - R * Math.sin(toRad(angle))
  const largeArc = value > 50 ? 1 : 0
  const track = `M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}`
  const fill  = `M ${cx - R} ${cy} A ${R} ${R} 0 ${largeArc} 1 ${x} ${y}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <svg width={100} height={60} style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="fgGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor="#EF4444" />
            <stop offset="50%"  stopColor="#94A3B8" />
            <stop offset="100%" stopColor="#10B981" />
          </linearGradient>
        </defs>
        <path d={track} fill="none" stroke={`${color}20`} strokeWidth={8} strokeLinecap="round" />
        <path d={fill}  fill="none" stroke={color}        strokeWidth={8} strokeLinecap="round"
              style={{ filter: isModern ? `drop-shadow(0 0 5px ${color})` : 'none' }} />
        <circle cx={x} cy={y} r={4.5} fill={t.bgCard} stroke={color} strokeWidth={2}
                style={{ filter: isModern ? `drop-shadow(0 0 6px ${color})` : 'none' }} />
        <text x={cx} y={cy + 4} textAnchor="middle" fill={color} fontSize={18} fontWeight={800} fontFamily="monospace">
          {value}
        </text>
      </svg>
      <div style={{
        background: `${color}18`, border: `1px solid ${color}35`,
        borderRadius: 20, padding: '3px 10px',
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, color, fontFamily: t.font, letterSpacing: 0.3 }}>
          {zone.label}
        </span>
      </div>
      <div style={{ fontSize: 7, color: t.textDim, fontFamily: t.fontUI, letterSpacing: 0.5 }}>FEAR & GREED INDEX</div>
    </div>
  )
}

// ─── BTC Dominance + Altcoin season ──────────────────────────────
function DominancePanel({ btcDom, altSeason, t, isModern }) {
  const seasonMap = {
    alt_season: { label: 'ALT SEASON', color: t.purple, icon: '🌊', desc: 'Altcoins outperforming BTC' },
    btc_season: { label: 'BTC SEASON', color: t.amber,  icon: '₿',  desc: 'Bitcoin leading the market' },
    neutral:    { label: 'NEUTRAL',    color: t.textMuted, icon: '⚖', desc: 'Mixed market conditions' },
  }
  const s = seasonMap[altSeason] || seasonMap.neutral
  const altPct = 100 - (btcDom || 55)

  return (
    <div style={{
      background: t.bgCard, border: `1px solid ${t.border}`,
      borderRadius: t.radius, padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, fontWeight: 600, letterSpacing: 0.6 }}>
        MARKET DOMINANCE
      </div>

      {/* BTC vs ALT bars */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: t.amber, fontFamily: t.font, fontWeight: 700 }}>BTC {(btcDom || 0).toFixed(1)}%</span>
          <span style={{ fontSize: 9, color: t.purple, fontFamily: t.font, fontWeight: 700 }}>ALTS {altPct.toFixed(1)}%</span>
        </div>
        <div style={{ height: 8, background: `${t.purple}30`, borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
          <div style={{
            width: `${btcDom || 0}%`, height: '100%', background: t.amber, borderRadius: 4,
            boxShadow: isModern ? `0 0 8px ${t.amber}50` : 'none', transition: 'width 0.5s',
          }} />
        </div>
      </div>

      {/* Season badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: `${s.color}10`, border: `1px solid ${s.color}28`,
        borderRadius: t.radius, padding: '8px 10px',
      }}>
        <span style={{ fontSize: 18 }}>{s.icon}</span>
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, color: s.color, fontFamily: t.fontUI }}>{s.label}</div>
          <div style={{ fontSize: 8, color: t.textMuted, fontFamily: t.fontUI }}>{s.desc}</div>
        </div>
      </div>
    </div>
  )
}

// ─── Open Interest table ──────────────────────────────────────────
function OITable({ oiUsd, t, isModern }) {
  const rows = [
    { coin: 'btc', label: 'Bitcoin',  sym: 'BTC', color: t.amber  },
    { coin: 'eth', label: 'Ethereum', sym: 'ETH', color: t.purple },
    { coin: 'sol', label: 'Solana',   sym: 'SOL', color: t.cyan   },
  ]
  const fmtUsd = v => !v ? '—' : v >= 1e9 ? `$${(v/1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(0)}M` : `$${v.toFixed(0)}`

  return (
    <div style={{
      background: t.bgCard, border: `1px solid ${t.border}`,
      borderRadius: t.radius, padding: '12px 14px', marginBottom: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>OPEN INTEREST</span>
        <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>Total leveraged positions (perps)</span>
      </div>
      {rows.map(r => {
        const data = oiUsd?.[r.coin]
        const oi   = data?.oi_usd || 0
        return (
          <div key={r.coin} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '7px 0', borderBottom: `1px solid ${t.border}20`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 28, height: 28, borderRadius: t.radius,
                background: `${r.color}18`, border: `1px solid ${r.color}30`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontWeight: 700, color: r.color, fontFamily: t.font,
              }}>{r.sym}</div>
              <span style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI }}>{r.label}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: oi > 5e9 ? t.amber : t.text, fontFamily: t.font }}>
                {fmtUsd(oi)}
              </div>
              {oi > 1e10 && <div style={{ fontSize: 7, color: t.bear, fontFamily: t.fontUI }}>EXTREMELY HIGH</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Long / Short ratio ───────────────────────────────────────────
function LSRatioRow({ sym, data, color, t, isModern }) {
  const longPct  = data?.long_pct ?? null
  const shortPct = data?.short_pct ?? null
  if (longPct === null) return null

  const bull   = longPct >= 55
  const bear   = longPct <= 45
  const signal = bull ? 'LONGS HEAVY' : bear ? 'SHORTS HEAVY' : 'BALANCED'
  const sigCol = bull ? t.bull : bear ? t.bear : t.textMuted

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: color || t.text, fontFamily: t.font }}>{sym}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <StatusChip label={signal} color={sigCol} t={t} />
          <span style={{ fontSize: 9, color: t.textMuted, fontFamily: t.font }}>
            L {longPct.toFixed(1)}% · S {shortPct.toFixed(1)}%
          </span>
        </div>
      </div>
      <div style={{ height: 8, background: `${t.bear}30`, borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          width: `${longPct}%`, height: '100%',
          background: `linear-gradient(90deg, ${t.bull}, ${t.bull}AA)`,
          borderRadius: 4, transition: 'width 0.5s',
          boxShadow: isModern ? `0 0 6px ${t.bull}50` : 'none',
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 7, color: t.bull, fontFamily: t.fontUI }}>LONG</span>
        <span style={{ fontSize: 7, color: t.bear, fontFamily: t.fontUI }}>SHORT</span>
      </div>
    </div>
  )
}

// ─── Funding rate row ─────────────────────────────────────────────
function FundingRow({ sym, rate, t }) {
  const pct    = rate * 100
  const absP   = Math.abs(pct)
  const signal = pct > 0.05 ? 'LONGS PAY HIGH' : pct > 0.01 ? 'LONGS PAY' : pct < -0.01 ? 'SHORTS PAY' : 'NEUTRAL'
  const color  = pct > 0.05 ? t.bear : pct > 0.01 ? '#F97316' : pct < -0.01 ? t.purple : t.textDim
  const bgc    = pct > 0.05 ? `${t.bear}14` : pct > 0.01 ? '#F9731614' : pct < -0.01 ? `${t.purple}14` : `${t.textDim}0A`

  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '6px 0', borderBottom: `1px solid ${t.border}18`,
    }}>
      <span style={{ fontSize: 9, color: t.textMuted, fontFamily: t.font, minWidth: 60 }}>{sym}</span>
      <div style={{
        background: bgc, border: `1px solid ${color}28`,
        borderRadius: 20, padding: '2px 8px',
      }}>
        <span style={{ fontSize: 8, color, fontFamily: t.font, fontWeight: 700 }}>{signal}</span>
      </div>
      <span style={{
        fontSize: 10, fontWeight: 700, color, fontFamily: t.font,
        minWidth: 68, textAlign: 'right',
      }}>
        {pct >= 0 ? '+' : ''}{pct.toFixed(4)}%
      </span>
    </div>
  )
}

// ─── Liquidations badge ───────────────────────────────────────────
function LiqBadge({ raw, t, isModern }) {
  const isHigh = raw > 5e8
  const fmt    = raw > 1e9 ? `$${(raw/1e9).toFixed(2)}B` : raw > 1e6 ? `$${(raw/1e6).toFixed(0)}M` : '—'
  const color  = isHigh ? t.bear : t.textMuted

  return (
    <div style={{
      background: isHigh ? `${t.bear}12` : t.bgCard,
      border: `1px solid ${color}30`, borderRadius: t.radius,
      padding: '10px 12px',
    }}>
      <div style={{ fontSize: 8, color: t.textMuted, fontFamily: t.fontUI, marginBottom: 4, letterSpacing: 0.5 }}>
        24H LIQUIDATIONS
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: t.font, letterSpacing: -0.5 }}>
        {fmt}
      </div>
      <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginTop: 3 }}>
        {isHigh ? '⚠ Elevated forced closures' : 'Leveraged positions closed by exchange'}
      </div>
    </div>
  )
}

// ─── News line ────────────────────────────────────────────────────
function NewsLine({ item, t, isModern }) {
  const impact   = item.impact?.toUpperCase()
  const iColor   = impact === 'HIGH' ? t.bear : impact === 'MEDIUM' ? t.amber : t.textDim
  const catMap   = { INDIA: t.accent, CRYPTO: t.purple, REGULATOR: t.bull }
  const srcColor = catMap[item.category] || t.textDim

  return (
    <div
      style={{
        display: 'grid', gridTemplateColumns: '22px 1fr auto',
        gap: 6, padding: '6px 10px', borderBottom: `1px solid ${t.border}18`,
        cursor: 'pointer', alignItems: 'start', transition: 'background 0.1s',
      }}
      onClick={() => item.url && window.open(item.url, '_blank', 'noopener')}
      onMouseEnter={e => e.currentTarget.style.background = t.bgRow}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <div style={{
        width: 20, height: 20, borderRadius: 3,
        background: `${srcColor}18`, color: srcColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 7, fontWeight: 800, fontFamily: t.font, flexShrink: 0,
        border: `1px solid ${srcColor}30`,
      }}>{item.src || (item.category || 'N')[0]}</div>
      <div style={{
        fontSize: 9, color: t.text, lineHeight: 1.4, fontFamily: t.fontSans,
        overflow: 'hidden', display: '-webkit-box',
        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
      }}>{item.headline || item.title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
        <span style={{ fontSize: 7, color: t.textMuted, fontFamily: t.font, whiteSpace: 'nowrap' }}>{item.time}</span>
        {impact && (
          <span style={{
            fontSize: 7, padding: '1px 5px', borderRadius: 20,
            background: `${iColor}15`, color: iColor, border: `1px solid ${iColor}30`,
            fontFamily: t.font, fontWeight: 700,
          }}>{impact === 'HIGH' ? '● HI' : '● MD'}</span>
        )}
      </div>
    </div>
  )
}

// ─── Position row ─────────────────────────────────────────────────
function PositionRow({ pos, t }) {
  const pnl = pos.unrealized_pnl ?? pos.unrl_pnl ?? 0
  const pnlColor = pnl >= 0 ? t.bull : t.bear
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '100px 55px 1fr auto',
      padding: '5px 10px', borderBottom: `1px solid ${t.border}18`,
      fontSize: 9, fontFamily: t.font, alignItems: 'center',
    }}>
      <span style={{ color: t.cyan, fontWeight: 600 }}>{pos.symbol}</span>
      <span style={{ color: pos.side === 'LONG' ? t.bull : t.bear }}>{pos.side}</span>
      <span style={{ color: t.textMuted }}>{pos.qty} @ {pos.avg_price || pos.avg}</span>
      <span style={{
        color: pnlColor, fontWeight: 700,
        background: `${pnlColor}12`, borderRadius: 20, padding: '1px 7px',
      }}>
        {pnl >= 0 ? '+' : ''}₹{Math.abs(pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
      </span>
    </div>
  )
}

// ─── Active positions ─────────────────────────────────────────────
function ActivePositionsPanel({ positions, t, isModern }) {
  if (!positions?.length) return null
  const totalUnrl = positions.reduce((s, p) => s + (p.unrealized_pnl ?? p.unrl_pnl ?? 0), 0)
  const pnlColor  = totalUnrl >= 0 ? t.bull : t.bear

  return (
    <div style={{
      border: `1px solid ${pnlColor}30`,
      borderRadius: t.radius, background: t.bgCard, marginBottom: 18,
      boxShadow: isModern ? `0 0 20px ${pnlColor}12` : t.shadowCard,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '7px 10px', borderBottom: `1px solid ${t.border}`,
        background: `${pnlColor}08`,
      }}>
        <span style={{ fontSize: 10, color: t.accent, fontFamily: t.fontUI, fontWeight: 700 }}>
          OPEN POSITIONS  <span style={{ color: t.textMuted, fontWeight: 400 }}>({positions.length})</span>
        </span>
        <span style={{
          fontSize: 13, fontWeight: 800, color: pnlColor, fontFamily: t.font,
          background: `${pnlColor}15`, borderRadius: 20, padding: '2px 10px',
        }}>
          {totalUnrl >= 0 ? '+' : ''}₹{Math.abs(totalUnrl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
        </span>
      </div>
      {positions.slice(0, 5).map((p, i) => <PositionRow key={i} pos={p} t={t} />)}
    </div>
  )
}

// ─── India Market Section ─────────────────────────────────────────
function IndiaMarketSection({ s, tickers, t, isModern }) {
  const nifty = tickers['NIFTY50']
  const bankn = tickers['BANKNIFTY']
  const vix   = s?.india_vix
  const fii   = s?.fii_flow_today_cr ?? 0
  const dii   = s?.dii_flow_today_cr ?? 0
  const flowMax  = Math.max(Math.abs(fii), Math.abs(dii), 500)
  const extraIdx = s?.extra_indices || {}
  const fmtIdx   = v => v ? v.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'

  return (
    <div style={{ marginBottom: 24 }}>
      <SectionHdr
        label="INDIA MARKET" icon="🇮🇳"
        sub="NSE / BSE — Live market overview"
        badge={`VIX ${vix ? vix.toFixed(1) : '—'}`}
        color={t.accent} t={t} isModern={isModern}
      />

      {/* Primary indices */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
        <MetCard label="NIFTY 50"   value={nifty?.price ?? '—'} change={nifty?.change}
                 color={t.accent} t={t} isModern={isModern}
                 desc="NSE benchmark index" />
        <MetCard label="BANK NIFTY" value={bankn?.price ?? '—'} change={bankn?.change}
                 color={t.accent} t={t} isModern={isModern}
                 desc="Banking sector index" />
        <VixCard vix={vix} t={t} isModern={isModern} />
      </div>

      {/* Secondary indices */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 }}>
        <MetCard small label="SENSEX" value={fmtIdx(extraIdx.SENSEX?.price)}
                 change={extraIdx.SENSEX?.change} color={t.accent} t={t} isModern={isModern}
                 desc="BSE benchmark" />
        <MetCard small label="MIDCAP 100" value={fmtIdx(extraIdx.MIDCAP?.price)}
                 change={extraIdx.MIDCAP?.change} color={t.cyan} t={t} isModern={isModern}
                 desc="Mid-cap index" />
        <MetCard small label="SMALLCAP 100" value={fmtIdx(extraIdx.SMALL?.price)}
                 change={extraIdx.SMALL?.change} color={t.textMuted} t={t} isModern={isModern}
                 desc="Small-cap index" />
      </div>

      {/* Market breadth */}
      {s?.india_breadth && <BreadthBar breadth={s.india_breadth} t={t} isModern={isModern} />}

      {/* Sector heatmap */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>SECTOR PERFORMANCE</span>
          <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>NSE sector indices · today</span>
        </div>
        <SectorHeatmap sectorData={s?.sector_performance} t={t} isModern={isModern} />
      </div>

      {/* FII / DII flows */}
      <div style={{
        background: t.bgCard, border: `1px solid ${t.border}`,
        borderRadius: t.radius, padding: '12px 14px',
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: t.text, fontFamily: t.fontUI, marginBottom: 12 }}>
          INSTITUTIONAL FLOWS
          <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, fontWeight: 400, marginLeft: 8 }}>
            today's net buying / selling in ₹ Crore
          </span>
        </div>
        <FlowBar label="FII" sublabel="Foreign Institutional Investors" value={fii} max={flowMax} color={t.bull} t={t} />
        <FlowBar label="DII" sublabel="Domestic Institutional Investors" value={dii} max={flowMax} color={t.cyan} t={t} />
      </div>
    </div>
  )
}

// ─── Crypto Market Section ────────────────────────────────────────
function CryptoMarketSection({ s, tickers, t, isModern }) {
  const btc = tickers['BTCUSD']
  const eth = tickers['ETHUSD']
  const sol = tickers['SOLUSD']
  const fg       = s?.fear_greed ?? 50
  const btcDom   = s?.btc_dominance_pct ?? 55
  const liqRaw   = s?.coinglass?.total_liquidations_24h ?? 0
  const lsRatios = s?.long_short_ratios || {}
  const oiUsd    = s?.open_interest_usd || {}
  const altSeason = s?.altcoin_season || 'neutral'

  return (
    <div style={{ marginBottom: 24 }}>
      <SectionHdr
        label="CRYPTO MARKET" icon="₿"
        sub="Derivatives, sentiment & on-chain data · 24/7"
        badge="LIVE"
        color={t.purple} t={t} isModern={isModern}
      />

      {/* Price cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
        <MetCard label="BTC / USD" value={btc?.price ?? '—'} change={btc?.change}
                 color={t.amber}  t={t} isModern={isModern} desc="Bitcoin spot price" />
        <MetCard label="ETH / USD" value={eth?.price ?? '—'} change={eth?.change}
                 color={t.purple} t={t} isModern={isModern} desc="Ethereum spot price" />
        <MetCard label="SOL / USD" value={sol?.price ?? '—'} change={sol?.change}
                 color={t.cyan}   t={t} isModern={isModern} desc="Solana spot price" />
      </div>

      {/* Sentiment row: F&G + Dominance */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div style={{
          background: t.bgCard, border: `1px solid ${t.border}`,
          borderRadius: t.radius, padding: '14px 10px',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
        }}>
          <FGGauge value={fg} t={t} isModern={isModern} />
        </div>
        <DominancePanel btcDom={btcDom} altSeason={altSeason} t={t} isModern={isModern} />
      </div>

      {/* Liquidations */}
      <div style={{ marginBottom: 10 }}>
        <LiqBadge raw={liqRaw} t={t} isModern={isModern} />
      </div>

      {/* Open Interest */}
      <OITable oiUsd={oiUsd} t={t} isModern={isModern} />

      {/* Long / Short ratios */}
      <div style={{
        background: t.bgCard, border: `1px solid ${t.border}`,
        borderRadius: t.radius, padding: '12px 14px', marginBottom: 8,
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: t.text, fontFamily: t.fontUI, marginBottom: 4 }}>
          LONG / SHORT RATIO
        </div>
        <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginBottom: 12 }}>
          Share of open positions that are long vs short (4H, top accounts)
        </div>
        <LSRatioRow sym="BTC" color={t.amber}  data={lsRatios.btc} t={t} isModern={isModern} />
        <LSRatioRow sym="ETH" color={t.purple} data={lsRatios.eth} t={t} isModern={isModern} />
        <LSRatioRow sym="SOL" color={t.cyan}   data={lsRatios.sol} t={t} isModern={isModern} />
        <LSRatioRow sym="BNB" color={t.amber}  data={lsRatios.bnb} t={t} isModern={isModern} />
      </div>

      {/* Funding rates */}
      <div style={{
        background: t.bgCard, border: `1px solid ${t.border}`,
        borderRadius: t.radius, padding: '12px 14px',
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: t.text, fontFamily: t.fontUI, marginBottom: 4 }}>
          FUNDING RATES
        </div>
        <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginBottom: 10 }}>
          Cost of holding perpetual positions — high positive = overheated longs
        </div>
        <FundingRow sym="BTC PERP"  rate={s?.btc_funding_8h  ?? 0} t={t} />
        <FundingRow sym="ETH PERP"  rate={s?.eth_funding_8h  ?? 0} t={t} />
        <FundingRow sym="SOL PERP"  rate={s?.sol_funding_8h  ?? 0} t={t} />
        <FundingRow sym="BNB PERP"  rate={s?.bnb_funding_8h  ?? 0} t={t} />
        <FundingRow sym="AVAX PERP" rate={s?.avax_funding_8h ?? 0} t={t} />
        <FundingRow sym="XRP PERP"  rate={s?.xrp_funding_8h  ?? 0} t={t} />
      </div>
    </div>
  )
}

// ─── Overview layout ──────────────────────────────────────────────
function OverviewContent({ sentiment, positions, newsFeed, t, isModern }) {
  const tickers = useDataStore(s => s.tickers)
  return (
    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 260px', overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', overflowY: 'auto' }}>
        <ActivePositionsPanel positions={positions} t={t} isModern={isModern} />
        <IndiaMarketSection  s={sentiment} tickers={tickers} t={t} isModern={isModern} />
        <CryptoMarketSection s={sentiment} tickers={tickers} t={t} isModern={isModern} />
      </div>

      {/* Live news column */}
      <div style={{ borderLeft: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{
          padding: '7px 10px', borderBottom: `1px solid ${t.border}`,
          background: t.headerGrad,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: t.accent, fontFamily: t.fontUI }}>LIVE NEWS</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: t.bull,
                          boxShadow: isModern ? `0 0 6px ${t.bull}` : 'none' }} />
            <span style={{ fontSize: 8, color: t.bull, fontFamily: t.font }}>LIVE</span>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {newsFeed.length === 0
            ? <div style={{ padding: '24px 10px', fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, textAlign: 'center' }}>
                Waiting for news feed…
              </div>
            : newsFeed.slice(0, 30).map((item, i) => <NewsLine key={i} item={item} t={t} isModern={isModern} />)
          }
        </div>
      </div>
    </div>
  )
}

// ─── Stocks page ──────────────────────────────────────────────────
function StocksPage({ signals, tickers, t, isModern }) {
  const indiaSignals = useMemo(() => signals.filter(s => s.market === 'india' || s.market === 'india_stock'), [signals])
  const volumeSpikes = useMemo(() =>
    indiaSignals.filter(s => parseFloat(s.vol) > 2).sort((a, b) => parseFloat(b.vol) - parseFloat(a.vol))
  , [indiaSignals])

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
      {volumeSpikes.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <SectionHdr label="UNUSUAL VOLUME" icon="📊" sub="Stocks with >2× normal volume — institutional activity signal" color={t.amber} t={t} isModern={isModern} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {volumeSpikes.slice(0, 10).map(s => (
              <div key={s.symbol} style={{
                background: `${t.amber}10`, border: `1px solid ${t.amber}30`,
                borderRadius: t.radius, padding: '5px 12px',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: t.amber, fontFamily: t.font }}>{s.symbol}</span>
                <span style={{
                  fontSize: 8, color: t.bear, fontFamily: t.font, fontWeight: 600,
                  background: `${t.amber}20`, borderRadius: 20, padding: '1px 5px',
                }}>×{parseFloat(s.vol).toFixed(1)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <SectionHdr label="ALL TRACKED STOCKS" icon="📈" sub="NSE / BSE watchlist" color={t.accent} t={t} isModern={isModern} />
      {indiaSignals.length === 0
        ? <div style={{ padding: 30, color: t.textMuted, fontSize: 10, fontFamily: t.fontUI, textAlign: 'center' }}>
            Scanner will populate during market hours (9:15 AM – 3:30 PM IST)
          </div>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 }}>
            {indiaSignals.map(s => {
              const tick = tickers[s.symbol]
              const price = tick?.price ?? s.entry_price ?? s.price
              const chg = tick?.change ?? s.chg
              const chgNum = parseFloat(chg)
              const chgColor = !chg || isNaN(chgNum) ? t.textDim : chgNum >= 0 ? t.bull : t.bear
              const vol  = parseFloat(s.vol) || 0
              const isGo = s.verdict === 'GO'
              return (
                <div key={s.symbol} style={{
                  border: `1px solid ${isGo ? t.bull : t.border}30`,
                  borderLeft: `3px solid ${isGo ? t.bull : t.textDim}`,
                  borderRadius: t.radius, background: t.bgCard, padding: '10px 12px',
                  boxShadow: isModern && isGo ? `0 0 12px ${t.bull}18` : t.shadowCard,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: t.cyan, fontFamily: t.font }}>{s.symbol}</span>
                    <span style={{
                      fontSize: 8, padding: '2px 7px', borderRadius: 20, fontFamily: t.font, fontWeight: 700,
                      background: isGo ? `${t.bull}18` : `${t.amber}18`,
                      color: isGo ? t.bull : t.amber,
                      border: `1px solid ${isGo ? t.bull : t.amber}40`,
                    }}>{s.verdict}</span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: t.text, fontFamily: t.font, marginBottom: 4 }}>
                    {typeof price === 'number' ? `₹${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : price}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 9, color: chgColor, fontFamily: t.font, fontWeight: 600 }}>
                      {!chg || isNaN(chgNum) ? '—' : `${chgNum >= 0 ? '▲' : '▼'} ${Math.abs(chgNum).toFixed(2)}%`}
                    </span>
                    {vol > 0 && (
                      <span style={{ fontSize: 8, color: vol > 2 ? t.amber : t.textDim, fontFamily: t.font }}>
                        Vol ×{vol.toFixed(1)}
                      </span>
                    )}
                  </div>
                  {s.score && (
                    <div style={{ marginTop: 5, height: 3, background: `${t.accent}20`, borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ width: `${(s.score / 10) * 100}%`, height: '100%', background: t.accent, borderRadius: 2 }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      }
    </div>
  )
}

// ─── Crypto page ──────────────────────────────────────────────────
function CryptoPage({ signals, tickers, sentiment, t, isModern }) {
  const cryptoSignals = useMemo(() => signals.filter(s => s.market === 'crypto'), [signals])
  const lsRatios = sentiment?.long_short_ratios || {}
  const oiUsd    = sentiment?.open_interest_usd || {}
  const fmtOi    = v => v >= 1e9 ? `$${(v/1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(0)}M` : null

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
      <SectionHdr label="CRYPTO PERPS — DELTA EXCHANGE" icon="🔮" sub="Live perpetual futures data" color={t.purple} t={t} isModern={isModern} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8, marginBottom: 18 }}>
        {['BTCUSD','ETHUSD','SOLUSD','BNBUSD','AVAXUSD','XRPUSD'].map(sym => {
          const tick   = tickers[sym]
          const sig    = cryptoSignals.find(s => s.symbol === sym)
          const chg    = tick?.change ?? sig?.chg
          const chgNum = parseFloat(chg)
          const isPos  = chgNum >= 0
          const chgColor = !chg || isNaN(chgNum) ? t.textDim : isPos ? t.bull : t.bear
          const coin   = sym.replace('USD', '').toLowerCase()
          const ls     = lsRatios[coin]
          const oi     = oiUsd[coin]
          const fundKey = sym.toLowerCase().replace('usd', '_funding_8h')
          const funding = sentiment?.[fundKey]
          const isGo   = sig?.verdict === 'GO'

          return (
            <div key={sym} style={{
              border: `1px solid ${t.purple}28`,
              borderLeft: `3px solid ${t.purple}`,
              borderRadius: t.radius, background: t.bgCard, padding: '11px 12px',
              boxShadow: isModern ? `0 0 12px ${t.purple}10` : t.shadowCard,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: t.purple, fontFamily: t.font }}>
                  {sym.replace('USD', '')}
                </span>
                {sig && (
                  <span style={{
                    fontSize: 8, padding: '2px 7px', borderRadius: 20, fontFamily: t.font, fontWeight: 700,
                    background: isGo ? `${t.bull}18` : `${t.amber}18`,
                    color: isGo ? t.bull : t.amber, border: `1px solid ${isGo ? t.bull : t.amber}40`,
                  }}>{sig.verdict}</span>
                )}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: t.text, fontFamily: t.font, marginBottom: 4 }}>
                {tick?.price ?? sig?.price ?? '—'}
              </div>
              {!isNaN(chgNum) && (
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 2,
                  background: `${chgColor}14`, border: `1px solid ${chgColor}25`,
                  borderRadius: 20, padding: '1px 7px', marginBottom: 8,
                }}>
                  <span style={{ fontSize: 9, color: chgColor, fontFamily: t.font, fontWeight: 700 }}>
                    {isPos ? '▲' : '▼'} {Math.abs(chgNum).toFixed(2)}%
                  </span>
                </div>
              )}
              <div style={{ borderTop: `1px solid ${t.border}30`, paddingTop: 7, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {oi?.oi_usd > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>Open Interest</span>
                    <span style={{ fontSize: 9, fontWeight: 600, color: t.text, fontFamily: t.font }}>{fmtOi(oi.oi_usd)}</span>
                  </div>
                )}
                {ls && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>Long/Short</span>
                    <span style={{ fontSize: 9, fontWeight: 600,
                                   color: ls.long_pct >= 55 ? t.bull : ls.long_pct <= 45 ? t.bear : t.textMuted,
                                   fontFamily: t.font }}>
                      {ls.long_pct.toFixed(0)}% / {ls.short_pct.toFixed(0)}%
                    </span>
                  </div>
                )}
                {funding !== undefined && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>Funding /8h</span>
                    <span style={{ fontSize: 9, fontWeight: 600,
                                   color: funding > 0.0003 ? t.bear : funding < 0 ? t.purple : t.bull,
                                   fontFamily: t.font }}>
                      {funding >= 0 ? '+' : ''}{(funding * 100).toFixed(4)}%
                    </span>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Derivatives summary */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ border: `1px solid ${t.border}`, borderRadius: t.radius, padding: 14, background: t.bgCard }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: t.text, fontFamily: t.fontUI, marginBottom: 12 }}>MARKET SENTIMENT</div>
          <FGGauge value={sentiment?.fear_greed ?? 50} t={t} isModern={isModern} />
          <div style={{ marginTop: 12 }}>
            <DominancePanel btcDom={sentiment?.btc_dominance_pct} altSeason={sentiment?.altcoin_season} t={t} isModern={isModern} />
          </div>
        </div>
        <div style={{ border: `1px solid ${t.border}`, borderRadius: t.radius, padding: 14, background: t.bgCard }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: t.text, fontFamily: t.fontUI, marginBottom: 8 }}>DERIVATIVES</div>
          <LiqBadge raw={sentiment?.coinglass?.total_liquidations_24h ?? 0} t={t} isModern={isModern} />
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginBottom: 8 }}>FUNDING RATES</div>
            <FundingRow sym="BTC"  rate={sentiment?.btc_funding_8h  ?? 0} t={t} />
            <FundingRow sym="ETH"  rate={sentiment?.eth_funding_8h  ?? 0} t={t} />
            <FundingRow sym="SOL"  rate={sentiment?.sol_funding_8h  ?? 0} t={t} />
            <FundingRow sym="BNB"  rate={sentiment?.bnb_funding_8h  ?? 0} t={t} />
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginBottom: 8 }}>LONG / SHORT (4H)</div>
            <LSRatioRow sym="BTC" color={t.amber}  data={lsRatios.btc} t={t} isModern={isModern} />
            <LSRatioRow sym="ETH" color={t.purple} data={lsRatios.eth} t={t} isModern={isModern} />
            <LSRatioRow sym="SOL" color={t.cyan}   data={lsRatios.sol} t={t} isModern={isModern} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Commodities page ─────────────────────────────────────────────
function CommoditiesPage({ signals, tickers, t, isModern }) {
  const commSignals = useMemo(() => signals.filter(s => s.market === 'commodity' || s.tag === 'MCX' || s.tag === 'NCDEX'), [signals])
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
      <SectionHdr label="COMMODITIES" icon="🏭" sub="MCX / NCDEX — Futures market" color={t.amber} t={t} isModern={isModern} />
      {commSignals.length === 0
        ? <div style={{ padding: 30, color: t.textMuted, fontSize: 10, fontFamily: t.fontUI, textAlign: 'center' }}>
            MCX scanner runs during market hours
          </div>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(185px, 1fr))', gap: 8 }}>
            {commSignals.map(s => {
              const tick = tickers[s.symbol]
              const price = tick?.price ?? s.entry_price ?? s.price
              const chg   = tick?.change ?? s.chg
              const chgNum = parseFloat(chg)
              const chgColor = !chg || isNaN(chgNum) ? t.textDim : chgNum >= 0 ? t.bull : t.bear
              return (
                <div key={s.symbol} style={{
                  border: `1px solid ${t.amber}28`, borderLeft: `3px solid ${t.amber}`,
                  borderRadius: t.radius, background: t.bgCard, padding: '10px 12px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: t.amber, fontFamily: t.font }}>{s.symbol}</span>
                    <span style={{ fontSize: 8, color: t.textMuted, fontFamily: t.fontUI }}>{s.tag}</span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: t.text, fontFamily: t.font, marginBottom: 4 }}>
                    {typeof price === 'number' ? `₹${price.toLocaleString('en-IN')}` : price}
                  </div>
                  <span style={{ fontSize: 9, color: chgColor, fontFamily: t.font, fontWeight: 600 }}>
                    {!chg || isNaN(chgNum) ? '—' : `${chgNum >= 0 ? '▲' : '▼'} ${Math.abs(chgNum).toFixed(2)}%`}
                  </span>
                </div>
              )
            })}
          </div>
        )
      }
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────
export default function HomeDashboard() {
  const t = useTheme()
  const isModern  = t.name === 'modern'
  const homeTab    = useTerminalStore(s => s.homeTab)
  const setHomeTab = useTerminalStore(s => s.setHomeTab)
  const newsFeed   = useDataStore(s => s.newsFeed)
  const signals    = useDataStore(s => s.signals)
  const positions  = useDataStore(s => s.positions)
  const tickers    = useDataStore(s => s.tickers)

  const { data: sentimentData } = useQuery({
    queryKey: ['marketSentiment'],
    queryFn: getMarketSentiment,
    refetchInterval: 60_000,
  })
  const sentiment = sentimentData || null

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <ErrorBoundary scope="TV WATCHLIST">
        <TVWatchlist />
      </ErrorBoundary>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <SubTabBar activeTab={homeTab} setTab={setHomeTab} t={t} />
        <MarketPulse sentiment={sentiment} />

        {homeTab === 'OVERVIEW'     && <OverviewContent    sentiment={sentiment} positions={positions} newsFeed={newsFeed} t={t} isModern={isModern} />}
        {homeTab === 'STOCKS'       && <StocksPage         signals={signals} tickers={tickers} t={t} isModern={isModern} />}
        {homeTab === 'CRYPTO'       && <CryptoPage         signals={signals} tickers={tickers} sentiment={sentiment} t={t} isModern={isModern} />}
        {homeTab === 'COMMODITIES'  && <CommoditiesPage    signals={signals} tickers={tickers} t={t} isModern={isModern} />}
      </div>
    </div>
  )
}
