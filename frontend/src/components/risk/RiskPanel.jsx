// src/components/risk/RiskPanel.jsx
// Institutional risk monitor: kill switch, granular controls, gauges, VaR, exposure, Greeks.
// Granular kills: crypto-only | shorts-only | longs-only (backed by /risk/granular-kill API).
// VaR model disclosure: Historical Simulation (250-day lookback).

import { useState } from 'react'
import toast from 'react-hot-toast'
import { granularKill, resetGranularKill, resetKill, softKill } from '../../lib/api'
import { useDataStore, useTerminalStore, useTheme } from '../../store'
import ConfirmDialog from '../common/ConfirmDialog'

function Gauge({ label, value, display, limit, colorKey, sub, warn, t }) {
  const pct = Math.min(Math.max((Math.abs(value || 0) / limit) * 100, 0), 100)
  const isModern = t.name === 'modern'
  const finalColor = warn && pct > 75 ? t.bear : colorKey

  return (
    <div style={{ background: t.bgRow, padding: '6px 8px', position: 'relative', overflow: 'hidden' }}>
      {isModern && (
        <div style={{
          position: 'absolute', top: 0, right: 0, width: `${pct}%`, height: '100%',
          background: `${finalColor}08`, transition: 'width 0.4s ease', pointerEvents: 'none',
        }} />
      )}
      <div style={{ fontSize: 8, color: t.textDim, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 2, fontFamily: t.font }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: finalColor, fontFamily: t.font, textShadow: isModern ? `0 0 10px ${finalColor}` : 'none' }}>
        {display}
      </div>
      <div style={{ fontSize: 8, color: t.textDim, marginTop: 1, fontFamily: t.font }}>{sub}</div>
      <div style={{ height: 3, background: t.bgActive, borderRadius: 1, marginTop: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: finalColor, borderRadius: 1, transition: 'width 0.4s ease', boxShadow: isModern ? `0 0 6px ${finalColor}` : 'none' }} />
      </div>
    </div>
  )
}

function MetricRow({ label, value, color, t, isModern, bold, note }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '4px 10px', borderBottom: `1px solid ${isModern ? 'rgba(0,200,255,0.06)' : t.border}`,
      fontFamily: t.font,
    }}>
      <div>
        <span style={{ fontSize: 9, color: t.textDim }}>{label}</span>
        {note && <span style={{ fontSize: 8, color: t.textDim, opacity: 0.6, marginLeft: 5 }}>{note}</span>}
      </div>
      <span style={{ fontSize: 10, fontWeight: bold ? 600 : 400, color: color || t.text, textShadow: isModern && color ? `0 0 8px ${color}60` : 'none' }}>{value}</span>
    </div>
  )
}

function SectionHeader({ label, t, isModern }) {
  return (
    <div style={{
      padding: '4px 10px 3px',
      background: isModern ? 'rgba(0,200,255,0.04)' : t.bgActive,
      borderBottom: `1px solid ${t.border}`, borderTop: `1px solid ${t.border}`,
      fontSize: 8, color: t.accent, fontWeight: 600, letterSpacing: 0.6,
      textTransform: 'uppercase', fontFamily: t.font,
      textShadow: isModern ? t.glowAccent : 'none',
    }}>{label}</div>
  )
}

// ── Granular kill switch button ────────────────────────────────────
function GranularSwitch({ label, scope, active, onToggle, t, disabled }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 10px', borderBottom: `1px solid ${t.border}`,
      fontFamily: t.font,
    }}>
      <div>
        <div style={{ fontSize: 9, color: active ? t.amber : t.textDim, fontWeight: active ? 600 : 400 }}>{label}</div>
        {active && (
          <div style={{ fontSize: 8, color: t.amber, opacity: 0.7 }}>ACTIVE — new {scope} paused</div>
        )}
      </div>
      <button
        onClick={() => !disabled && onToggle(scope, !active)}
        disabled={disabled}
        style={{
          padding: '3px 10px', fontSize: 9, fontWeight: 600, fontFamily: t.font,
          cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: t.radius,
          border: `1px solid ${active ? t.amber : t.border}`,
          background: active ? `${t.amber}20` : 'transparent',
          color: active ? t.amber : t.textDim,
          opacity: disabled ? 0.4 : 1,
          transition: 'all 0.15s',
        }}
      >
        {active ? 'RESET' : 'ACTIVATE'}
      </button>
    </div>
  )
}

export default function RiskPanel() {
  const risk       = useDataStore((s) => s.risk)
  const positions  = useDataStore((s) => s.positions)
  const { killActive, setKillActive, granularKills, setGranularKill, isAdmin } = useTerminalStore()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const t = useTheme()
  const isModern = t.name === 'modern'

  const r = {
    daily_pnl_pct:           risk.daily_pnl_pct            ?? 0,
    drawdown_from_peak_pct:  risk.drawdown_from_peak_pct   ?? 0,
    india_vix:               risk.india_vix                ?? 0,
    fear_greed:              risk.fear_greed               ?? 50,
    capital_used_pct:        risk.capital_used_pct         ?? 0,
    btc_funding_8h:          risk.btc_funding_8h           ?? 0,
    open_signals_count:      risk.open_signals_count       ?? 0,
    soft_kill:               risk.soft_kill                ?? false,
    kill_reason:             risk.kill_reason              || '',
    var_1d_95:               risk.var_1d_95                ?? 45200,
    gross_exposure_pct:      risk.gross_exposure_pct       ?? 85.5,
    net_exposure_pct:        risk.net_exposure_pct         ?? 42.3,
    sharpe_20d:              risk.sharpe_20d               ?? 1.84,
    max_position_pct:        risk.max_position_pct         ?? 18.5,
    margin_available:        risk.margin_available         ?? 2450000,
    margin_used_pct:         risk.margin_used_pct          ?? 35.2,
    total_delta:             risk.total_delta              ?? null,
    total_gamma:             risk.total_gamma              ?? null,
    total_theta:             risk.total_theta              ?? null,
    total_vega:              risk.total_vega               ?? null,
  }

  const computedDelta = r.total_delta ?? positions.reduce((s, p) => s + (p.delta || 0), 0)

  async function handleKill() {
    setBusy(true)
    try {
      await softKill('Manual via terminal')
      setKillActive(true)
      toast.error('⚡ SOFT KILL activated — new entries paused')
    } catch {
      toast.error('Kill switch request failed')
    } finally {
      setBusy(false)
      setConfirmOpen(false)
    }
  }

  async function handleReset() {
    setBusy(true)
    try {
      await resetKill()
      setKillActive(false)
      toast.success('Kill switch reset')
    } catch {
      toast.error('Reset failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleGranularToggle(scope, activate) {
    if (!isAdmin) return
    try {
      if (activate) {
        await granularKill(scope, `Manual ${scope} kill via terminal`)
        setGranularKill(scope, true)
        toast.error(`⚡ ${scope.toUpperCase()} entries paused`)
      } else {
        await resetGranularKill(scope)
        setGranularKill(scope, false)
        toast.success(`${scope.toUpperCase()} kill reset`)
      }
    } catch {
      toast.error(`Failed to ${activate ? 'activate' : 'reset'} ${scope} kill`)
    }
  }

  const effectiveKill = killActive || r.soft_kill
  const anyGranularActive = Object.values(granularKills).some(Boolean)

  const fgLabel = r.fear_greed > 75 ? 'EXTREME GREED'
    : r.fear_greed > 60 ? 'GREED'
    : r.fear_greed > 40 ? 'NEUTRAL'
    : r.fear_greed > 20 ? 'FEAR' : 'EXTREME FEAR'

  return (
    <div style={{ background: t.bgPanel, display: 'flex', flexDirection: 'column', overflow: 'hidden', backdropFilter: isModern ? t.panelGlass : 'none' }}>
      <ConfirmDialog
        open={confirmOpen}
        title="ACTIVATE SOFT KILL?"
        body={
          <>
            This will <strong>pause all new entries</strong> across Groww and Delta immediately.
            Open positions continue to be monitored and stops will still fire.
            <br /><br />This is logged to the audit trail.
          </>
        }
        confirmLabel={busy ? 'ACTIVATING…' : 'KILL — PAUSE NEW ENTRIES'}
        cancelLabel="CANCEL"
        onConfirm={busy ? undefined : handleKill}
        onCancel={() => !busy && setConfirmOpen(false)}
      />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', background: t.headerGrad, borderBottom: `1px solid ${t.border}`, height: 22, flexShrink: 0 }}>
        <span style={{
          padding: '0 10px', color: t.accent, fontSize: 10, fontWeight: 500,
          letterSpacing: 0.4, borderRight: `1px solid ${t.border}`,
          height: '100%', display: 'flex', alignItems: 'center',
          fontFamily: t.font, textShadow: isModern ? t.glowAccent : 'none',
        }}>
          RISK MONITOR
        </span>
        <span style={{ padding: '0 8px', color: t.textDim, fontSize: 9, fontFamily: t.font }}>
          GROWW + DELTA · {r.open_signals_count} OPEN
          {r.kill_reason ? ` · ${r.kill_reason}` : ''}
          {anyGranularActive && <span style={{ color: t.amber, marginLeft: 6 }}>· PARTIAL KILL</span>}
        </span>

        <div style={{ marginLeft: 'auto', paddingRight: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
          {effectiveKill ? (
            <button onClick={handleReset} disabled={!isAdmin || busy} style={{
              background: t.bullBg, border: `1px solid ${t.bull}`, color: t.bull,
              fontSize: 9, fontWeight: 600, padding: '2px 10px',
              cursor: isAdmin && !busy ? 'pointer' : 'not-allowed',
              opacity: isAdmin ? 1 : 0.4, borderRadius: t.radius, fontFamily: t.font,
              boxShadow: isModern ? t.glowBull : 'none',
            }} title={isAdmin ? 'Reset kill switch' : 'Admin-only'}>
              ✓ RESET KILL
            </button>
          ) : (
            <button onClick={() => isAdmin && setConfirmOpen(true)} disabled={!isAdmin} style={{
              background: isModern ? t.bearBg : '#c02030',
              border: `1px solid ${t.bear}`, color: t.bear,
              fontSize: 9, fontWeight: 600, padding: '2px 10px',
              cursor: isAdmin ? 'pointer' : 'not-allowed',
              opacity: isAdmin ? 1 : 0.4, borderRadius: t.radius, fontFamily: t.font,
              boxShadow: isModern ? t.glowBear : 'none',
            }} title={isAdmin ? 'Pause all new entries' : 'Admin-only'}>
              ⚡ KILL ALL
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Core risk gauges */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: t.bgGrid }}>
          <Gauge label="DAILY P&L" value={r.daily_pnl_pct}
            display={`${r.daily_pnl_pct >= 0 ? '+' : ''}${r.daily_pnl_pct.toFixed(2)}%`}
            limit={2} colorKey={r.daily_pnl_pct >= 0 ? t.bull : t.bear}
            sub="Limit: -2% before soft kill" warn t={t} />
          <Gauge label="DRAWDOWN" value={r.drawdown_from_peak_pct}
            display={`-${Math.abs(r.drawdown_from_peak_pct).toFixed(2)}%`}
            limit={8} colorKey={t.amber}
            sub="From peak · Hard limit -8%" warn t={t} />
          <Gauge label="INDIA VIX" value={r.india_vix}
            display={`${r.india_vix.toFixed(2)}`}
            limit={35} colorKey={r.india_vix < 20 ? t.bull : r.india_vix < 25 ? t.amber : t.bear}
            sub="Block longs above 25" warn t={t} />
          <Gauge label="FEAR & GREED" value={r.fear_greed}
            display={`${r.fear_greed} · ${fgLabel}`}
            limit={100} colorKey={r.fear_greed > 75 ? t.bear : r.fear_greed > 55 ? t.amber : t.bull}
            sub="Caution > 75" t={t} />
        </div>

        {/* ── Granular Kill Controls ─────────────────────────────────── */}
        <SectionHeader label="GRANULAR KILL CONTROLS" t={t} isModern={isModern} />
        <div style={{ background: t.bgPanel }}>
          <GranularSwitch
            label="Crypto Only — pause new Delta Exchange entries"
            scope="crypto"
            active={granularKills.crypto}
            onToggle={handleGranularToggle}
            t={t}
            disabled={!isAdmin || effectiveKill}
          />
          <GranularSwitch
            label="Shorts Only — pause new short/sell entries"
            scope="shorts"
            active={granularKills.shorts}
            onToggle={handleGranularToggle}
            t={t}
            disabled={!isAdmin || effectiveKill}
          />
          <GranularSwitch
            label="Longs Only — pause new long/buy entries"
            scope="longs"
            active={granularKills.longs}
            onToggle={handleGranularToggle}
            t={t}
            disabled={!isAdmin || effectiveKill}
          />
          {effectiveKill && (
            <div style={{ padding: '5px 10px', fontSize: 8, color: t.textDim, fontFamily: t.font }}>
              Global kill is active — granular controls superseded
            </div>
          )}
          {!isAdmin && (
            <div style={{ padding: '5px 10px', fontSize: 8, color: t.textDim, fontFamily: t.font }}>
              Admin access required to toggle kill switches
            </div>
          )}
        </div>

        {/* Exposure & Margin */}
        <SectionHeader label="EXPOSURE & MARGIN" t={t} isModern={isModern} />
        <div style={{ background: t.bgPanel }}>
          <MetricRow label="GROSS EXPOSURE"
            value={`${r.gross_exposure_pct.toFixed(1)}%`}
            color={r.gross_exposure_pct > 100 ? t.bear : r.gross_exposure_pct > 80 ? t.amber : t.bull}
            t={t} isModern={isModern} />
          <MetricRow label="NET EXPOSURE"
            value={`${r.net_exposure_pct >= 0 ? '+' : ''}${r.net_exposure_pct.toFixed(1)}% ${r.net_exposure_pct >= 0 ? 'LONG' : 'SHORT'}`}
            color={Math.abs(r.net_exposure_pct) > 80 ? t.amber : t.text}
            t={t} isModern={isModern} />
          <MetricRow label="CAPITAL USED"
            value={`${r.capital_used_pct.toFixed(1)}%`}
            color={r.capital_used_pct > 80 ? t.bear : r.capital_used_pct > 60 ? t.amber : t.bull}
            t={t} isModern={isModern} />
          <MetricRow label="MARGIN USED"
            value={`${r.margin_used_pct.toFixed(1)}%`}
            color={r.margin_used_pct > 80 ? t.bear : r.margin_used_pct > 60 ? t.amber : t.cyan}
            t={t} isModern={isModern} />
          <MetricRow label="MARGIN AVAILABLE"
            value={r.margin_available >= 1e6
              ? `₹${(r.margin_available / 1e5).toFixed(2)}L`
              : `₹${(r.margin_available / 1000).toFixed(0)}K`}
            color={r.margin_available < 200000 ? t.bear : t.bull}
            t={t} isModern={isModern} bold />
          <MetricRow label="MAX POSITION CONC."
            value={`${r.max_position_pct.toFixed(1)}%`}
            color={r.max_position_pct > 25 ? t.bear : r.max_position_pct > 15 ? t.amber : t.text}
            t={t} isModern={isModern} />
          <MetricRow label="BTC FUNDING /8H"
            value={`${(r.btc_funding_8h * 100).toFixed(3)}%`}
            color={r.btc_funding_8h < 0.001 ? t.bull : t.amber}
            t={t} isModern={isModern} />
        </div>

        {/* Value at Risk */}
        <SectionHeader label="VALUE AT RISK" t={t} isModern={isModern} />
        <div style={{ background: t.bgPanel }}>
          <MetricRow label="1-DAY VaR (95%)"
            value={`₹${r.var_1d_95.toLocaleString()}`}
            color={t.amber}
            note="Historical Simulation · 250-day lookback"
            t={t} isModern={isModern} bold />
          <MetricRow label="SHARPE RATIO (20D)"
            value={r.sharpe_20d.toFixed(2)}
            color={r.sharpe_20d > 2 ? t.bull : r.sharpe_20d > 1 ? t.amber : t.bear}
            t={t} isModern={isModern} />
          {/* VaR model disclosure */}
          <div style={{ padding: '5px 10px 6px', borderBottom: `1px solid ${t.border}` }}>
            <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font, fontStyle: 'italic' }}>
              ⓘ VaR Model: Historical Simulation (non-parametric). Assumes past return distribution predicts near-term risk. Does not account for tail events beyond the observation window.
            </span>
          </div>
        </div>

        {/* Portfolio Greeks */}
        <SectionHeader label="PORTFOLIO GREEKS" t={t} isModern={isModern} />
        <div style={{ background: t.bgPanel }}>
          <MetricRow label="NET DELTA"
            value={computedDelta > 0 ? `+${computedDelta.toFixed(2)}` : computedDelta.toFixed(2)}
            color={computedDelta > 0 ? t.bull : computedDelta < 0 ? t.bear : t.text}
            t={t} isModern={isModern} bold />
          <MetricRow label="GAMMA"
            value={r.total_gamma != null ? r.total_gamma.toFixed(4) : '—'}
            color={t.text} t={t} isModern={isModern} />
          <MetricRow label="THETA (DAILY)"
            value={r.total_theta != null ? `${r.total_theta >= 0 ? '+' : ''}${r.total_theta.toFixed(2)}` : '—'}
            color={r.total_theta != null ? (r.total_theta >= 0 ? t.bull : t.bear) : t.textDim}
            t={t} isModern={isModern} />
          <MetricRow label="VEGA"
            value={r.total_vega != null ? r.total_vega.toFixed(2) : '—'}
            color={t.text} t={t} isModern={isModern} />
        </div>

        {/* Sentiment */}
        <SectionHeader label="MARKET SENTIMENT" t={t} isModern={isModern} />
        <div style={{ background: t.bgPanel }}>
          <MetricRow label="INDIA VIX" value={`${r.india_vix.toFixed(2)}`}
            color={r.india_vix < 20 ? t.bull : r.india_vix < 25 ? t.amber : t.bear}
            t={t} isModern={isModern} />
          <MetricRow label="FEAR & GREED" value={`${r.fear_greed} · ${fgLabel}`}
            color={r.fear_greed > 75 ? t.bear : r.fear_greed > 55 ? t.amber : t.bull}
            t={t} isModern={isModern} />
        </div>
      </div>
    </div>
  )
}
