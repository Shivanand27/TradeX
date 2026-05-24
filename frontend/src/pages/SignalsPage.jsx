// src/pages/SignalsPage.jsx
// Signals page:
//   • Left sidebar: TV-style watchlist
//   • Main: signal cards with filters (market, indicator dropdown, conviction, verdict)
//   • Indicator mini-panels: RF[DW] + Confirmation Signals [Simple] — shown per selection
//   • Click any signal → SignalPopup modal with full logic/sentiment
//
// Source labels: "AGENT" (AI pipeline) | "RF[DW]" | "CONF[S]" (Confirmation Simple)

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getRfDwSignals, getConfSimpleSignals, fmtIST } from '../lib/api'
import { useDataStore, useTerminalStore, useTheme } from '../store'

import TVWatchlist from '../components/home/TVWatchlist'
import ErrorBoundary from '../components/common/ErrorBoundary'
import SignalPerformance from '../components/signals/SignalPerformance'
import PriceChart from '../components/chart/PriceChart'

const DEV_CONF_SIGNALS = {
  BTCUSD: { signal: 'BUY',  strength: 'STRONG',   bull_score: 4, bear_score: 0, timestamp: new Date().toISOString(), confirmations: { rsi: { bull: true,  bear: false }, ema: { bull: true,  bear: false }, macd: { bull: true,  bear: false }, volume: { confirming: true  } } },
  ETHUSD: { signal: 'SELL', strength: 'MODERATE', bull_score: 1, bear_score: 3, timestamp: new Date().toISOString(), confirmations: { rsi: { bull: false, bear: true  }, ema: { bull: false, bear: true  }, macd: { bull: false, bear: true  }, volume: { confirming: false } } },
  SOLUSD: { signal: 'NEUTRAL', strength: 'WEAK',  bull_score: 1, bear_score: 2, timestamp: new Date().toISOString(), confirmations: { rsi: { bull: false, bear: false }, ema: { bull: true,  bear: false }, macd: { bull: false, bear: true  }, volume: { confirming: false } } },
}

// ── Active PnL panel ──────────────────────────────────────────────
function ActivePnLPanel({ positions, t }) {
  const totalUnrl = positions.reduce((s, p) => s + (p.unrealized_pnl ?? p.unrl_pnl ?? 0), 0)
  const totalReal = positions.reduce((s, p) => s + (p.realized_pnl  ?? p.day_pnl   ?? 0), 0)
  const totalColor = totalUnrl >= 0 ? t.bull : t.bear

  return (
    <div style={{ borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '6px 12px', borderBottom: `1px solid ${t.border}`,
        background: t.headerGrad,
      }}>
        <span style={{ fontSize: 9, color: t.accent, fontFamily: t.font, fontWeight: 600 }}>
          ACTIVE P&L — {positions.length} OPEN
        </span>
        <div style={{ display: 'flex', gap: 16, marginLeft: 'auto' }}>
          <span style={{ fontSize: 9, fontFamily: t.font, color: t.textDim }}>
            UNREALIZED: <span style={{ color: totalColor, fontWeight: 700 }}>
              {totalUnrl >= 0 ? '+' : ''}₹{Math.abs(totalUnrl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </span>
          </span>
          <span style={{ fontSize: 9, fontFamily: t.font, color: t.textDim }}>
            DAY P&L: <span style={{ color: totalReal >= 0 ? t.bull : t.bear, fontWeight: 700 }}>
              {totalReal >= 0 ? '+' : ''}₹{Math.abs(totalReal).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </span>
          </span>
        </div>
      </div>

      {positions.length === 0 ? (
        <div style={{ padding: '8px 12px', fontSize: 9, color: t.textMuted, fontFamily: t.font }}>
          No open positions
        </div>
      ) : (
        <div style={{ display: 'flex', overflowX: 'auto', padding: '6px 12px', gap: 12 }}>
          {positions.map((p, i) => {
            const pnl = p.unrealized_pnl ?? p.unrl_pnl ?? 0
            const pct = p.unrealized_pnl_pct ?? p.day_pnl_pct ?? 0
            const pnlColor = pnl >= 0 ? t.bull : t.bear
            return (
              <div key={i} style={{
                flexShrink: 0, padding: '6px 10px', borderRadius: t.radius,
                border: `1px solid ${pnlColor}30`, background: `${pnlColor}06`,
                minWidth: 140,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: t.cyan, fontFamily: t.font }}>{p.symbol}</span>
                  <span style={{ fontSize: 8, color: p.side === 'LONG' ? t.bull : t.bear, fontFamily: t.font }}>{p.side}</span>
                </div>
                <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.font, marginBottom: 4 }}>
                  {p.qty} @ {p.avg_price ?? p.avg ?? '—'}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: pnlColor, fontFamily: t.font }}>
                  {pnl >= 0 ? '+' : ''}₹{Math.abs(pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </div>
                <div style={{ fontSize: 8, color: pnlColor, fontFamily: t.font }}>
                  {pct >= 0 ? '+' : ''}{typeof pct === 'number' ? pct.toFixed(2) : pct}%
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── RF[DW] mini panel ─────────────────────────────────────────────
function RfDwMiniPanel({ rfSignals, t, onOpen }) {
  const entries = Object.entries(rfSignals || {})
  if (!entries.length) return null
  return (
    <div style={{
      border: `1px solid ${t.border}`, borderRadius: t.radius,
      overflow: 'hidden', marginBottom: 10, flex: 1, minWidth: 220,
    }}>
      <div style={{
        padding: '5px 10px', background: t.headerGrad,
        borderBottom: `1px solid ${t.border}`,
        fontSize: 9, color: t.cyan, fontFamily: t.fontUI, fontWeight: 700,
        letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{
          background: `${t.cyan}20`, border: `1px solid ${t.cyan}40`,
          padding: '1px 5px', borderRadius: 3, fontSize: 8,
        }}>RF[DW]</span>
        3m CRYPTO
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 0 }}>
        {entries.map(([sym, d]) => {
          const isBuy = d.signal === 'BUY'
          const color = isBuy ? t.bull : t.bear
          return (
            <div
              key={sym}
              onClick={() => onOpen({ ...d, symbol: sym, source: 'rf_dw', market: 'crypto', indicator: 'RF_DW' })}
              style={{
                padding: '6px 8px', cursor: 'pointer',
                borderRight: `1px solid ${t.border}20`,
                borderBottom: `1px solid ${t.border}20`,
                background: `${color}06`,
                transition: 'background 0.12s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = t.bgActive}
              onMouseLeave={e => e.currentTarget.style.background = `${color}06`}
            >
              <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>{sym.replace('USD', '')}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color, fontFamily: t.fontUI }}>{d.signal || '—'}</div>
              <div style={{ fontSize: 7, color: t.textMuted, fontFamily: t.fontUI }}>
                {d.timestamp ? fmtIST(d.timestamp) : '—'}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Confirmation Signals [Simple] mini panel ──────────────────────
function ConfSimpleMiniPanel({ confSignals, t, onOpen }) {
  const entries = Object.entries(confSignals || {})

  const strengthColor = (s) => s === 'STRONG' ? t.bull : s === 'MODERATE' ? t.amber : t.textMuted

  return (
    <div style={{
      border: `1px solid ${t.border}`, borderRadius: t.radius,
      overflow: 'hidden', marginBottom: 10, flex: 1, minWidth: 220,
    }}>
      <div style={{
        padding: '5px 10px', background: t.headerGrad,
        borderBottom: `1px solid ${t.border}`,
        fontSize: 9, color: t.amber, fontFamily: t.fontUI, fontWeight: 700,
        letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{
          background: `${t.amber}20`, border: `1px solid ${t.amber}40`,
          padding: '1px 5px', borderRadius: 3, fontSize: 8,
        }}>CONF[S]</span>
        5m CRYPTO
      </div>
      {entries.length === 0 ? (
        <div style={{
          padding: '10px 12px', fontSize: 8, color: t.textDim,
          fontFamily: t.fontUI, textAlign: 'center', letterSpacing: 0.3,
        }}>
          AWAITING SCAN — runs every 5m
        </div>
      ) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 0 }}>
        {entries.map(([sym, d]) => {
          const isBuy    = d.signal === 'BUY'
          const isNeutral = d.signal === 'NEUTRAL'
          const color    = isNeutral ? t.textMuted : isBuy ? t.bull : t.bear
          const conf     = d.confirmations || {}
          return (
            <div
              key={sym}
              onClick={() => onOpen({
                ...d, symbol: sym, source: 'conf_simple', market: 'crypto',
                indicator: 'CONF_SIMPLE',
                verdict: d.signal === 'BUY' ? 'GO' : d.signal === 'SELL' ? 'WATCH' : 'WATCH',
              })}
              style={{
                padding: '6px 8px', cursor: 'pointer',
                borderRight: `1px solid ${t.border}20`,
                borderBottom: `1px solid ${t.border}20`,
                background: isNeutral ? 'transparent' : `${color}06`,
                transition: 'background 0.12s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = t.bgActive}
              onMouseLeave={e => e.currentTarget.style.background = isNeutral ? 'transparent' : `${color}06`}
            >
              <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>{sym.replace('USD', '')}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color, fontFamily: t.fontUI }}>
                {d.signal || '—'}
              </div>
              {/* Confirmation dots: RSI · EMA · MACD · VOL */}
              <div style={{ display: 'flex', gap: 2, marginTop: 2 }}>
                {[
                  { k: 'rsi',    bull: conf.rsi?.bull,    bear: conf.rsi?.bear    },
                  { k: 'ema',    bull: conf.ema?.bull,    bear: conf.ema?.bear    },
                  { k: 'macd',   bull: conf.macd?.bull,   bear: conf.macd?.bear   },
                  { k: 'volume', bull: conf.volume?.confirming, bear: conf.volume?.confirming },
                ].map(({ k, bull, bear }) => {
                  const active = isBuy ? bull : bear
                  return (
                    <div key={k} style={{
                      width: 5, height: 5, borderRadius: '50%',
                      background: active ? color : `${t.border}`,
                    }} title={k} />
                  )
                })}
              </div>
              <div style={{ fontSize: 7, color: strengthColor(d.strength), fontFamily: t.fontUI, marginTop: 1 }}>
                {d.strength || '—'}
              </div>
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}

// ── Signal card ────────────────────────────────────────────────────
function SignalCard({ sig, t, onOpen, onChart, tickers }) {
  const srcKey = sig.source || ''
  const isRfDw   = srcKey.includes('rf_dw')   || sig.indicator?.includes('RF')
  const isConf   = srcKey.includes('conf_simple') || sig.indicator?.includes('CONF')
  const isAgent  = !isRfDw && !isConf

  const sourceLabel = isRfDw ? 'RF[DW]' : isConf ? 'CONF[S]' : 'AGENT'
  const sourceColor = isRfDw ? t.cyan : isConf ? t.amber : t.accent

  const verdict   = sig.verdict || sig.signal || '—'
  const vColor    = verdict === 'GO' || verdict === 'BUY' ? t.bull
                  : verdict === 'WATCH' ? t.amber : t.bear
  const conviction = sig.conviction

  const tick     = tickers[sig.symbol] || {}
  const price    = tick.price ?? sig.entry_price ?? sig.price
  const change   = tick.change ?? sig.chg
  const chgNum   = parseFloat(change)
  const chgColor = !change || isNaN(chgNum) ? t.textDim : chgNum >= 0 ? t.bull : t.bear

  const scores  = sig['SCORE CARD'] || {}
  const overall = scores.overall ?? sig.score ?? sig.overall_score

  // Conf Simple specific: confirmation dots
  const conf = sig.confirmations
  const isBuy = sig.signal === 'BUY' || sig.verdict === 'GO'

  return (
    <div
      onClick={() => onOpen(sig)}
      style={{
        border: `1px solid ${vColor}30`, borderRadius: t.radius,
        background: `${vColor}04`, padding: '10px 12px', cursor: 'pointer',
        transition: 'all 0.15s ease', position: 'relative',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = `${vColor}70`
        e.currentTarget.style.background  = `${vColor}08`
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = `${vColor}30`
        e.currentTarget.style.background  = `${vColor}04`
      }}
    >
      {/* Source badge */}
      <div style={{ position: 'absolute', top: 8, right: 10 }}>
        <span style={{
          fontSize: 7, padding: '1px 5px', borderRadius: 2, fontWeight: 700,
          fontFamily: t.fontUI, letterSpacing: 0.5,
          background: `${sourceColor}18`, color: sourceColor,
          border: `1px solid ${sourceColor}35`,
        }}>{sourceLabel}</span>
      </div>

      {/* Symbol + market */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: t.cyan, fontFamily: t.fontUI }}>{sig.symbol}</span>
        <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>
          {(sig.market || '').replace('_', ' ').toUpperCase()}
        </span>
      </div>

      {/* Company / strategy */}
      {(sig.company_name || sig.strategy) && (
        <div style={{
          fontSize: 8, color: t.textMuted, fontFamily: t.fontUI, marginBottom: 6,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {sig.company_name || sig.strategy}
        </div>
      )}

      {/* Live price + change */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>
          {typeof price === 'number'
            ? `${sig.market === 'crypto' ? '$' : '₹'}${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
            : price || '—'}
        </span>
        <span style={{ fontSize: 9, color: chgColor, fontFamily: t.fontUI }}>
          {!change || isNaN(chgNum) ? '' : `${chgNum >= 0 ? '+' : ''}${chgNum.toFixed(2)}%`}
        </span>
      </div>

      {/* Verdict + conviction */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: vColor, fontFamily: t.fontUI }}>
          {verdict === 'GO' ? '● GO' : verdict === 'WATCH' ? '◐ WATCH'
           : verdict === 'BUY' ? '▲ BUY' : verdict === 'SELL' ? '▼ SELL'
           : verdict === 'NEUTRAL' ? '— NEUTRAL' : verdict}
        </span>
        {conviction && conviction !== '—' && (
          <span style={{
            fontSize: 8, padding: '1px 5px', borderRadius: 2,
            background: `${vColor}15`, color: vColor,
            fontFamily: t.fontUI, border: `1px solid ${vColor}30`,
          }}>{conviction}</span>
        )}
        {overall != null && (
          <span style={{ fontSize: 8, color: t.textMuted, fontFamily: t.fontUI, marginLeft: 'auto' }}>
            Score <span style={{
              color: overall >= 7 ? t.bull : overall >= 5 ? t.amber : t.bear,
              fontWeight: 700,
            }}>{overall}</span>/10
          </span>
        )}
      </div>

      {/* Conf Simple: confirmation dots row */}
      {isConf && conf && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          {[
            { label: 'RSI',  bull: conf.rsi?.bull,    bear: conf.rsi?.bear    },
            { label: 'EMA',  bull: conf.ema?.bull,    bear: conf.ema?.bear    },
            { label: 'MACD', bull: conf.macd?.bull,   bear: conf.macd?.bear   },
            { label: 'VOL',  bull: conf.volume?.confirming, bear: conf.volume?.confirming },
          ].map(({ label, bull, bear }) => {
            const active = isBuy ? bull : bear
            return (
              <span key={label} style={{
                fontSize: 7, padding: '1px 4px', borderRadius: 2,
                fontFamily: t.fontUI, fontWeight: 600,
                background: active ? `${vColor}20` : `${t.border}20`,
                color: active ? vColor : t.textMuted,
                border: `1px solid ${active ? vColor : t.border}40`,
              }}>{label}</span>
            )
          })}
          {sig.strength && (
            <span style={{
              fontSize: 7, color: sig.strength === 'STRONG' ? vColor : t.textMuted,
              fontFamily: t.fontUI, marginLeft: 'auto', fontWeight: 700,
            }}>{sig.strength}</span>
          )}
        </div>
      )}

      {/* SMC structure label (agent signals) */}
      {isAgent && (sig.smc_structure || sig.smc_analysis?.structure) && (() => {
        const struct = sig.smc_structure || sig.smc_analysis.structure
        if (!struct || struct === 'ranging') return null
        const isBull = struct.includes('bull') || struct.includes('choch_bullish')
        const c = isBull ? t.bull : t.bear
        return (
          <div style={{ fontSize: 7, color: c, fontFamily: t.fontUI, letterSpacing: 0.4, fontWeight: 600 }}>
            {struct.replace(/_/g, ' ').toUpperCase()}
          </div>
        )
      })()}

      {/* Footer: chart button + hint */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 6 }}>
        <button
          onClick={e => { e.stopPropagation(); onChart(sig.symbol) }}
          title="View price chart"
          style={{
            padding: '2px 7px', fontSize: 9, fontFamily: t.fontUI, cursor: 'pointer',
            borderRadius: 4, border: `1px solid ${t.border}`,
            background: 'transparent', color: t.textDim, display: 'flex', alignItems: 'center', gap: 4,
            transition: 'all 0.12s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = t.accent; e.currentTarget.style.color = t.accent }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = t.border; e.currentTarget.style.color = t.textDim }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          Chart
        </button>
        <span style={{ fontSize: 7, color: t.textDim, fontFamily: t.fontUI, marginLeft: 'auto' }}>
          Click for analysis →
        </span>
      </div>
    </div>
  )
}

// ── Filter bar ─────────────────────────────────────────────────────
function FilterBar({ filter, setFilter, t }) {
  const markets     = ['ALL', 'INDIA', 'CRYPTO', 'COMMODITY']
  const verdicts    = ['ALL', 'GO', 'WATCH']
  const convictions = ['ALL', 'HIGH', 'MEDIUM', 'LOW']

  // Indicator options — grows as new indicators are added
  const indicators = [
    { value: 'ALL',        label: 'All Indicators' },
    { value: 'AGENT',      label: 'AI Agent' },
    { value: 'RF_DW',      label: 'RF [DW]' },
    { value: 'CONF_SIMPLE', label: 'Confirmation Signals [Simple]' },
  ]

  function Chip({ value, active, color, onClick }) {
    const c = color || t.accent
    return (
      <button onClick={onClick} style={{
        background: active ? `${c}18` : 'none',
        border: `1px solid ${active ? c : t.border}`,
        color: active ? c : t.textDim,
        fontSize: 8, padding: '2px 8px',
        cursor: 'pointer', borderRadius: 2, fontFamily: t.fontUI,
      }}>{value}</button>
    )
  }

  // Styled select matching terminal theme
  const selectStyle = {
    background: t.bgInput || t.bgActive,
    border: `1px solid ${filter.indicator !== 'ALL' ? t.amber : t.border}`,
    color: filter.indicator !== 'ALL' ? t.amber : t.textDim,
    fontSize: 9, padding: '3px 8px',
    borderRadius: 3, fontFamily: t.fontUI,
    cursor: 'pointer', outline: 'none',
    fontWeight: filter.indicator !== 'ALL' ? 700 : 400,
    minWidth: 180,
  }

  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
      padding: '7px 12px', borderBottom: `1px solid ${t.border}`,
      background: t.headerGrad, flexShrink: 0,
    }}>
      {/* Indicator dropdown */}
      <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginRight: 2 }}>INDICATOR:</span>
      <select
        value={filter.indicator}
        onChange={e => setFilter(f => ({ ...f, indicator: e.target.value }))}
        style={selectStyle}
      >
        {indicators.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>

      {/* Divider */}
      <div style={{ width: 1, height: 16, background: t.border, margin: '0 4px' }} />

      <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginRight: 2 }}>MARKET:</span>
      {markets.map(m => (
        <Chip key={m} value={m} active={filter.market === m} color={t.accent}
          onClick={() => setFilter(f => ({ ...f, market: m }))} />
      ))}

      <div style={{ width: 1, height: 16, background: t.border, margin: '0 4px' }} />

      <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginRight: 2 }}>VERDICT:</span>
      {verdicts.map(v => (
        <Chip key={v} value={v} active={filter.verdict === v}
          color={v === 'GO' ? t.bull : v === 'WATCH' ? t.amber : t.accent}
          onClick={() => setFilter(f => ({ ...f, verdict: v }))} />
      ))}

      <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, margin: '0 2px 0 8px' }}>CONVICTION:</span>
      {convictions.map(c => (
        <Chip key={c} value={c} active={filter.conviction === c} color={t.amber}
          onClick={() => setFilter(f => ({ ...f, conviction: c }))} />
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────
export default function SignalsPage() {
  const t = useTheme()

  const signals            = useDataStore(s => s.signals)
  const positions          = useDataStore(s => s.positions)
  const tickers            = useDataStore(s => s.tickers)
  const wsConfSignals      = useDataStore(s => s.confSimpleSignals)
  const openPopup          = useTerminalStore(s => s.openSignalPopup)

  const [activeTab, setActiveTab] = useState('signals')
  const [chartSymbol, setChartSymbol] = useState(null)
  const [filter, setFilter] = useState({
    indicator: 'ALL', market: 'ALL', verdict: 'ALL', conviction: 'ALL',
  })

  // ── RF[DW] data ───────────────────────────────────────────────
  const { data: rfData } = useQuery({
    queryKey: ['rfDwSignals'],
    queryFn: getRfDwSignals,
    refetchInterval: 30_000,
  })
  const rfSignals = rfData?.signals || {}

  // ── Confirmation Simple data ──────────────────────────────────
  // REST poll seeds the cache; WebSocket (wsConfSignals) applies real-time updates.
  const { data: confData } = useQuery({
    queryKey: ['confSimpleSignals'],
    queryFn: getConfSimpleSignals,
    refetchInterval: 60_000,
  })
  const confSignals = useMemo(() => {
    const polled = confData?.signals || {}
    // WebSocket updates override polled data per symbol (more recent)
    const merged = { ...polled, ...wsConfSignals }
    if (Object.keys(merged).length === 0 && import.meta.env.DEV) return DEV_CONF_SIGNALS
    return merged
  }, [confData, wsConfSignals])

  // ── Merged signal list ────────────────────────────────────────
  const allSignals = useMemo(() => {
    const rfRows = Object.entries(rfSignals).map(([sym, d]) => ({
      ...d, symbol: sym, market: 'crypto', source: 'rf_dw', indicator: 'RF_DW',
      verdict: d.signal === 'BUY' ? 'GO' : 'WATCH',
    }))
    const confRows = Object.entries(confSignals).map(([sym, d]) => ({
      ...d, symbol: sym, market: 'crypto', source: 'conf_simple', indicator: 'CONF_SIMPLE',
      verdict: d.signal === 'BUY' ? 'GO' : d.signal === 'SELL' ? 'WATCH' : 'WATCH',
    }))
    return [...signals, ...rfRows, ...confRows]
  }, [signals, rfSignals, confSignals])

  // ── Filtered view ─────────────────────────────────────────────
  const filtered = useMemo(() => allSignals.filter(s => {
    // Indicator
    if (filter.indicator !== 'ALL') {
      const srcKey = s.source || ''
      const indKey = s.indicator || ''
      if (filter.indicator === 'AGENT') {
        if (srcKey.includes('rf_dw') || srcKey.includes('conf_simple') ||
            indKey.includes('RF') || indKey.includes('CONF')) return false
      } else if (filter.indicator === 'RF_DW') {
        if (!srcKey.includes('rf_dw') && !indKey.includes('RF_DW')) return false
      } else if (filter.indicator === 'CONF_SIMPLE') {
        if (!srcKey.includes('conf_simple') && !indKey.includes('CONF_SIMPLE')) return false
      }
    }
    // Market
    if (filter.market !== 'ALL') {
      const mkt = s.market || ''
      const m   = filter.market.toLowerCase()
      if (m === 'india'     && !mkt.includes('india'))     return false
      if (m === 'crypto'    && !mkt.includes('crypto'))    return false
      if (m === 'commodity' && !mkt.includes('commodity')) return false
    }
    // Verdict
    if (filter.verdict !== 'ALL') {
      if (s.verdict?.toUpperCase() !== filter.verdict) return false
    }
    // Conviction
    if (filter.conviction !== 'ALL' && s.conviction) {
      if (s.conviction?.toUpperCase() !== filter.conviction) return false
    }
    return true
  }), [allSignals, filter])

  // Which mini-panels to show
  const showRfPanel   = filter.indicator === 'ALL' || filter.indicator === 'RF_DW'
  const showConfPanel = filter.indicator === 'ALL' || filter.indicator === 'CONF_SIMPLE'

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

      {/* Left sidebar watchlist */}
      <ErrorBoundary scope="TV WATCHLIST">
        <TVWatchlist />
      </ErrorBoundary>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        <ActivePnLPanel positions={positions} t={t} />

        {/* Tab bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 0,
          borderBottom: `1px solid ${t.border}`,
          background: t.headerGrad, flexShrink: 0,
        }}>
          {[
            { key: 'signals',     label: 'SIGNALS' },
            { key: 'performance', label: 'PERFORMANCE' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '8px 16px', fontSize: 9, fontFamily: t.fontUI,
                fontWeight: 700, letterSpacing: 0.6,
                color: activeTab === tab.key ? t.accent : t.textDim,
                borderBottom: activeTab === tab.key ? `2px solid ${t.accent}` : '2px solid transparent',
                marginBottom: -1,
                transition: 'color 0.15s',
              }}
            >{tab.label}</button>
          ))}
        </div>

        {activeTab === 'performance' ? (
          <SignalPerformance />
        ) : (
          <>
            <FilterBar filter={filter} setFilter={setFilter} t={t} />

            <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>

              {/* Indicator mini-panels side by side */}
              {(showRfPanel || showConfPanel) && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 2, flexWrap: 'wrap' }}>
                  {showRfPanel   && <RfDwMiniPanel    rfSignals={rfSignals}     t={t} onOpen={openPopup} />}
                  {showConfPanel && <ConfSimpleMiniPanel confSignals={confSignals} t={t} onOpen={openPopup} />}
                </div>
              )}

              {/* Signal count */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>
                  {filtered.length} signal{filtered.length !== 1 ? 's' : ''} — click any card for full analysis
                </span>
                <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginLeft: 'auto' }}>
                  {filtered.filter(s => s.verdict === 'GO').length} GO ·{' '}
                  {filtered.filter(s => s.verdict === 'WATCH').length} WATCH
                </span>
              </div>

              {filtered.length === 0 && (
                <div style={{
                  padding: '40px 20px', textAlign: 'center',
                  color: t.textMuted, fontSize: 10, fontFamily: t.fontUI,
                }}>
                  {allSignals.length === 0
                    ? 'Signal pipeline has not run yet — scanner generates signals during market hours and every 4h for crypto.'
                    : 'No signals match the current filters.'}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                {filtered.map((sig, i) => (
                  <SignalCard
                    key={sig.signal_id || sig.id || `${sig.symbol}-${sig.source}-${i}`}
                    sig={sig}
                    t={t}
                    onOpen={openPopup}
                    onChart={setChartSymbol}
                    tickers={tickers}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {chartSymbol && (
        <PriceChart
          symbol={chartSymbol}
          onClose={() => setChartSymbol(null)}
          t={t}
        />
      )}
    </div>
  )
}
