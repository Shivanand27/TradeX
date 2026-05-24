// src/components/signals/SignalDetail.jsx
import { useTerminalStore, useDataStore } from '../../store'
import { useTheme } from '../../store'

// ── Sub-components ────────────────────────────────────────────────

function ScoreBar({ value, t }) {
  const filled  = Math.round((value / 10) * 10)
  const isModern = t.name === 'modern'
  const barColor = value >= 7 ? t.bull : value >= 5 ? t.amber : t.bear
  return (
    <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} style={{
          flex: 1, height: 4, borderRadius: 1,
          background: i < filled ? barColor : t.bgActive,
          boxShadow: i < filled && isModern ? `0 0 4px ${barColor}` : 'none',
          transition: 'all 0.2s ease',
        }} />
      ))}
    </div>
  )
}

function SmcBadge({ label, color, t }) {
  const isModern = t.name === 'modern'
  return (
    <span style={{
      fontSize: 7, padding: '2px 5px', borderRadius: 2,
      border: `1px solid ${color}50`,
      color,
      background: isModern ? `${color}18` : `${color}10`,
      fontFamily: t.font, letterSpacing: 0.5, fontWeight: 600,
      textShadow: isModern ? `0 0 6px ${color}` : 'none',
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function LogicRow({ label, value, color, t }) {
  if (!value) return null
  return (
    <tr>
      <td style={{
        padding: '3px 0 3px 0', fontSize: 8, color: t.textDim,
        width: 80, whiteSpace: 'nowrap', verticalAlign: 'top',
        fontFamily: t.font, borderBottom: `1px solid ${t.border}20`,
      }}>{label}</td>
      <td style={{
        padding: '3px 0 3px 8px', fontSize: 9, color: color || t.text,
        fontFamily: t.font, lineHeight: 1.4,
        borderBottom: `1px solid ${t.border}20`,
      }}>{value}</td>
    </tr>
  )
}

function LevelBox({ label, value, color, t }) {
  const isModern = t.name === 'modern'
  return (
    <div style={{
      background: t.bgRow, padding: '4px 6px', borderRadius: 2,
      border: `1px solid ${color}30`,
    }}>
      <div style={{ fontSize: 7, color: t.textDim, fontFamily: t.font, marginBottom: 1 }}>{label}</div>
      <div style={{
        fontSize: 9, fontWeight: 600, color, fontFamily: t.font,
        textShadow: isModern ? `0 0 6px ${color}` : 'none',
      }}>{value}</div>
    </div>
  )
}

function StructurePill({ structure, t }) {
  const isModern = t.name === 'modern'
  const isBull  = structure?.includes('bull') || structure === 'choch_bullish'
  const isBear  = structure?.includes('bear') || structure === 'choch_bearish'
  const color   = isBull ? t.bull : isBear ? t.bear : t.amber
  const label   = structure?.replace(/_/g, ' ').toUpperCase() || 'RANGING'
  return (
    <span style={{
      fontSize: 8, padding: '2px 7px', borderRadius: 3,
      border: `1px solid ${color}60`,
      color,
      background: isModern ? `${color}20` : `${color}12`,
      fontFamily: t.font, letterSpacing: 0.6, fontWeight: 700,
      textShadow: isModern ? `0 0 8px ${color}` : 'none',
    }}>
      ▲ {label}
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────

export default function SignalDetail() {
  const signals        = useDataStore((s) => s.signals)
  const activeSignal   = useTerminalStore((s) => s.activeSignal)
  const setActiveSignal = useTerminalStore((s) => s.setActiveSignal)
  const t       = useTheme()
  const isModern = t.name === 'modern'

  const sig    = activeSignal || MOCK_SIGNAL
  const setup  = sig['TRADE SETUP'] || {}
  const exits  = setup['EXIT RULES — MANDATORY'] || {}
  const risk   = sig['RISK MANAGEMENT'] || {}
  const scores = sig['SCORE CARD'] || {}
  const smc    = sig.smc_analysis || {}

  // Prev / Next navigation through signals list
  const currentIdx = signals.findIndex((s) => s.symbol === sig.symbol)
  const hasPrev = currentIdx > 0
  const hasNext = currentIdx >= 0 && currentIdx < signals.length - 1
  const goPrev  = () => hasPrev && setActiveSignal(signals[currentIdx - 1])
  const goNext  = () => hasNext && setActiveSignal(signals[currentIdx + 1])

  const verdictColor = sig.verdict === 'GO'
    ? t.bull : sig.verdict === 'WATCH' ? t.amber : t.bear

  const metricCards = [
    {
      l: 'ENTRY ZONE',
      v: Array.isArray(setup.entry_zone)
        ? `${setup.entry_zone[0]} – ${setup.entry_zone[1]}`
        : (sig.entry_zone || '—'),
      c: t.amber,
    },
    { l: `TARGET 1  ${exits.target_1_pct || ''}`, v: exits.target_1 || '—', c: t.bull },
    { l: `TARGET 2  ${exits.target_2_pct || ''}`, v: exits.target_2 || '—', c: t.bull },
    { l: `STOP  ${exits.stop_loss_pct || ''}`,    v: exits.stop_loss || '—', c: t.bear },
  ]

  return (
    <div style={{
      background: t.bgPanel,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      backdropFilter: isModern ? t.panelGlass : 'none',
    }}>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        background: t.headerGrad, borderBottom: `1px solid ${t.border}`,
        height: 22, flexShrink: 0,
      }}>
        <span style={{
          padding: '0 10px', color: t.accent, fontSize: 10, fontWeight: 500,
          letterSpacing: .4, borderRight: `1px solid ${t.border}`,
          height: '100%', display: 'flex', alignItems: 'center',
          fontFamily: t.font, textShadow: isModern ? t.glowAccent : 'none',
        }}>
          SIGNAL DETAIL
        </span>
        <span style={{ padding: '0 8px', color: t.textDim, fontSize: 9, fontFamily: t.font }}>
          {sig.symbol} · {sig.verdict}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex' }}>
          {[['← PREV', goPrev, hasPrev], ['NEXT →', goNext, hasNext]].map(([label, fn, enabled]) => (
            <button key={label} onClick={fn} style={{
              padding: '0 8px', height: 22, background: 'none', border: 'none',
              borderLeft: `1px solid ${t.border}`,
              color: enabled ? t.textDim : t.border,
              fontSize: 9, cursor: enabled ? 'pointer' : 'default', fontFamily: t.font,
            }}>{label}</button>
          ))}
        </div>
      </div>

      {/* ── Symbol header ───────────────────────────────────────── */}
      <div style={{ padding: '8px 10px', borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{
              fontSize: 18, fontWeight: 600, color: t.accent,
              letterSpacing: '-.5px', fontFamily: t.font,
              textShadow: isModern ? t.glowAccent : 'none',
            }}>
              {sig.symbol}
            </div>
            <div style={{ fontSize: 10, color: t.textMuted, marginTop: 2, fontFamily: t.font }}>
              {sig.company_name} · {sig.strategy?.slice(0, 60)}
            </div>
          </div>
          <div style={{
            background: isModern ? `${verdictColor}20` : `${verdictColor}12`,
            border: `1px solid ${verdictColor}50`,
            color: verdictColor, padding: '3px 10px',
            borderRadius: t.radiusLg, fontSize: 10, fontWeight: 600, letterSpacing: .5,
            fontFamily: t.font,
            boxShadow: isModern ? `0 0 12px ${verdictColor}40` : 'none',
          }}>
            ● {sig.verdict}  {sig.conviction}
          </div>
        </div>
        {sig.narrative && (
          <div style={{
            marginTop: 6, fontSize: 9, color: t.textMuted, lineHeight: 1.5,
            fontFamily: t.font, fontStyle: 'italic',
          }}>
            {sig.narrative}
          </div>
        )}
      </div>

      {/* ── 4 metric cards ──────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 1, background: t.bgGrid, flexShrink: 0 }}>
        {metricCards.map((m) => (
          <div key={m.l} style={{ background: t.bgRow, padding: '6px 8px' }}>
            <div style={{ fontSize: 8, color: t.textDim, letterSpacing: .4, textTransform: 'uppercase', marginBottom: 2, fontFamily: t.font }}>
              {m.l}
            </div>
            <div style={{
              fontSize: 11, fontWeight: 500, color: m.c, fontFamily: t.font,
              textShadow: isModern ? `0 0 8px ${m.c}` : 'none',
            }}>
              {String(m.v)}
            </div>
          </div>
        ))}
      </div>

      {/* ── Scrollable body ─────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* Score bars */}
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${t.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 9, color: t.textDim, letterSpacing: .4, fontFamily: t.font }}>OVERALL SCORE</span>
            <span style={{
              fontSize: 11, fontWeight: 600, color: t.bull, fontFamily: t.font,
              textShadow: isModern ? t.glowBull : 'none',
            }}>
              {scores.overall ?? '—'} / 10
            </span>
          </div>
          <ScoreBar value={scores.overall ?? 0} t={t} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 1, marginTop: 6, background: t.bgGrid }}>
            {[
              ['TECH',   scores.technical   ?? 0, t.bull],
              ['SENTI',  scores.sentiment   ?? 0, t.amber],
              ['FUND',   scores.fundamental ?? 0, t.bull],
              ['SMC',    scores.smc         ?? 0, t.cyan],
              [`BULL ${scores.bull_conviction ?? '?'}/10`, null, t.bull],
              [`BEAR ${scores.bear_risk      ?? '?'}/10`, null, t.bear],
            ].map(([label, val, color], i) => (
              <div key={i} style={{ background: t.bgRow, padding: '4px 4px', textAlign: 'center' }}>
                <div style={{ fontSize: 7, color: t.textDim, fontFamily: t.font, marginBottom: 1 }}>{label}</div>
                {val !== null && (
                  <div style={{
                    fontSize: 10, fontWeight: 600, color, fontFamily: t.font,
                    textShadow: isModern ? `0 0 6px ${color}` : 'none',
                  }}>
                    {typeof val === 'number' ? val.toFixed(1) : val}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── BUY / SELL LOGIC (SMC section) ─────────────────────── */}
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${t.border}` }}>
          <div style={{
            fontSize: 9, color: t.accent, letterSpacing: .5, marginBottom: 6,
            textTransform: 'uppercase', fontFamily: t.font, fontWeight: 600,
            textShadow: isModern ? t.glowAccent : 'none',
          }}>
            BUY / SELL LOGIC
          </div>

          {/* Structure + confluence badges */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
            <StructurePill structure={smc.structure || sig.smc_structure} t={t} />
            {smc.in_discount && <SmcBadge label="DISCOUNT ZONE" color={t.cyan} t={t} />}
            {smc.in_premium  && <SmcBadge label="PREMIUM ZONE"  color={t.bear} t={t} />}
            {smc.liquidity_swept === 'sell_side' && <SmcBadge label="SSL SWEPT ✓" color={t.amber} t={t} />}
            {smc.liquidity_swept === 'buy_side'  && <SmcBadge label="BSL SWEPT ⚠" color={t.bear}  t={t} />}
            {smc.ob_zone  && <SmcBadge label={`OB  ${smc.ob_zone[0]}–${smc.ob_zone[1]}`} color={t.bull} t={t} />}
            {smc.fvg_zone && <SmcBadge label={`FVG  ${smc.fvg_zone[0]}–${smc.fvg_zone[1]}`} color={t.cyan} t={t} />}
          </div>

          {/* Reasoning table */}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <LogicRow label="ENTRY REASON" value={smc.entry_reason} color={t.bull}  t={t} />
              <LogicRow label="STOP LOGIC"   value={smc.stop_reason}  color={t.bear}  t={t} />
              <LogicRow label="TARGET 1"     value={smc.target_1_reason}              t={t} />
              <LogicRow label="TARGET 2"     value={smc.target_2_reason}              t={t} />
            </tbody>
          </table>

          {/* Key SMC levels */}
          {(smc.ob_zone || smc.ssl != null || smc.bsl != null || smc.swing_high || smc.swing_low) && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
              gap: 4, marginTop: 8,
            }}>
              {smc.ob_zone  && <LevelBox label="BULL OB ZONE"  value={`${smc.ob_zone[0]} – ${smc.ob_zone[1]}`} color={t.bull}  t={t} />}
              {smc.fvg_zone && <LevelBox label="FVG IMBAL."    value={`${smc.fvg_zone[0]} – ${smc.fvg_zone[1]}`} color={t.cyan} t={t} />}
              {smc.ssl != null && <LevelBox label="SSL (BELOW)" value={String(smc.ssl)} color={t.amber} t={t} />}
              {smc.bsl != null && <LevelBox label="BSL (ABOVE)" value={String(smc.bsl)} color={t.bear}  t={t} />}
              {smc.swing_low  && <LevelBox label="SWING LOW"    value={String(smc.swing_low)}  color={t.textDim} t={t} />}
              {smc.swing_high && <LevelBox label="SWING HIGH"   value={String(smc.swing_high)} color={t.textDim} t={t} />}
            </div>
          )}
        </div>

        {/* ── Trade rules table ───────────────────────────────────── */}
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {[
              ['TRAILING STOP', exits.trailing_stop,                               null],
              ['TIME EXIT',     exits.time_exit,                                   t.amber],
              ['INVALIDATION',  exits.invalidation,                                t.bear],
              ['POSITION SIZE', `${risk.position_size_pct ?? '—'}% capital · Max loss ${risk.max_loss_if_stop_hit_pct ?? '—'}%`, null],
              ['HEDGE',         risk.hedge_recommendation,                         null],
              ['STOP HUNT',     risk.stop_hunt_warning,                            t.amber],
            ].filter(([, v]) => v).map(([k, v, c]) => (
              <tr key={k}>
                <td style={{
                  padding: '4px 10px', fontSize: 9, color: t.textDim, width: 110,
                  borderBottom: `1px solid ${t.border}`, whiteSpace: 'nowrap',
                  verticalAlign: 'top', fontFamily: t.font,
                }}>{k}</td>
                <td style={{
                  padding: '4px 10px', fontSize: 10, textAlign: 'right',
                  borderBottom: `1px solid ${t.border}`,
                  color: c || t.text, fontFamily: t.font, lineHeight: 1.4,
                }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ── Adversarial debate ──────────────────────────────────── */}
        <div style={{ padding: '8px 10px' }}>
          <div style={{
            fontSize: 9, color: t.textDim, letterSpacing: .4, marginBottom: 6,
            textTransform: 'uppercase', fontFamily: t.font,
          }}>
            Adversarial Debate
          </div>
          <div style={{
            fontSize: 9, color: t.bull, lineHeight: 1.5, marginBottom: 5, fontFamily: t.font,
            textShadow: isModern ? `0 0 6px ${t.bull}80` : 'none',
          }}>
            ▲ BULL: {sig.bull || (sig['TRADE SETUP'] && sig.strategy) || 'N/A'}
          </div>
          <div style={{
            fontSize: 9, color: t.bear, lineHeight: 1.5, fontFamily: t.font,
            textShadow: isModern ? `0 0 6px ${t.bear}80` : 'none',
          }}>
            ▼ BEAR: {sig.bear || sig.debate_summary?.split('| Bear:')?.[1]?.trim() || 'N/A'}
          </div>
          {sig.veto_reasons?.length > 0 && (
            <div style={{
              marginTop: 6, fontSize: 9, color: t.bear, fontFamily: t.font,
              background: `${t.bear}10`, padding: '4px 8px', borderRadius: 2,
              border: `1px solid ${t.bear}30`,
            }}>
              ⛔ VETO: {sig.veto_reasons.join(' · ')}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}

// ── Mock signal (dev / no selection) ─────────────────────────────

const MOCK_SIGNAL = {
  symbol:       'RELIANCE',
  company_name: 'Reliance Industries Ltd',
  market:       'india_stock',
  verdict:      'GO',
  conviction:   'HIGH',
  strategy:     'POSITIONAL LONG · Bullish OB + CHoCH',
  smc_structure: 'choch_bullish',
  narrative:    'Reliance broke the prior swing high on 3.2× volume after sweeping sell-side liquidity at ₹2,965, confirming a CHoCH with price sitting in a demand OB. Key risk: O2C margin pressure could disappoint in Q4 — respect the stop at ₹2,975.',
  bull:         'CHoCH confirmed at ₹3,015. SSL swept at ₹2,965, smart money absorbed supply. Now inside bullish OB ₹2,980–₹3,005 with FII ₹3,420 Cr net buy over 5 days.',
  bear:         'Bearish OB at ₹3,520–₹3,550 will cap T1 move. O2C margins may disappoint in Q4. Ensure stop at ₹2,975 is respected on any correction.',
  'TRADE SETUP': {
    entry_price: 3000,
    entry_zone:  [2980, 3005],
    'EXIT RULES — MANDATORY': {
      target_1:        3540,  target_1_pct:  '+18%',  target_1_action: 'exit 50%',
      target_2:        4280,  target_2_pct:  '+43%',  target_2_action: 'exit 50%',
      stop_loss:       2975,  stop_loss_pct: '-0.8%',
      trailing_stop:   'Trail 8% below highest weekly close after T1',
      time_exit:       'Exit by 30-Sep-2026 if neither TP hit',
      invalidation:    'Exit if daily close below ₹2,975',
      max_hold_days:   160,
    },
  },
  'RISK MANAGEMENT': {
    position_size_pct:        8,
    max_loss_if_stop_hit_pct: '0.06',
    hedge_recommendation:     'Buy RELIANCE 2900 PE for positions > ₹1L',
    stop_hunt_warning:        'Price may wick to ₹2,960 before reversing — consider limit entry inside OB',
  },
  'SCORE CARD': {
    technical: 8.6, sentiment: 7.1, fundamental: 7.8,
    smc: 8.5, overall: 8.4, bull_conviction: 8, bear_risk: 4,
  },
  smc_analysis: {
    structure:        'choch_bullish',
    trend:            'uptrend',
    in_discount:      true,
    in_premium:       false,
    liquidity_swept:  'sell_side',
    entry_confluence: ['CHOCH BULLISH', 'BULLISH OB  ₹2,980–₹3,005', 'DISCOUNT ZONE', 'SSL SWEPT ✓'],
    entry_reason:     'Buy at Bullish OB ₹2,980–₹3,005 — SSL swept at ₹2,965, smart money reversal confirmed, discount zone (below 50% fib)',
    stop_reason:      'Below OB low ₹2,975 — bullish CHoCH structure invalidated on close below',
    target_1_reason:  'Bearish OB supply ₹3,520–₹3,550 — expect institutional selling pressure',
    target_2_reason:  'Buy-side liquidity pool at ₹4,280 — equal highs cluster above',
    ob_zone:   [2980, 3005],
    fvg_zone:  [2998, 3010],
    ssl:       2965,
    bsl:       4280,
    swing_low:  2920,
    swing_high: 3150,
  },
}
