// src/components/home/MarketPulse.jsx
// Persistent breadth strip pinned above all HomeDashboard tabs.
// Displays: market mood · advance/decline ratio · India VIX · FII/DII flows
//           · top gaining/losing sectors · crypto Fear & Greed · BTC dominance
//
// Data comes from the /market/sentiment response already fetched by HomeDashboard.
// No extra query needed — sentiment prop is passed down.

import { useTheme } from '../../store'

const DEV_MOCK = {
  india_vix:           14.2,
  fii_flow_today_cr:  -892,
  dii_flow_today_cr:  1243,
  institutional_bias: 'neutral',
  india_breadth:      { bullish: 28, bearish: 19, neutral: 3, mood: 'bullish' },
  sector_performance: {
    IT:      { change_pct:  1.2 },
    BANK:    { change_pct: -0.8 },
    AUTO:    { change_pct:  0.5 },
    PHARMA:  { change_pct: -0.3 },
    METAL:   { change_pct:  2.1 },
    ENERGY:  { change_pct: -1.4 },
  },
  fear_greed:         62,
  fear_greed_signal:  'greed',
  btc_dominance_pct:  54.2,
}

function Divider({ t }) {
  return (
    <div style={{
      width: 1, height: 16,
      background: t.border,
      flexShrink: 0, margin: '0 2px',
    }} />
  )
}

function Pill({ label, color, t }) {
  return (
    <span style={{
      fontSize: 7, fontWeight: 700, letterSpacing: 0.5,
      fontFamily: t.fontUI, padding: '1px 5px', borderRadius: 3,
      background: `${color}18`, color, border: `1px solid ${color}30`,
      flexShrink: 0,
    }}>{label}</span>
  )
}

function Tag({ children, t }) {
  return (
    <span style={{
      fontSize: 8, color: t.textDim,
      fontFamily: t.fontUI, letterSpacing: 0.4, flexShrink: 0,
    }}>{children}</span>
  )
}

function formatCr(v) {
  const abs = Math.abs(v)
  const str = abs >= 1000 ? `${(abs / 1000).toFixed(1)}K` : String(Math.round(abs))
  return `${v >= 0 ? '+' : '−'}₹${str}Cr`
}

export default function MarketPulse({ sentiment }) {
  const t = useTheme()
  const s = sentiment || (import.meta.env.DEV ? DEV_MOCK : null)
  if (!s) return null

  // ── Breadth ──────────────────────────────────────────────────
  const breadth  = s.india_breadth || {}
  const total    = (breadth.bullish || 0) + (breadth.bearish || 0) + (breadth.neutral || 0)
  const bullPct  = total > 0 ? (breadth.bullish / total) * 100 : 50
  const mood     = (breadth.mood || 'mixed').toLowerCase()
  const moodColor = mood === 'bullish' ? t.bull : mood === 'bearish' ? t.bear : t.amber
  const moodLabel = mood.toUpperCase()

  // ── VIX ──────────────────────────────────────────────────────
  const vix      = s.india_vix || 0
  const vixColor = vix >= 20 ? t.bear : vix >= 15 ? t.amber : t.bull
  const vixLabel = vix >= 20 ? 'HIGH' : vix >= 15 ? 'ELEV' : 'LOW'

  // ── Flows ─────────────────────────────────────────────────────
  const fii = s.fii_flow_today_cr || 0
  const dii = s.dii_flow_today_cr || 0

  // ── Sectors — top 2 gainers + top 2 losers ───────────────────
  const sectors = Object.entries(s.sector_performance || {})
    .map(([name, v]) => ({
      name,
      chg: typeof v === 'object' ? (v.change_pct ?? v.pct ?? 0) : Number(v || 0),
    }))
    .filter(x => x.chg !== 0)
    .sort((a, b) => b.chg - a.chg)
  const gainers = sectors.slice(0, 2)
  const losers  = sectors.slice(-2).reverse()

  // ── Fear & Greed ──────────────────────────────────────────────
  const fg      = Number(s.fear_greed || 0)
  const fgColor = fg >= 60 ? t.bull : fg <= 40 ? t.bear : t.amber
  const fgLabel = fg >= 75 ? 'EXT.GREED' : fg >= 60 ? 'GREED' : fg <= 25 ? 'EXT.FEAR' : fg <= 40 ? 'FEAR' : 'NEUTRAL'

  const btcDom = Number(s.btc_dominance_pct || 0)

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '0 14px', height: 34, flexShrink: 0,
      borderBottom: `1px solid ${t.border}`,
      background: t.headerGrad,
      overflowX: 'auto', overflowY: 'hidden',
      // Hide scrollbar but allow scroll on overflow
      scrollbarWidth: 'none',
    }}>

      {/* Market mood pill */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '2px 8px', borderRadius: 12, flexShrink: 0,
        background: `${moodColor}12`, border: `1px solid ${moodColor}30`,
      }}>
        <div style={{
          width: 5, height: 5, borderRadius: '50%',
          background: moodColor,
          boxShadow: `0 0 4px ${moodColor}80`,
        }} />
        <span style={{
          fontSize: 9, fontWeight: 700, color: moodColor,
          fontFamily: t.fontUI, letterSpacing: 0.5,
        }}>{moodLabel}</span>
      </div>

      <Divider t={t} />

      {/* Advance / Decline breadth */}
      <Tag t={t}>A/D</Tag>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: t.bull, fontFamily: t.fontUI }}>
          {breadth.bullish || 0}▲
        </span>
        {/* Progress bar */}
        <div style={{
          width: 48, height: 5, borderRadius: 3, overflow: 'hidden',
          background: `${t.bear}30`, flexShrink: 0,
        }}>
          <div style={{
            width: `${bullPct}%`, height: '100%',
            background: t.bull, borderRadius: 3,
            transition: 'width 0.4s ease',
          }} />
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: t.bear, fontFamily: t.fontUI }}>
          {breadth.bearish || 0}▼
        </span>
        {(breadth.neutral || 0) > 0 && (
          <span style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI }}>
            {breadth.neutral}—
          </span>
        )}
      </div>

      <Divider t={t} />

      {/* India VIX */}
      <Tag t={t}>VIX</Tag>
      <span style={{
        fontSize: 11, fontWeight: 700, color: vixColor,
        fontFamily: t.fontUI, flexShrink: 0,
      }}>
        {vix > 0 ? vix.toFixed(1) : '—'}
      </span>
      <Pill label={vixLabel} color={vixColor} t={t} />

      <Divider t={t} />

      {/* FII / DII flows */}
      <Tag t={t}>FII</Tag>
      <span style={{
        fontSize: 10, fontWeight: 600, fontFamily: t.fontUI, flexShrink: 0,
        color: fii >= 0 ? t.bull : t.bear,
      }}>{formatCr(fii)}</span>

      <Tag t={t}>DII</Tag>
      <span style={{
        fontSize: 10, fontWeight: 600, fontFamily: t.fontUI, flexShrink: 0,
        color: dii >= 0 ? t.bull : t.bear,
      }}>{formatCr(dii)}</span>

      {/* Sectors */}
      {(gainers.length > 0 || losers.length > 0) && (
        <>
          <Divider t={t} />
          <Tag t={t}>SECTORS</Tag>
          {gainers.map(sec => (
            <span key={sec.name} style={{
              fontSize: 9, fontFamily: t.fontUI, color: t.bull, flexShrink: 0,
              background: `${t.bull}10`, padding: '2px 6px', borderRadius: 3,
              border: `1px solid ${t.bull}20`,
            }}>
              {sec.name}&nbsp;
              <span style={{ fontWeight: 700 }}>+{sec.chg.toFixed(1)}%</span>
            </span>
          ))}
          {losers.map(sec => (
            <span key={sec.name} style={{
              fontSize: 9, fontFamily: t.fontUI, color: t.bear, flexShrink: 0,
              background: `${t.bear}10`, padding: '2px 6px', borderRadius: 3,
              border: `1px solid ${t.bear}20`,
            }}>
              {sec.name}&nbsp;
              <span style={{ fontWeight: 700 }}>{sec.chg.toFixed(1)}%</span>
            </span>
          ))}
        </>
      )}

      <Divider t={t} />

      {/* Crypto Fear & Greed */}
      <Tag t={t}>F&amp;G</Tag>
      <span style={{
        fontSize: 11, fontWeight: 700, color: fgColor,
        fontFamily: t.fontUI, flexShrink: 0,
      }}>{fg || '—'}</span>
      <Pill label={fgLabel} color={fgColor} t={t} />

      {/* BTC Dominance */}
      {btcDom > 0 && (
        <>
          <Tag t={t}>BTC.D</Tag>
          <span style={{
            fontSize: 10, fontWeight: 600, color: t.cyan,
            fontFamily: t.fontUI, flexShrink: 0,
          }}>{btcDom.toFixed(1)}%</span>
        </>
      )}
    </div>
  )
}
