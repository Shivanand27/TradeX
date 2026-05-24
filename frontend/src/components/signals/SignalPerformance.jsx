// src/components/signals/SignalPerformance.jsx
// Signal performance leaderboard — win rate, avg gain/loss, expectancy per symbol.
// Shown as a tab on SignalsPage when there is closed signal history.

import { useQuery } from '@tanstack/react-query'
import { getSignalPerformance } from '../../lib/api'
import { useTheme } from '../../store'

// ── Dev mock — shown when backend returns no data ─────────────────
const DEV_MOCK = {
  summary: {
    total_signals: 47,
    closed: 31,
    wins: 21,
    losses: 10,
    win_rate: 67.7,
    avg_pnl_pct: 1.84,
  },
  leaderboard: [
    { symbol: 'RELIANCE',  market: 'india',  total: 8, closed: 6, wins: 5, losses: 1, win_rate: 83.3, avg_win: 2.41, avg_loss: -1.20, net_pnl_pct: 10.85, expectancy: 1.81 },
    { symbol: 'BTCUSD',    market: 'crypto', total: 9, closed: 7, wins: 5, losses: 2, win_rate: 71.4, avg_win: 3.10, avg_loss: -2.40, net_pnl_pct: 10.70, expectancy: 1.53 },
    { symbol: 'TCS',       market: 'india',  total: 6, closed: 5, wins: 4, losses: 1, win_rate: 80.0, avg_win: 1.95, avg_loss: -1.10, net_pnl_pct: 6.70,  expectancy: 1.34 },
    { symbol: 'ETHUSD',    market: 'crypto', total: 7, closed: 5, wins: 3, losses: 2, win_rate: 60.0, avg_win: 2.80, avg_loss: -1.90, net_pnl_pct: 4.60,  expectancy: 0.92 },
    { symbol: 'HDFCBANK',  market: 'india',  total: 5, closed: 4, wins: 2, losses: 2, win_rate: 50.0, avg_win: 1.60, avg_loss: -1.40, net_pnl_pct: 0.40,  expectancy: 0.10 },
    { symbol: 'INFY',      market: 'india',  total: 4, closed: 4, wins: 2, losses: 2, win_rate: 50.0, avg_win: 1.30, avg_loss: -1.80, net_pnl_pct: -1.00, expectancy: -0.25 },
    { symbol: 'SOLUSD',    market: 'crypto', total: 5, closed: 0, wins: 0, losses: 0, win_rate: null, avg_win: null, avg_loss: null,  net_pnl_pct: 0,     expectancy: null },
    { symbol: 'WIPRO',     market: 'india',  total: 3, closed: 0, wins: 0, losses: 0, win_rate: null, avg_win: null, avg_loss: null,  net_pnl_pct: 0,     expectancy: null },
  ],
}

// ── Win rate bar ──────────────────────────────────────────────────
function WinBar({ rate, t }) {
  if (rate == null) return <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>—</span>
  const color = rate >= 60 ? t.bull : rate >= 45 ? t.amber : t.bear
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 4, background: `${color}18`, borderRadius: 2, overflow: 'hidden', minWidth: 48 }}>
        <div style={{ width: `${rate}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.5s ease' }} />
      </div>
      <span style={{ fontSize: 10, fontWeight: 700, color, fontFamily: t.fontUI, minWidth: 36, textAlign: 'right' }}>
        {rate.toFixed(1)}%
      </span>
    </div>
  )
}

// ── Pct cell ──────────────────────────────────────────────────────
function PctCell({ value, t, fallback = '—' }) {
  if (value == null) return <span style={{ color: t.textDim, fontSize: 9, fontFamily: t.fontUI }}>{fallback}</span>
  const pos = value >= 0
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: pos ? t.bull : t.bear, fontFamily: t.fontUI }}>
      {pos ? '+' : ''}{value.toFixed(2)}%
    </span>
  )
}

// ── Summary card ─────────────────────────────────────────────────
function SummaryCard({ label, value, color, sub, t }) {
  return (
    <div style={{
      flex: 1, minWidth: 0, padding: '10px 14px',
      background: `${color}08`, border: `1px solid ${color}22`, borderRadius: 8,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg, transparent, ${color}50, transparent)` }} />
      <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, fontFamily: t.fontUI, letterSpacing: -0.5 }}>{value}</div>
      {sub && <div style={{ fontSize: 8, color: t.textMuted, fontFamily: t.fontUI, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ── Market badge ─────────────────────────────────────────────────
function MktBadge({ market, t }) {
  const isIndia  = market?.includes('india')
  const isCrypto = market?.includes('crypto')
  const color = isIndia ? t.accent : isCrypto ? t.cyan : t.amber
  const label = isIndia ? 'NSE' : isCrypto ? 'CRYPTO' : (market || '').toUpperCase()
  return (
    <span style={{
      fontSize: 7, padding: '1px 5px', borderRadius: 2, fontWeight: 700,
      background: `${color}15`, color, border: `1px solid ${color}30`,
      fontFamily: t.fontUI, letterSpacing: 0.4,
    }}>{label}</span>
  )
}

// ── Main component ────────────────────────────────────────────────
export default function SignalPerformance() {
  const t = useTheme()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['signalPerformance'],
    queryFn: getSignalPerformance,
    refetchInterval: 120_000,
    staleTime: 60_000,
  })

  const perf = (data?.leaderboard?.length > 0 ? data : null)
             ?? (import.meta.env.DEV ? DEV_MOCK : null)

  const COLS = [
    { label: 'SYMBOL',      w: '110px' },
    { label: 'MARKET',      w: '70px'  },
    { label: 'SIGNALS',     w: '62px',  align: 'right' },
    { label: 'CLOSED',      w: '62px',  align: 'right' },
    { label: 'W',           w: '44px',  align: 'right' },
    { label: 'L',           w: '44px',  align: 'right' },
    { label: 'WIN RATE',    w: '130px'  },
    { label: 'AVG WIN',     w: '72px',  align: 'right' },
    { label: 'AVG LOSS',    w: '72px',  align: 'right' },
    { label: 'NET P&L',     w: '72px',  align: 'right' },
    { label: 'EXPECTANCY',  w: '80px',  align: 'right' },
  ]

  const gridCols = COLS.map(c => c.w).join(' ')

  if (isLoading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: t.textDim, fontSize: 11, fontFamily: t.fontUI }}>
      Loading performance data…
    </div>
  )

  if (isError && !perf) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: t.bear, fontSize: 11, fontFamily: t.fontUI }}>
      Failed to load performance data.
    </div>
  )

  if (!perf) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 10 }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3 }}>
        <line x1="18" y1="20" x2="18" y2="10" stroke={t.textDim} strokeWidth="2" strokeLinecap="round"/>
        <line x1="12" y1="20" x2="12" y2="4"  stroke={t.textDim} strokeWidth="2" strokeLinecap="round"/>
        <line x1="6"  y1="20" x2="6"  y2="16" stroke={t.textDim} strokeWidth="2" strokeLinecap="round"/>
      </svg>
      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontUI }}>No closed signals yet</span>
      <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, maxWidth: 280, textAlign: 'center', lineHeight: 1.6 }}>
        Performance data appears after signal outcomes (WIN / LOSS) are recorded by the Risk Guardian agent.
      </span>
    </div>
  )

  const s = perf.summary
  const rows = perf.leaderboard || []

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>

      {/* Summary strip */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <SummaryCard label="Total Signals" value={s.total_signals}                         color={t.accent} t={t} sub={`${s.closed} closed`}/>
        <SummaryCard label="Win Rate"      value={s.win_rate != null ? `${s.win_rate}%` : '—'}  color={s.win_rate >= 60 ? t.bull : s.win_rate >= 45 ? t.amber : t.bear} t={t} sub={`${s.wins}W / ${s.losses}L`}/>
        <SummaryCard label="Avg P&L"       value={s.avg_pnl_pct != null ? `${s.avg_pnl_pct >= 0 ? '+' : ''}${s.avg_pnl_pct}%` : '—'} color={s.avg_pnl_pct >= 0 ? t.bull : t.bear} t={t} sub="per closed signal"/>
        <SummaryCard label="Closed"        value={s.closed}    color={t.textMuted}          t={t} sub="with outcome"/>
      </div>

      {/* Leaderboard table */}
      <div style={{
        border: `1px solid ${t.border}`, borderRadius: 8, overflow: 'hidden',
        background: t.bgCard,
      }}>
        {/* Header */}
        <div style={{
          display: 'grid', gridTemplateColumns: gridCols,
          padding: '6px 12px', borderBottom: `1px solid ${t.border}`,
          background: t.headerGrad,
        }}>
          {COLS.map(c => (
            <span key={c.label} style={{
              fontSize: 8, fontWeight: 700, color: t.textMuted, fontFamily: t.fontUI,
              letterSpacing: 0.5, textAlign: c.align || 'left',
            }}>{c.label}</span>
          ))}
        </div>

        {/* Rows */}
        {rows.map((r, i) => {
          const hasData    = r.closed > 0
          const wr         = r.win_rate
          const wrColor    = wr == null ? t.textDim : wr >= 60 ? t.bull : wr >= 45 ? t.amber : t.bear
          const netColor   = r.net_pnl_pct >= 0 ? t.bull : t.bear
          const expColor   = r.expectancy == null ? t.textDim : r.expectancy >= 0.5 ? t.bull : r.expectancy >= 0 ? t.amber : t.bear

          return (
            <div
              key={r.symbol}
              style={{
                display: 'grid', gridTemplateColumns: gridCols,
                padding: '8px 12px', alignItems: 'center',
                borderBottom: i < rows.length - 1 ? `1px solid ${t.border}` : 'none',
                background: i % 2 === 0 ? 'transparent' : `${t.border}08`,
                transition: 'background 0.12s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = t.bgActive}
              onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : `${t.border}08`}
            >
              {/* Symbol */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {i < 3 && hasData && (
                  <span style={{ fontSize: 8, color: [t.gold || '#F59E0B', t.textMuted, t.textDim][i], fontFamily: t.fontUI, fontWeight: 700 }}>
                    #{i + 1}
                  </span>
                )}
                <span style={{ fontSize: 11, fontWeight: 700, color: t.cyan, fontFamily: t.fontUI }}>{r.symbol}</span>
              </div>

              {/* Market */}
              <div><MktBadge market={r.market} t={t} /></div>

              {/* Total signals */}
              <span style={{ fontSize: 10, color: t.text, fontFamily: t.fontUI, textAlign: 'right' }}>{r.total}</span>

              {/* Closed */}
              <span style={{ fontSize: 10, color: hasData ? t.text : t.textDim, fontFamily: t.fontUI, textAlign: 'right' }}>{r.closed}</span>

              {/* Wins */}
              <span style={{ fontSize: 10, fontWeight: hasData ? 600 : 400, color: hasData ? t.bull : t.textDim, fontFamily: t.fontUI, textAlign: 'right' }}>
                {hasData ? r.wins : '—'}
              </span>

              {/* Losses */}
              <span style={{ fontSize: 10, fontWeight: hasData ? 600 : 400, color: hasData ? t.bear : t.textDim, fontFamily: t.fontUI, textAlign: 'right' }}>
                {hasData ? r.losses : '—'}
              </span>

              {/* Win rate bar */}
              <WinBar rate={r.win_rate} t={t} />

              {/* Avg win */}
              <div style={{ textAlign: 'right' }}><PctCell value={r.avg_win} t={t} /></div>

              {/* Avg loss */}
              <div style={{ textAlign: 'right' }}><PctCell value={r.avg_loss} t={t} /></div>

              {/* Net P&L */}
              <div style={{ textAlign: 'right' }}>
                {hasData
                  ? <span style={{ fontSize: 10, fontWeight: 700, color: netColor, fontFamily: t.fontUI }}>
                      {r.net_pnl_pct >= 0 ? '+' : ''}{r.net_pnl_pct.toFixed(2)}%
                    </span>
                  : <span style={{ color: t.textDim, fontSize: 9, fontFamily: t.fontUI }}>—</span>
                }
              </div>

              {/* Expectancy */}
              <div style={{ textAlign: 'right' }}>
                {r.expectancy != null
                  ? <span style={{ fontSize: 10, fontWeight: 600, color: expColor, fontFamily: t.fontUI }}>
                      {r.expectancy >= 0 ? '+' : ''}{r.expectancy.toFixed(2)}%
                    </span>
                  : <span style={{ color: t.textDim, fontSize: 9, fontFamily: t.fontUI }}>—</span>
                }
              </div>
            </div>
          )
        })}

        {rows.length === 0 && (
          <div style={{ padding: '32px', textAlign: 'center', color: t.textDim, fontSize: 10, fontFamily: t.fontUI }}>
            No signal history found
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 20, marginTop: 12, padding: '0 4px' }}>
        {[
          { color: t.bull,  label: 'Win rate ≥ 60%' },
          { color: t.amber, label: 'Win rate 45–60%' },
          { color: t.bear,  label: 'Win rate < 45%' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
            <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI }}>{label}</span>
          </div>
        ))}
        <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginLeft: 'auto' }}>
          Expectancy = (win rate × avg win) + (loss rate × avg loss)
        </span>
      </div>
    </div>
  )
}
