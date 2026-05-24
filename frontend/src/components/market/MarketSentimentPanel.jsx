// src/components/market/MarketSentimentPanel.jsx
// Market Pulse panel — Fear/Greed, BTC dominance, India VIX/FII,
// funding rates, and live news headlines.
//
// Data sources:
//   • alternative.me/fng  — Fear & Greed (direct, free, CORS-OK)
//   • coingecko/global    — total market cap, BTC dom, volume (direct, free)
//   • /market/sentiment   — backend aggregation (F&G history, funding, FII/DII)
//   • store newsFeed      — live headlines

import { useEffect, useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getMarketSentiment } from '../../lib/api'
import { useDataStore, useTheme } from '../../store'

// ─── Fear & Greed colour mapping ────────────────────────────────
function fgColor(value, t) {
  if (value <= 25) return t.bear
  if (value <= 45) return '#F7931A'
  if (value <= 55) return t.textDim
  if (value <= 75) return '#6ABAFF'
  return t.bull
}

function fgLabel(value) {
  if (value <= 25) return 'EXTREME FEAR'
  if (value <= 45) return 'FEAR'
  if (value <= 55) return 'NEUTRAL'
  if (value <= 75) return 'GREED'
  return 'EXTREME GREED'
}

// Arc gauge: draws an SVG semicircle gauge for 0–100 value
function FearGreedGauge({ value, t }) {
  const isModern = t.name === 'modern'
  const color    = fgColor(value, t)
  const label    = fgLabel(value)

  // Semicircle: r=38, arc from 180° → 0° (left to right)
  const R = 38
  const cx = 60, cy = 56
  const toRad = (deg) => (deg * Math.PI) / 180
  const angle = 180 - (value / 100) * 180  // 180°=0, 0°=100

  const x = cx + R * Math.cos(toRad(angle))
  const y = cy - R * Math.sin(toRad(angle))

  const trackPath = `M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}`
  const fillAngle = 180 - (value / 100) * 180
  const fx = cx + R * Math.cos(toRad(fillAngle))
  const fy = cy - R * Math.sin(toRad(fillAngle))
  const largeArc = value > 50 ? 1 : 0
  const fillPath = `M ${cx - R} ${cy} A ${R} ${R} 0 ${largeArc} 1 ${fx} ${fy}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width={120} height={68} style={{ overflow: 'visible' }}>
        {/* Track */}
        <path d={trackPath} fill="none" stroke={`${color}20`} strokeWidth={8} strokeLinecap="round" />
        {/* Fill */}
        <path d={fillPath} fill="none" stroke={color} strokeWidth={8} strokeLinecap="round"
              style={{ filter: isModern ? `drop-shadow(0 0 4px ${color})` : 'none' }} />
        {/* Needle */}
        <circle cx={x} cy={y} r={4} fill={color}
                style={{ filter: isModern ? `drop-shadow(0 0 6px ${color})` : 'none' }} />
        {/* Center value */}
        <text x={cx} y={cy + 2} textAnchor="middle" fill={color}
              fontSize={18} fontWeight={700} fontFamily="monospace">
          {value}
        </text>
      </svg>
      <div style={{ fontSize: 9, fontWeight: 700, color, fontFamily: t.font, letterSpacing: 0.5,
                    textShadow: isModern ? `0 0 8px ${color}` : 'none' }}>
        {label}
      </div>
      <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>FEAR & GREED</div>
    </div>
  )
}

// 7-day sparkline as small bars
function FGSparkline({ history, t }) {
  if (!history?.length) return null
  const max = Math.max(...history.map(h => h.value))
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 18 }}>
      {history.slice(-7).map((h, i) => {
        const pct = (h.value / max) * 100
        const color = fgColor(h.value, t)
        return (
          <div key={i} title={`${h.value} — ${fgLabel(h.value)}`} style={{
            width: 6, height: `${pct}%`,
            background: color, borderRadius: 1,
            opacity: 0.7 + (i / history.length) * 0.3,
            minHeight: 2,
          }} />
        )
      })}
    </div>
  )
}

// ─── Section header ─────────────────────────────────────────────
function SectionHdr({ label, t }) {
  const isModern = t.name === 'modern'
  return (
    <div style={{
      fontSize: 8, fontWeight: 700, color: t.textDim, fontFamily: t.font,
      letterSpacing: 1, padding: '4px 8px 2px',
      borderTop: `1px solid ${t.border}`,
      background: isModern ? 'rgba(0,200,255,0.03)' : t.headerGrad,
      textTransform: 'uppercase',
    }}>
      {label}
    </div>
  )
}

// ─── Two-column metric row ───────────────────────────────────────
function MetRow({ label, value, color, t, sub }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '2px 8px', minHeight: 18,
    }}>
      <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>{label}</span>
      <div style={{ textAlign: 'right' }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: color || t.text, fontFamily: t.font }}>
          {value}
        </span>
        {sub && <span style={{ fontSize: 8, color: t.textMuted, fontFamily: t.font, marginLeft: 4 }}>{sub}</span>}
      </div>
    </div>
  )
}

// ─── Bar with label ──────────────────────────────────────────────
function DomBar({ label, pct, color, t }) {
  return (
    <div style={{ padding: '2px 8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
        <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>{label}</span>
        <span style={{ fontSize: 8, fontWeight: 600, color, fontFamily: t.font }}>{pct?.toFixed(1)}%</span>
      </div>
      <div style={{ height: 3, background: `${color}20`, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
    </div>
  )
}

// ─── Inline news item ────────────────────────────────────────────
function NewsLine({ item, t }) {
  const isModern = t.name === 'modern'
  const impact = item.impact?.toUpperCase()
  const iColor = impact === 'HIGH' ? t.bear : impact === 'MEDIUM' ? t.amber : t.textDim
  const srcColors = {
    ET: t.amber, MC: t.amber, BS: t.amber, LM: t.amber, FE: t.amber,
    NP: t.amber, ZB: t.amber,
    CT: t.cyan,  CD: t.cyan,  DC: t.cyan,  TB: t.cyan,
    NB: t.purple, AC: t.purple, CS: t.purple, CG: t.bull,
    RBI: t.bull, SEBI: t.bull,
  }
  const srcColor = srcColors[item.src] || t.textDim

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '22px 1fr auto auto',
      gap: 5, padding: '4px 8px', alignItems: 'start',
      borderBottom: `1px solid ${t.border}20`,
      cursor: 'pointer',
    }}
    onMouseEnter={e => e.currentTarget.style.background = t.bgRow}
    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    onClick={() => item.url && window.open(item.url, '_blank', 'noopener')}
    >
      <div style={{
        width: 20, height: 20, borderRadius: 2,
        background: `${srcColor}18`, color: srcColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 6, fontWeight: 700, fontFamily: t.font, flexShrink: 0,
        border: isModern ? `1px solid ${srcColor}30` : 'none',
      }}>
        {item.src}
      </div>
      <div style={{
        fontSize: 9, color: t.text, lineHeight: 1.3, fontFamily: t.fontSans,
        overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
      }}>
        {item.headline}
      </div>
      <div style={{ fontSize: 7, color: t.textMuted, fontFamily: t.font, whiteSpace: 'nowrap', paddingTop: 1 }}>
        {item.time}
      </div>
      <div style={{
        fontSize: 7, padding: '1px 4px', borderRadius: 2,
        background: `${iColor}15`, color: iColor, fontFamily: t.font,
        border: `1px solid ${iColor}30`, whiteSpace: 'nowrap',
      }}>
        {impact === 'HIGH' ? '● HI' : '○ MD'}
      </div>
    </div>
  )
}

// ─── Funding rate coloured value ──────────────────────────────────
function FundingVal({ rate, t }) {
  const pct = (rate * 100).toFixed(4)
  const color = rate > 0.02 ? t.bear : rate > 0 ? t.bull : t.cyan
  return (
    <span style={{ color, fontFamily: t.font, fontSize: 9, fontWeight: 600 }}>
      {rate >= 0 ? '+' : ''}{pct}%
    </span>
  )
}

// ─── Dev mock ────────────────────────────────────────────────────
const DEV_SENTIMENT = {
  fear_greed: 42, fear_greed_signal: 'fear',
  btc_dominance_pct: 58.4, btc_funding_8h: 0.0100, eth_funding_8h: 0.0082, sol_funding_8h: 0.0061,
  india_vix: 14.2, fii_flow_today_cr: 3420, dii_flow_today_cr: 2100,
  institutional_bias: 'bullish', india_overall: 'bullish', india_sentiment_score: 0.42,
  coinglass: { btc_long_short: 52.4, total_liquidations_24h: 210_000_000 },
  top_news: [
    { src: 'ET',  category: 'INDIA',  headline: 'FII net buyers ₹3,420 Cr today — highest institutional buying in 3 months', time: '18m ago', impact: 'HIGH', url: '#', tags: ['INDIA'] },
    { src: 'RBI', category: 'REGULATOR', headline: 'RBI MPC holds repo rate at 6.25% — GDP forecast upgraded to 6.8% for FY26', time: '9m ago', impact: 'HIGH', url: '#', tags: ['INDIA'] },
    { src: 'CT',  category: 'CRYPTO', headline: 'Bitcoin ETF inflows hit $480M today — 7th consecutive positive flow day', time: '22m ago', impact: 'MEDIUM', url: '#', tags: ['CRYPTO'] },
    { src: 'BS',  category: 'INDIA',  headline: 'India PMI Manufacturing 57.4 — 14-month high on export demand', time: '31m ago', impact: 'MEDIUM', url: '#', tags: ['INDIA'] },
    { src: 'CD',  category: 'CRYPTO', headline: 'Ethereum upgrade boosts Layer-2 adoption — TVL crosses $80B', time: '45m ago', impact: 'MEDIUM', url: '#', tags: ['CRYPTO'] },
  ],
}

const DEV_FG_HISTORY = [
  { value: 38 }, { value: 41 }, { value: 35 }, { value: 39 },
  { value: 44 }, { value: 40 }, { value: 42 },
]

// ─── Main component ──────────────────────────────────────────────
export default function MarketSentimentPanel() {
  const t = useTheme()
  const isModern = t.name === 'modern'
  const newsFeed = useDataStore((s) => s.newsFeed)

  // ── Fear & Greed history from alternative.me (7-day, direct) ──
  const [fgHistory, setFgHistory] = useState(DEV_FG_HISTORY)
  useEffect(() => {
    if (import.meta.env.DEV) return
    fetch('https://api.alternative.me/fng/?limit=7')
      .then(r => r.json())
      .then(d => {
        const arr = (d.data || []).map(e => ({ value: parseInt(e.value, 10) })).reverse()
        if (arr.length) setFgHistory(arr)
      })
      .catch(() => {})
  }, [])

  // ── CoinGecko global market (BTC dom + total cap) ─────────────
  const [cgGlobal, setCgGlobal] = useState(null)
  useEffect(() => {
    if (import.meta.env.DEV) return
    fetch('https://api.coingecko.com/api/v3/global')
      .then(r => r.json())
      .then(d => setCgGlobal(d.data || null))
      .catch(() => {})
  }, [])

  // ── Backend sentiment (fear_greed, funding, FII, India VIX) ───
  const { data: sentiment } = useQuery({
    queryKey: ['marketSentiment'],
    queryFn: getMarketSentiment,
    refetchInterval: 60_000,
  })

  const s = (import.meta.env.DEV && !sentiment) ? DEV_SENTIMENT : (sentiment || DEV_SENTIMENT)

  // Live news: prefer store, fall back to backend top_news
  const headlines = useMemo(() => {
    const feed = newsFeed.length ? newsFeed : s.top_news || []
    return feed
      .filter(n => n.headline || n.title)
      .slice(0, 6)
      .map(n => ({ ...n, headline: n.headline || n.title }))
  }, [newsFeed, s.top_news])

  // BTC dom: prefer CoinGecko live, fall back to backend
  const btcDom = cgGlobal?.market_cap_percentage?.btc ?? s.btc_dominance_pct ?? 58.4
  const altsDom = cgGlobal ? (100 - btcDom) : (100 - btcDom)
  const totalMcap = cgGlobal?.total_market_cap?.usd
  const totalVol  = cgGlobal?.total_volume?.usd
  const mcapFmt = totalMcap
    ? totalMcap > 1e12 ? `$${(totalMcap / 1e12).toFixed(2)}T`
                       : `$${(totalMcap / 1e9).toFixed(0)}B`
    : '—'
  const volFmt = totalVol
    ? totalVol > 1e9 ? `$${(totalVol / 1e9).toFixed(0)}B` : `$${(totalVol / 1e6).toFixed(0)}M`
    : '—'

  const fgVal  = s.fear_greed ?? 42
  const vix    = s.india_vix
  const vixColor = vix > 20 ? t.bear : vix > 15 ? t.amber : t.bull
  const vixLabel = vix > 20 ? 'HIGH' : vix > 15 ? 'MED' : 'LOW'

  const fii = s.fii_flow_today_cr
  const dii = s.dii_flow_today_cr
  const fiiColor = fii > 0 ? t.bull : fii < 0 ? t.bear : t.textDim
  const diiColor = dii > 0 ? t.bull : dii < 0 ? t.bear : t.textDim
  const fmtCr = v => v === 0 ? '—' : `${v > 0 ? '+' : ''}₹${Math.abs(v).toLocaleString('en-IN')} Cr`

  const liqRaw = s.coinglass?.total_liquidations_24h ?? 0
  const liqFmt = liqRaw > 1e9 ? `$${(liqRaw / 1e9).toFixed(2)}B`
               : liqRaw > 1e6 ? `$${(liqRaw / 1e6).toFixed(0)}M`
               : liqRaw > 0 ? `$${liqRaw}` : '—'

  const cgLsRatio = s.coinglass?.btc_long_short ?? null

  return (
    <div style={{
      background: t.bgPanel,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      backdropFilter: isModern ? t.panelGlass : 'none',
      height: '100%',
    }}>
      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', height: 22, flexShrink: 0,
        background: t.headerGrad, borderBottom: `1px solid ${t.border}`,
      }}>
        <span style={{
          padding: '0 10px', color: t.accent, fontSize: 10, fontWeight: 500,
          letterSpacing: 0.4, borderRight: `1px solid ${t.border}`,
          height: '100%', display: 'flex', alignItems: 'center',
          fontFamily: t.font, textShadow: isModern ? t.glowAccent : 'none',
        }}>
          MARKET PULSE
        </span>
        <span style={{ padding: '0 8px', fontSize: 8, color: t.textDim, fontFamily: t.font }}>
          F&G · BTC DOM · INDIA VIX · NEWS
        </span>
        <div style={{ marginLeft: 'auto', padding: '0 10px' }}>
          <span style={{ fontSize: 8, color: t.bull, fontFamily: t.font,
                         textShadow: isModern ? t.glowBull : 'none' }}>
            ● LIVE
          </span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

        {/* ── Section 1: Fear & Greed + Global stats side by side ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', flexShrink: 0 }}>

          {/* Left: F&G gauge */}
          <div style={{
            padding: '8px 4px 4px', display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 4,
            borderRight: `1px solid ${t.border}`,
          }}>
            <FearGreedGauge value={fgVal} t={t} />
            <FGSparkline history={fgHistory} t={t} />
            <div style={{ fontSize: 7, color: t.textMuted, fontFamily: t.font }}>7-DAY HISTORY</div>
          </div>

          {/* Right: Global market + crypto metrics */}
          <div style={{ padding: '4px 0' }}>
            <div style={{ padding: '2px 8px 4px', fontSize: 8, color: t.textDim,
                          fontFamily: t.font, letterSpacing: 0.5 }}>GLOBAL</div>
            <DomBar label="BTC DOM" pct={btcDom} color={t.amber} t={t} />
            <DomBar label="ALTS DOM" pct={altsDom} color={t.purple} t={t} />
            <MetRow label="MARKET CAP" value={mcapFmt} t={t} color={t.text} />
            <MetRow label="24H VOLUME" value={volFmt} t={t} color={t.textDim} />
            <div style={{ borderTop: `1px solid ${t.border}20`, marginTop: 2, paddingTop: 2 }}>
              <div style={{ padding: '2px 8px 1px', fontSize: 8, color: t.textDim,
                            fontFamily: t.font, letterSpacing: 0.5 }}>FUNDING /8H</div>
              <MetRow label="BTC PERP" value={<FundingVal rate={s.btc_funding_8h} t={t} />} t={t} />
              <MetRow label="ETH PERP" value={<FundingVal rate={s.eth_funding_8h} t={t} />} t={t} />
              <MetRow label="SOL PERP" value={<FundingVal rate={s.sol_funding_8h} t={t} />} t={t} />
            </div>
          </div>
        </div>

        {/* ── Section 2: India Market Mood ── */}
        <SectionHdr label="INDIA MARKET MOOD" t={t} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '2px 0' }}>
          <MetRow label="INDIA VIX" t={t}
            value={vix > 0 ? `${vix?.toFixed(1)} ${vixLabel}` : '—'}
            color={vixColor} />
          <MetRow label="SENTIMENT"
            value={(s.india_overall || 'neutral').toUpperCase()}
            color={s.india_overall === 'bullish' ? t.bull : s.india_overall === 'bearish' ? t.bear : t.textDim}
            t={t} />
          <MetRow label="FII TODAY" value={fmtCr(fii)} color={fiiColor} t={t} />
          <MetRow label="DII TODAY"  value={fmtCr(dii)} color={diiColor} t={t} />
        </div>

        {/* ── Section 3: Coinglass / Derivatives ── */}
        <SectionHdr label="DERIVATIVES  (COINGLASS)" t={t} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '2px 0' }}>
          <MetRow label="24H LIQUIDATIONS" value={liqFmt} color={liqRaw > 5e8 ? t.bear : t.text} t={t} />
          {cgLsRatio !== null && (
            <MetRow label="BTC L/S RATIO"
              value={`${cgLsRatio?.toFixed(1)}% L`}
              color={cgLsRatio > 50 ? t.bull : t.bear}
              t={t} />
          )}
          {cgLsRatio === null && (
            <MetRow label="BTC OI (24H)" value={s.coinglass?.btc_oi ? `$${(s.coinglass.btc_oi / 1e9).toFixed(1)}B` : '—'} t={t} />
          )}
        </div>

        {/* ── Section 4: Live Headlines ── */}
        <SectionHdr label={`LIVE HEADLINES (${headlines.length})`} t={t} />
        <div style={{ flex: 1 }}>
          {headlines.length === 0 && (
            <div style={{ padding: '12px 8px', fontSize: 9, color: t.textMuted, fontFamily: t.font, textAlign: 'center' }}>
              Waiting for news feed…
            </div>
          )}
          {headlines.map((item, i) => <NewsLine key={i} item={item} t={t} />)}
        </div>

      </div>
    </div>
  )
}
