// src/components/signals/SignalPopup.jsx
// Full-detail popup modal for a trade signal.
// Shows: source (Agent/Indicator), logic, debate summary, sentiment scores,
// entry/exit rules, and risk metrics.

import { useEffect } from 'react'
import { useTerminalStore, useTheme } from '../../store'
import { fmtIST } from '../../lib/api'

function ScoreBar({ label, value, max = 10, color, t }) {
  const pct = Math.min((value / max) * 100, 100)
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
        <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>{label}</span>
        <span style={{ fontSize: 9, fontWeight: 700, color, fontFamily: t.font }}>{value}/{max}</span>
      </div>
      <div style={{ height: 4, background: `${color}20`, borderRadius: 2 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
      </div>
    </div>
  )
}

function InfoRow({ label, value, color, t }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${t.border}18` }}>
      <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>{label}</span>
      <span style={{ fontSize: 9, fontWeight: 600, color: color || t.text, fontFamily: t.font }}>{value ?? '—'}</span>
    </div>
  )
}

function SectionTitle({ label, color, t, isModern }) {
  const c = color || t.accent
  return (
    <div style={{
      fontSize: 9, fontWeight: 700, color: c, fontFamily: t.font,
      letterSpacing: 0.6, padding: '8px 0 4px',
      borderBottom: `1px solid ${c}30`, marginBottom: 8,
      textShadow: isModern ? `0 0 8px ${c}60` : 'none',
    }}>{label}</div>
  )
}

export default function SignalPopup() {
  const t         = useTheme()
  const isModern  = t.name === 'modern'
  const isOpen    = useTerminalStore(s => s.signalPopupOpen)
  const signal    = useTerminalStore(s => s.activeSignal)
  const onClose   = useTerminalStore(s => s.closeSignalPopup)
  const openTicket = useTerminalStore(s => s.openOrderTicket)

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen || !signal) return null

  // Normalise signal fields (pipeline format vs watchlist row format)
  const setup     = signal['TRADE SETUP'] || {}
  const exits     = setup['EXIT RULES — MANDATORY'] || {}
  const risk      = signal['RISK MANAGEMENT'] || {}
  const scores    = signal['SCORE CARD'] || {}
  const smc       = signal.smc_analysis || {}

  const isAgent     = !signal.source?.includes('tradingview') && !signal.source?.includes('rf_dw') && !signal.indicator?.includes('RF')
  const isRfDw      = signal.source?.includes('rf_dw') || signal.indicator?.includes('RF') || signal.source?.includes('tradingview')
  const sourceLabel = isRfDw ? 'RF [DW] INDICATOR' : 'AI AGENT PIPELINE'
  const sourceColor = isRfDw ? t.cyan : t.accent

  const verdict    = signal.verdict || signal.signal || '—'
  const conviction = signal.conviction || '—'
  const market     = signal.market || 'crypto'
  const symbol     = signal.symbol || '—'
  const isCrypto   = market === 'crypto'
  const currency   = isCrypto ? '$' : '₹'

  const verdictColor = verdict === 'GO' ? t.bull : verdict === 'WATCH' ? t.amber : verdict === 'BUY' ? t.bull : t.bear
  const convictionColor = conviction === 'HIGH' ? t.bull : conviction === 'MEDIUM' ? t.amber : t.textMuted

  const entryZone   = setup.entry_zone || []
  const entryLow    = entryZone[0] || setup.entry_price || signal.entry_price
  const entryHigh   = entryZone[1]
  const entryStr    = entryLow
    ? (entryHigh ? `${currency}${Number(entryLow).toFixed(2)} – ${currency}${Number(entryHigh).toFixed(2)}` : `${currency}${Number(entryLow).toFixed(2)}`)
    : '—'

  const fmt = v => v != null ? `${currency}${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 900,
          background: 'rgba(0,0,0,0.72)',
          backdropFilter: isModern ? 'blur(4px)' : 'none',
        }}
      />

      {/* Modal */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%', zIndex: 901,
        transform: 'translate(-50%, -50%)',
        width: 720, maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 40px)',
        background: isModern ? 'rgba(4,10,24,0.97)' : t.bgPanel,
        border: `1px solid ${verdictColor}50`,
        borderRadius: t.radiusLg || 4,
        display: 'flex', flexDirection: 'column',
        boxShadow: isModern ? `0 0 60px ${verdictColor}20, 0 0 120px rgba(0,0,0,0.8)` : '0 8px 40px rgba(0,0,0,0.7)',
        overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 16px', borderBottom: `1px solid ${t.border}`,
          background: isModern
            ? `linear-gradient(135deg, ${verdictColor}12 0%, transparent 60%)`
            : t.headerGrad,
          flexShrink: 0,
        }}>
          {/* Source badge */}
          <div style={{
            padding: '2px 8px', borderRadius: 2, fontSize: 8, fontWeight: 700,
            fontFamily: t.font, letterSpacing: 0.5,
            background: `${sourceColor}18`, color: sourceColor,
            border: `1px solid ${sourceColor}40`,
          }}>{sourceLabel}</div>

          {/* Symbol */}
          <span style={{ fontSize: 16, fontWeight: 700, color: t.cyan, fontFamily: t.font }}>
            {symbol}
          </span>

          {/* Verdict + Conviction */}
          <span style={{
            fontSize: 12, fontWeight: 700, color: verdictColor, fontFamily: t.font,
            textShadow: isModern ? `0 0 12px ${verdictColor}` : 'none',
          }}>
            {verdict === 'GO' ? '● GO' : verdict === 'WATCH' ? '◐ WATCH' : verdict}
          </span>
          {conviction !== '—' && (
            <span style={{
              fontSize: 9, padding: '2px 8px', borderRadius: 2,
              background: `${convictionColor}18`, color: convictionColor,
              fontFamily: t.font, border: `1px solid ${convictionColor}40`,
            }}>{conviction} CONVICTION</span>
          )}

          {/* Market badge */}
          <span style={{
            fontSize: 8, padding: '1px 6px', borderRadius: 2,
            background: `${t.textDim}18`, color: t.textDim,
            fontFamily: t.font, marginLeft: 'auto',
            border: `1px solid ${t.border}`,
          }}>{(market || '').toUpperCase().replace('_', ' ')}</span>

          {/* Close */}
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: t.textDim, fontSize: 16,
            cursor: 'pointer', padding: '0 4px', fontFamily: t.font, lineHeight: 1,
          }}>✕</button>
        </div>

        {/* Body — scrollable */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

            {/* Left column */}
            <div>
              {/* Trade setup */}
              <SectionTitle label="TRADE SETUP" color={t.accent} t={t} isModern={isModern} />
              <InfoRow label="ENTRY ZONE" value={entryStr} color={t.bull} t={t} />
              <InfoRow label="TARGET 1" value={fmt(exits.target_1)} color={t.bull} t={t} />
              {exits.target_1_pct && <InfoRow label="  → TP1 %" value={exits.target_1_pct} color={t.bull} t={t} />}
              {exits.target_1_action && <InfoRow label="  → TP1 ACTION" value={exits.target_1_action} t={t} />}
              <InfoRow label="TARGET 2" value={fmt(exits.target_2)} color={t.bull} t={t} />
              {exits.target_2_pct && <InfoRow label="  → TP2 %" value={exits.target_2_pct} color={t.bull} t={t} />}
              <InfoRow label="STOP LOSS" value={fmt(exits.stop_loss)} color={t.bear} t={t} />
              {exits.stop_loss_pct && <InfoRow label="  → SL %" value={exits.stop_loss_pct} color={t.bear} t={t} />}
              <InfoRow label="TRAILING STOP" value={exits.trailing_stop} t={t} />
              <InfoRow label="TIME EXIT" value={exits.time_exit} t={t} />
              <InfoRow label="INVALIDATION" value={exits.invalidation} color={t.bear} t={t} />
              {setup.timeframe && <InfoRow label="HOLD PERIOD" value={setup.timeframe} t={t} />}

              {/* Risk management */}
              {(risk.position_size_pct || risk.max_loss_if_stop_hit_pct) && (
                <>
                  <SectionTitle label="RISK MANAGEMENT" color={t.amber} t={t} isModern={isModern} />
                  {risk.position_size_pct && <InfoRow label="POSITION SIZE" value={`${risk.position_size_pct}% of capital`} color={t.amber} t={t} />}
                  {risk.max_loss_if_stop_hit_pct && <InfoRow label="MAX LOSS" value={`${risk.max_loss_if_stop_hit_pct}%`} color={t.bear} t={t} />}
                  {risk.hedge_recommendation && <InfoRow label="HEDGE" value={risk.hedge_recommendation} t={t} />}
                </>
              )}

              {/* SMC analysis */}
              {(smc.structure || signal.smc_structure) && (
                <>
                  <SectionTitle label="SMC STRUCTURE" color={t.purple} t={t} isModern={isModern} />
                  <InfoRow label="STRUCTURE" value={(smc.structure || signal.smc_structure || '').toUpperCase().replace(/_/g, ' ')} color={t.purple} t={t} />
                  {smc.bias && <InfoRow label="BIAS" value={smc.bias?.toUpperCase()} t={t} />}
                  {smc.order_blocks?.length > 0 && (
                    <InfoRow label="ORDER BLOCKS" value={`${smc.order_blocks.length} found`} color={t.cyan} t={t} />
                  )}
                  {smc.fvg?.length > 0 && (
                    <InfoRow label="FAIR VALUE GAPS" value={`${smc.fvg.length} open`} color={t.cyan} t={t} />
                  )}
                </>
              )}
            </div>

            {/* Right column */}
            <div>
              {/* Narrative / Why */}
              {(signal.narrative || signal.strategy) && (
                <>
                  <SectionTitle label="WHY THIS TRADE" color={t.bull} t={t} isModern={isModern} />
                  <div style={{
                    fontSize: 9, color: t.text, fontFamily: t.fontSans,
                    lineHeight: 1.6, padding: '6px 0 10px',
                    borderBottom: `1px solid ${t.border}18`,
                  }}>
                    {signal.narrative || signal.strategy}
                  </div>
                </>
              )}

              {/* Debate summary */}
              {signal.debate_summary && (
                <>
                  <SectionTitle label="BEAR RISK / KEY DEBATE" color={t.bear} t={t} isModern={isModern} />
                  <div style={{
                    fontSize: 9, color: t.text, fontFamily: t.fontSans,
                    lineHeight: 1.6, padding: '6px 0 10px',
                    borderBottom: `1px solid ${t.border}18`,
                  }}>
                    {signal.debate_summary}
                  </div>
                </>
              )}

              {/* Score card */}
              {Object.keys(scores).length > 0 && (
                <>
                  <SectionTitle label="SCORE CARD" color={t.cyan} t={t} isModern={isModern} />
                  {scores.technical   != null && <ScoreBar label="TECHNICAL"   value={scores.technical}   color={t.accent} t={t} />}
                  {scores.sentiment   != null && <ScoreBar label="SENTIMENT"   value={scores.sentiment}   color={t.cyan}   t={t} />}
                  {scores.fundamental != null && <ScoreBar label="FUNDAMENTAL" value={scores.fundamental} color={t.amber}  t={t} />}
                  {scores.overall     != null && <ScoreBar label="OVERALL"     value={scores.overall}     color={t.bull}   t={t} />}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
                    {scores.bull_conviction != null && (
                      <div style={{
                        padding: '6px 10px', borderRadius: t.radius,
                        background: `${t.bull}10`, border: `1px solid ${t.bull}30`, textAlign: 'center',
                      }}>
                        <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>BULL CONVICTION</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: t.bull, fontFamily: t.font }}>{scores.bull_conviction}</div>
                      </div>
                    )}
                    {scores.bear_risk != null && (
                      <div style={{
                        padding: '6px 10px', borderRadius: t.radius,
                        background: `${t.bear}10`, border: `1px solid ${t.bear}30`, textAlign: 'center',
                      }}>
                        <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>BEAR RISK</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: t.bear, fontFamily: t.font }}>{scores.bear_risk}</div>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* RF [DW] specific data */}
              {isRfDw && (
                <>
                  <SectionTitle label="RF [DW] INDICATOR DATA" color={t.cyan} t={t} isModern={isModern} />
                  <InfoRow label="DIRECTION" value={signal.signal || signal.direction} color={signal.signal === 'BUY' ? t.bull : t.bear} t={t} />
                  {signal.close   && <InfoRow label="CLOSE PRICE"   value={`$${Number(signal.close).toFixed(4)}`}    color={t.text}    t={t} />}
                  {signal.rf      && <InfoRow label="RF VALUE"      value={`$${Number(signal.rf).toFixed(4)}`}       color={t.cyan}    t={t} />}
                  {signal.rf_distance_pct != null && (
                    <InfoRow label="RF DISTANCE" value={`${signal.rf_distance_pct >= 0 ? '+' : ''}${signal.rf_distance_pct.toFixed(3)}%`} color={t.purple} t={t} />
                  )}
                  <InfoRow label="TIMEFRAME" value={signal.timeframe || '5m'} t={t} />
                  <InfoRow label="BAR TIME"  value={signal.bar_time ? fmtIST(signal.bar_time, 'datetime') : '—'} t={t} />
                  <div style={{ padding: '8px 0 4px', fontSize: 8, color: t.textDim, fontFamily: t.font, lineHeight: 1.5 }}>
                    RF [DW] by David Winkler — ATR-based directional filter on 5-minute crypto charts.
                    BUY = price crossed above the RF band. SELL = price crossed below. Signals fire on direction flip only.
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Signal metadata footer */}
          <div style={{
            marginTop: 12, padding: '8px 0', borderTop: `1px solid ${t.border}`,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>
              Signal ID: {signal.signal_id || signal.id || '—'} · Generated: {fmtIST(signal.timestamp || signal.created_at, 'datetime')}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { onClose(); openTicket(symbol, 'BUY') }}
                style={{
                  background: `${t.bull}18`, border: `1px solid ${t.bull}50`, color: t.bull,
                  fontSize: 9, padding: '4px 16px', cursor: 'pointer', borderRadius: 2, fontFamily: t.font, fontWeight: 600,
                }}
              >LONG / BUY</button>
              <button
                onClick={() => { onClose(); openTicket(symbol, 'SELL') }}
                style={{
                  background: `${t.bear}18`, border: `1px solid ${t.bear}50`, color: t.bear,
                  fontSize: 9, padding: '4px 16px', cursor: 'pointer', borderRadius: 2, fontFamily: t.font, fontWeight: 600,
                }}
              >SHORT / SELL</button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
