// src/components/market/IntradayPanel.jsx
// Intraday screener — 5-min/15-min based categories refreshed every 15 min.

import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { getIntradayScreener, triggerIntradayRefresh } from '../../lib/api'
import { useTerminalStore, useTheme } from '../../store'

const CATEGORY_META = {
  volume_spike_5m:   { label: 'Volume Spike',      subtitle: '5-min volume ≥ 2.5× average',   colorKey: 'amber',  icon: '⚡' },
  rsi_crossover_15m: { label: 'RSI Crossover',     subtitle: '15-min RSI crossed 50 upward',   colorKey: 'bull',   icon: '⟳' },
  near_vwap:         { label: 'Near VWAP',          subtitle: 'Within 0.3% of session VWAP',    colorKey: 'accent', icon: '⊗' },
  intraday_momentum: { label: 'Intraday Momentum',  subtitle: 'Up ≥0.8% on elevated volume',   colorKey: 'bull',   icon: '▶' },
  intraday_reversal: { label: 'Intraday Reversal',  subtitle: 'Extended move — reversal watch', colorKey: 'amber',  icon: '↩' },
  pivot_r1_breakout: { label: 'Pivot R1 Breakout',  subtitle: 'Above daily R1 pivot level',     colorKey: 'purple', icon: 'R1' },
  near_day_high:     { label: 'Near Day High',       subtitle: 'Within 0.5% of session high',   colorKey: 'cyan',   icon: '▲' },
  near_day_low:      { label: 'Near Day Low',        subtitle: 'Within 0.5% of session low',    colorKey: 'bear',   icon: '▼' },
}

function resolveColor(t, key) {
  return { bull: t.bull, bear: t.bear, amber: t.amber, cyan: t.cyan, purple: t.purple, accent: t.accent }[key] || t.textMuted
}

// ── Symbol avatar ──────────────────────────────────────────────────
function SymAvatar({ symbol, color }) {
  const abbr = symbol.replace(/[^A-Z]/g, '').slice(0, 2) || symbol.slice(0, 2)
  return (
    <div style={{
      width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
      background: `${color}18`, border: `1.5px solid ${color}40`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <span style={{ fontSize: 10, fontWeight: 800, color, letterSpacing: -0.5 }}>{abbr}</span>
    </div>
  )
}

// ── Single stock row ───────────────────────────────────────────────
function StockRow({ sym, ltp, chg, volR, vwap, color, t, onTrade }) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={() => onTrade(sym)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
        background: hov ? `${color}08` : 'transparent',
        borderBottom: `1px solid ${t.border}`,
        transition: 'background 0.12s', cursor: 'pointer',
      }}
    >
      <SymAvatar symbol={sym} color={color} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>{sym}</div>
        <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, marginTop: 1 }}>
          Vol {volR.toFixed(1)}×
          {vwap ? ` · VWAP ₹${Number(vwap).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : ''}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, fontFamily: t.fontUI }}>
          ₹{ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div style={{ fontSize: 10, fontFamily: t.fontUI, color: chg >= 0 ? t.bull : t.bear }}>
          {chg >= 0 ? '▲' : '▼'} {Math.abs(chg).toFixed(2)}%
        </div>
      </div>
    </div>
  )
}

// ── Category card ──────────────────────────────────────────────────
function CategoryCard({ catId, meta, stocks, t, onTrade }) {
  const [open, setOpen] = useState(true)
  const color = resolveColor(t, meta.colorKey)

  return (
    <div style={{
      borderRadius: t.radiusLg, border: `1px solid ${color}30`,
      background: t.bgCard, boxShadow: t.shadowCard,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
          background: `linear-gradient(90deg, ${color}14 0%, transparent 100%)`,
          borderBottom: `1px solid ${color}25`,
          cursor: 'pointer', flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 14, lineHeight: 1, minWidth: 18, textAlign: 'center' }}>{meta.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color, fontFamily: t.fontUI, letterSpacing: 0.3, textTransform: 'uppercase' }}>
            {meta.label}
          </div>
          <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 1 }}>
            {meta.subtitle}
          </div>
        </div>
        <span style={{
          padding: '2px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700,
          background: `${color}20`, color, border: `1px solid ${color}40`,
          fontFamily: t.fontUI, flexShrink: 0,
        }}>
          {stocks.length}
        </span>
        <span style={{
          fontSize: 10, color: t.textDim, flexShrink: 0,
          transform: open ? 'rotate(0)' : 'rotate(-90deg)', transition: 'transform 0.15s',
        }}>▾</span>
      </div>

      {/* Stock list */}
      {open && (
        <div style={{ overflowY: 'auto', maxHeight: 300 }}>
          {stocks.map((s, i) => {
            const sym  = (s.symbol || '').replace('.NS', '')
            const ltp  = Number(s.price || 0)
            const chg  = Number(s.change_pct || 0)
            const volR = Number(s.vol_ratio_5m || s.vol_ratio || 1)
            return (
              <StockRow key={i} sym={sym} ltp={ltp} chg={chg} volR={volR} vwap={s.vwap}
                color={color} t={t} onTrade={onTrade} />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────
export default function IntradayPanel() {
  const t          = useTheme()
  const openTicket = useTerminalStore(s => s.openOrderTicket)

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['intradayScreener'],
    queryFn:  getIntradayScreener,
    refetchInterval: 900_000,
  })

  const { mutate: triggerScan, isPending: triggering } = useMutation({
    mutationFn: triggerIntradayRefresh,
    onSuccess:  () => setTimeout(() => refetch(), 2000),
  })

  const cats     = data?.categories || {}
  const scanning = data?.scanning
  const lastScan = data?.last_scan
  const total    = data?.total_scanned || 0
  const hitCount = Object.values(cats).reduce((s, c) => s + (c.count || 0), 0)
  const busy     = isLoading || isFetching

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: t.bg }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Summary strip ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 16px', borderBottom: `1px solid ${t.border}`,
        background: t.headerGrad, flexShrink: 0,
      }}>
        {/* Icon + title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 30, height: 30, borderRadius: t.radius,
            background: `${t.amber}18`, border: `1px solid ${t.amber}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <span style={{ fontSize: 14 }}>⚡</span>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: t.text, fontFamily: t.fontUI, letterSpacing: 0.2 }}>
              INTRADAY SCREENER
            </div>
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>5-min & 15-min · NSE stocks</div>
          </div>
        </div>

        {hitCount > 0 && (
          <>
            <div style={{ width: 1, height: 16, background: t.border }} />
            {[
              { label: 'Hits',    val: hitCount, color: t.bull },
              { label: 'Scanned', val: total,    color: t.textMuted },
            ].map(({ label, val, color }) => (
              <div key={label} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 10px', borderRadius: t.radius,
                background: `${color}10`, border: `1px solid ${color}25`,
              }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
                <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>{label}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color, fontFamily: t.fontUI }}>{val}</span>
              </div>
            ))}
          </>
        )}

        {/* Right: last scan + refresh */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {lastScan && (
            <span style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI }}>
              Last: <strong style={{ color: t.textDim }}>{lastScan}</strong>
            </span>
          )}
          {data?.from_db && (
            <span style={{
              fontSize: 8, padding: '2px 6px', borderRadius: 4,
              background: `${t.amber}18`, border: `1px solid ${t.amber}30`,
              color: t.amber, fontFamily: t.fontUI,
            }}>from DB</span>
          )}
          <button onClick={() => triggerScan()} disabled={busy || triggering} style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 12px', borderRadius: t.radius, fontSize: 10,
            cursor: (busy || triggering) ? 'default' : 'pointer', fontFamily: t.fontUI, fontWeight: 600,
            background: (busy || triggering) ? `${t.border}30` : `${t.accent}18`,
            border: `1px solid ${(busy || triggering) ? t.border : t.accent}`,
            color: (busy || triggering) ? t.textDim : t.accent,
            transition: 'all 0.15s',
          }}>
            <span style={{ display: 'inline-block', animation: (busy || triggering) ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            {triggering ? 'Starting…' : busy ? 'Scanning…' : '↻ Run Scan'}
          </button>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {(isLoading || scanning) ? (
          <div style={{ padding: 48, textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI }}>
            <div style={{ fontSize: 28, marginBottom: 10, display: 'inline-block', animation: 'spin 1.2s linear infinite' }}>↻</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim, marginBottom: 4 }}>Scanning intraday data…</div>
            <div style={{ fontSize: 9, color: t.textMuted }}>Available during market hours · 9:15 AM – 3:30 PM IST</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
            {Object.entries(CATEGORY_META).map(([catId, meta]) => {
              const stocks = cats[catId]?.stocks || []
              if (stocks.length === 0) return null
              return (
                <CategoryCard key={catId} catId={catId} meta={meta} stocks={stocks} t={t} onTrade={openTicket} />
              )
            })}

            {!isLoading && !scanning && hitCount === 0 && (
              <div style={{
                gridColumn: '1 / -1', padding: 48, textAlign: 'center',
                color: t.textMuted, fontFamily: t.fontUI,
              }}>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.25 }}>⚡</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim, marginBottom: 4 }}>No intraday setups detected yet.</div>
                <div style={{ fontSize: 9, color: t.textMuted }}>Refreshes every 15 min during market hours.</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{
        padding: '5px 16px', borderTop: `1px solid ${t.border}`,
        fontSize: 9, color: t.textDim, fontFamily: t.fontUI, flexShrink: 0,
      }}>
        5-min & 15-min data via yfinance · Auto-refresh every 15 min · Market hours only
      </div>
    </div>
  )
}
