// src/components/journal/SetupAnalytics.jsx
// Aggregated analytics across all journal entries: setup win rates, P&L curve, psychology.

import { useMemo } from 'react'

// SVG cumulative P&L curve — no external charting dependency
function MonthlyCurve({ entries, t }) {
  const monthly = useMemo(() => {
    const byMonth = {}
    entries.forEach(e => {
      const pnl  = parseFloat(e.pnl) || 0
      const date = e.entry_date || e.date || ''
      if (!date) return
      const key = date.slice(0, 7)
      byMonth[key] = (byMonth[key] || 0) + pnl
    })
    const sorted = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b))
    let cum = 0
    return sorted.map(([month, pnl]) => {
      cum = parseFloat((cum + pnl).toFixed(2))
      return { label: month.slice(5), cum }
    })
  }, [entries])

  if (monthly.length < 2) {
    return (
      <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 10, color: t.textDim, fontFamily: t.fontUI }}>
        Need trades in 2+ months to show curve
      </div>
    )
  }

  const W = 480, H = 130
  const pad = { top: 14, bottom: 28, left: 44, right: 12 }
  const iW = W - pad.left - pad.right
  const iH = H - pad.top - pad.bottom

  const vals = monthly.map(m => m.cum)
  const minV = Math.min(...vals, 0)
  const maxV = Math.max(...vals, 0)
  const range = maxV - minV || 1

  const toX = i => pad.left + (i / (monthly.length - 1)) * iW
  const toY = v => pad.top + (1 - (v - minV) / range) * iH

  const pts = monthly.map((m, i) => `${toX(i).toFixed(1)},${toY(m.cum).toFixed(1)}`).join(' ')
  const lastV = vals[vals.length - 1]
  const lineColor = lastV >= 0 ? t.bull : t.bear
  const zeroY = toY(0)

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible', display: 'block' }}>
      {/* Zero baseline */}
      <line x1={pad.left} y1={zeroY} x2={W - pad.right} y2={zeroY}
        stroke={t.border} strokeWidth="1" strokeDasharray="3 3" />
      {/* Y-axis labels */}
      {[minV, 0, maxV].filter((v, i, a) => a.indexOf(v) === i).map(v => (
        <text key={v} x={pad.left - 4} y={toY(v) + 3}
          textAnchor="end" fontSize="8" fill={t.textDim} fontFamily={t.fontUI}>
          {v >= 0 ? '+' : ''}{v.toFixed(0)}
        </text>
      ))}
      {/* Fill area */}
      <polyline
        points={`${pad.left},${zeroY} ${pts} ${toX(monthly.length - 1).toFixed(1)},${zeroY}`}
        fill={`${lineColor}14`} stroke="none"
      />
      {/* Line */}
      <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" />
      {/* Data points */}
      {monthly.map((m, i) => (
        <circle key={i} cx={toX(i)} cy={toY(m.cum)} r="3" fill={lineColor} />
      ))}
      {/* Month labels */}
      {monthly.map((m, i) => (
        <text key={i} x={toX(i)} y={H - 4}
          textAnchor="middle" fontSize="8" fill={t.textDim} fontFamily={t.fontUI}>
          {m.label}
        </text>
      ))}
      {/* End value label */}
      <text
        x={toX(monthly.length - 1)} y={toY(lastV) - 7}
        textAnchor="middle" fontSize="9" fontWeight="700"
        fill={lineColor} fontFamily={t.fontUI}
      >
        {lastV >= 0 ? '+' : ''}₹{lastV.toFixed(0)}
      </text>
    </svg>
  )
}

export default function SetupAnalytics({ entries, t }) {
  const setups = useMemo(() => {
    const map = {}
    entries.forEach(e => {
      const key = e.setup || 'Untagged'
      if (!map[key]) map[key] = { setup: key, total: 0, wins: 0, losses: 0, pnl: [], rr: [] }
      const s = map[key]
      s.total++
      if (e.outcome === 'WIN')  s.wins++
      if (e.outcome === 'LOSS') s.losses++
      const pnl = parseFloat(e.pnl)
      if (!isNaN(pnl)) s.pnl.push(pnl)
      const rr = parseFloat(e.rr_achieved)
      if (!isNaN(rr) && rr > 0) s.rr.push(rr)
    })
    return Object.values(map).map(s => ({
      ...s,
      win_rate: s.total > 0 ? (s.wins / s.total) * 100 : 0,
      avg_pnl:  s.pnl.length > 0 ? s.pnl.reduce((a, b) => a + b, 0) / s.pnl.length : null,
      avg_rr:   s.rr.length  > 0 ? s.rr.reduce((a, b) => a + b, 0)  / s.rr.length  : null,
      net_pnl:  s.pnl.reduce((a, b) => a + b, 0),
    })).sort((a, b) => b.total - a.total)
  }, [entries])

  const emotions = useMemo(() => {
    const map = {}
    entries.forEach(e => {
      const key = e.emotion || 'None'
      if (!map[key]) map[key] = { emotion: key, total: 0, wins: 0 }
      map[key].total++
      if (e.outcome === 'WIN') map[key].wins++
    })
    return Object.values(map).sort((a, b) => b.total - a.total)
  }, [entries])

  const totalPnl = entries.reduce((s, e) => s + (parseFloat(e.pnl) || 0), 0)
  const wins = entries.filter(e => e.outcome === 'WIN').length
  const wr = entries.length > 0 ? ((wins / entries.length) * 100).toFixed(1) : 0
  const bestSetup = [...setups].sort((a, b) => b.net_pnl - a.net_pnl)[0]

  if (entries.length === 0) {
    return (
      <div style={{ padding: '60px 20px', textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI, fontSize: 12 }}>
        No journal entries yet — log trades to see analytics.
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20, overflowY: 'auto' }}>
      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Trades',    value: entries.length,    color: t.text },
          { label: 'Win Rate',        value: `${wr}%`,          color: parseFloat(wr) >= 50 ? t.bull : t.bear },
          { label: 'Net P&L',         value: `${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toFixed(0)}`, color: totalPnl >= 0 ? t.bull : t.bear },
          { label: 'Best Setup',      value: bestSetup?.setup || '—', color: t.accent },
          { label: 'Setups Tracked',  value: setups.length,    color: t.textMuted },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            padding: '10px 16px', background: t.bgCard,
            border: `1px solid ${t.border}`, borderRadius: t.radiusLg, minWidth: 110,
          }}>
            <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: t.fontUI, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Setup performance */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: t.accent, fontFamily: t.fontUI, letterSpacing: 0.5, marginBottom: 10, textTransform: 'uppercase' }}>
          Setup Performance
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {setups.map(s => (
            <div key={s.setup} style={{
              background: t.bgCard, border: `1px solid ${t.border}`,
              borderRadius: t.radius, padding: '10px 14px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: t.text, fontFamily: t.fontUI, flex: 1 }}>
                  {s.setup}
                </span>
                <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>{s.total} trades</span>
                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: t.fontUI, color: s.win_rate >= 50 ? t.bull : t.bear }}>
                  {s.win_rate.toFixed(0)}% WR
                </span>
              </div>
              {/* Win rate bar */}
              <div style={{ height: 3, background: t.bgActive, borderRadius: 2, overflow: 'hidden', marginBottom: 8 }}>
                <div style={{ height: '100%', width: `${s.win_rate}%`, background: s.win_rate >= 50 ? t.bull : t.bear, borderRadius: 2 }} />
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 9, fontFamily: t.fontUI }}>
                  <span style={{ color: t.bull }}>W: {s.wins}</span>
                  {' / '}
                  <span style={{ color: t.bear }}>L: {s.losses}</span>
                </span>
                {s.avg_pnl != null && (
                  <span style={{ fontSize: 9, fontFamily: t.fontUI, color: s.avg_pnl >= 0 ? t.bull : t.bear }}>
                    Avg P&L: {s.avg_pnl >= 0 ? '+' : ''}₹{s.avg_pnl.toFixed(0)}
                  </span>
                )}
                {s.avg_rr != null && (
                  <span style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI }}>
                    Avg R:R 1:{s.avg_rr.toFixed(2)}
                  </span>
                )}
                <span style={{ fontSize: 9, fontFamily: t.fontUI, color: s.net_pnl >= 0 ? t.bull : t.bear, marginLeft: 'auto' }}>
                  Net: {s.net_pnl >= 0 ? '+' : ''}₹{s.net_pnl.toFixed(0)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Monthly P&L curve */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: t.accent, fontFamily: t.fontUI, letterSpacing: 0.5, marginBottom: 10, textTransform: 'uppercase' }}>
          Cumulative P&L Curve
        </div>
        <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: t.radiusLg, padding: '14px 18px' }}>
          <MonthlyCurve entries={entries} t={t} />
        </div>
      </div>

      {/* Trade psychology */}
      {emotions.filter(e => e.emotion !== 'None').length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: t.accent, fontFamily: t.fontUI, letterSpacing: 0.5, marginBottom: 10, textTransform: 'uppercase' }}>
            Trade Psychology
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
            {emotions.filter(e => e.emotion !== 'None').map(em => {
              const wr = em.total > 0 ? ((em.wins / em.total) * 100).toFixed(0) : 0
              return (
                <div key={em.emotion} style={{
                  background: t.bgCard, border: `1px solid ${t.border}`,
                  borderRadius: t.radius, padding: '9px 12px',
                }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: t.text, fontFamily: t.fontUI, marginBottom: 4 }}>{em.emotion}</div>
                  <div style={{ fontSize: 9, fontFamily: t.fontUI }}>
                    {em.total} trades ·{' '}
                    <span style={{ color: parseFloat(wr) >= 50 ? t.bull : t.bear }}>{wr}% WR</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
