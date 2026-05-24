// src/components/market/InsiderPanel.jsx
// SEBI PIT insider trading disclosures + cluster-buy alerts

import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { getInsiderTrades, getInsiderClusters, triggerInsiderRefresh } from '../../lib/api'
import { useTheme } from '../../store'

const ROLES = [
  { id: 'all',      label: 'All Roles' },
  { id: 'promoter', label: 'Promoter' },
  { id: 'director', label: 'Director' },
  { id: 'kmp',      label: 'KMP' },
]

function roleColor(t, role) {
  return { promoter: t.amber, director: t.accent, kmp: t.purple, employee: t.bull }[role] || t.textMuted
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

// ── Cluster card ───────────────────────────────────────────────────
function ClusterCard({ cl, t }) {
  const [hov, setHov] = useState(false)
  const color = t.amber
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        borderRadius: t.radiusLg, border: `1px solid ${color}30`,
        background: hov ? `${color}05` : t.bgCard,
        boxShadow: t.shadowCard, transition: 'background 0.12s',
      }}
    >
      {/* Card header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        background: `linear-gradient(90deg, ${color}14 0%, transparent 100%)`,
        borderBottom: `1px solid ${color}25`,
      }}>
        <SymAvatar symbol={cl.symbol} color={color} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: t.text, fontFamily: t.fontUI }}>{cl.symbol}</span>
            {cl.on_watchlist && <span style={{ fontSize: 10, color: t.amber }}>★</span>}
          </div>
          <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cl.company_name}
          </div>
        </div>
        {/* Cluster badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '3px 10px', borderRadius: 20, flexShrink: 0,
          background: `${color}20`, border: `1px solid ${color}40`,
        }}>
          <span style={{ fontSize: 11 }}>🔥</span>
          <span style={{ fontSize: 10, fontWeight: 700, color, fontFamily: t.fontUI }}>
            {cl.insider_count} insiders
          </span>
        </div>
      </div>

      {/* Card body */}
      <div style={{ padding: '10px 14px' }}>
        {/* Metrics row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
          {[
            { label: 'Total Value', val: `₹${Number(cl.total_value_lakh || 0).toFixed(1)}L` },
            { label: 'Trades',      val: cl.trade_count },
            { label: 'Window',      val: `${cl.window_start} → ${cl.window_end}` },
          ].map(({ label, val }) => (
            <div key={label} style={{
              background: t.bgActive, borderRadius: t.radius,
              padding: '6px 8px', border: `1px solid ${t.border}`,
            }}>
              <div style={{ fontSize: 7, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 3 }}>
                {label}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: t.text, fontFamily: t.fontUI, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {val}
              </div>
            </div>
          ))}
        </div>

        {/* Insider name chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {(cl.insiders || []).map((name, ni) => (
            <span key={ni} style={{
              fontSize: 9, padding: '2px 7px', borderRadius: t.radiusSm,
              background: `${color}14`, color, border: `1px solid ${color}30`,
              fontFamily: t.fontUI,
            }}>
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function InsiderPanel() {
  const t = useTheme()
  const [tab,       setTab]       = useState('clusters')
  const [tradeType, setTradeType] = useState('BUY')
  const [role,      setRole]      = useState('all')
  const [days,      setDays]      = useState(30)
  const [watchOnly, setWatchOnly] = useState(false)

  const clustersQ = useQuery({
    queryKey: ['insiderClusters', days],
    queryFn:  () => getInsiderClusters(days),
    refetchInterval: 600_000,
    enabled:  tab === 'clusters',
  })
  const tradesQ = useQuery({
    queryKey: ['insiderTrades', tradeType, role, days, watchOnly],
    queryFn:  () => getInsiderTrades({
      trade_type:     tradeType,
      role:           role !== 'all' ? role : undefined,
      days,
      watchlist_only: watchOnly,
    }),
    refetchInterval: 600_000,
    enabled:  tab === 'trades',
  })

  const { mutate: triggerFetch, isPending: triggering } = useMutation({
    mutationFn: triggerInsiderRefresh,
    onSuccess:  () => setTimeout(() => { clustersQ.refetch(); tradesQ.refetch() }, 4000),
  })

  const clusters = clustersQ.data?.clusters || []
  const trades   = tradesQ.data?.trades     || []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: t.bg }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Header strip ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 16px', borderBottom: `1px solid ${t.border}`,
        background: t.headerGrad, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 30, height: 30, borderRadius: t.radius,
            background: `${t.amber}18`, border: `1px solid ${t.amber}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <span style={{ fontSize: 14 }}>👥</span>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: t.text, fontFamily: t.fontUI, letterSpacing: 0.2 }}>
              INSIDER TRADING
            </div>
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>SEBI PIT Disclosures · NSE</div>
          </div>
        </div>

        {clusters.length > 0 && (
          <>
            <div style={{ width: 1, height: 16, background: t.border }} />
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: t.radius,
              background: `${t.amber}10`, border: `1px solid ${t.amber}25`,
            }}>
              <span style={{ fontSize: 11 }}>🔥</span>
              <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>Clusters</span>
              <span style={{ fontSize: 14, fontWeight: 800, color: t.amber, fontFamily: t.fontUI }}>{clusters.length}</span>
            </div>
          </>
        )}

        {/* Days selector + refresh */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <select value={days} onChange={e => setDays(Number(e.target.value))} style={{
            background: t.bgCard, color: t.text, border: `1px solid ${t.border}`,
            borderRadius: t.radiusSm, padding: '4px 8px', fontSize: 10,
            cursor: 'pointer', fontFamily: t.fontUI,
          }}>
            {[7, 14, 30, 60].map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
          <button
            onClick={() => triggerFetch()}
            disabled={triggering}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 11px', borderRadius: t.radius, fontSize: 10,
              cursor: triggering ? 'default' : 'pointer',
              fontFamily: t.fontUI, fontWeight: 600,
              background: triggering ? `${t.border}30` : `${t.amber}18`,
              border: `1px solid ${triggering ? t.border : t.amber + '60'}`,
              color: triggering ? t.textDim : t.amber,
              transition: 'all 0.15s',
            }}
          >
            <span style={{ display: 'inline-block', animation: triggering ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            {triggering ? 'Fetching…' : '↻ Fetch'}
          </button>
        </div>
      </div>

      {/* ── Sub-tabs + trade filters ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap',
        padding: '7px 16px', borderBottom: `1px solid ${t.border}`, flexShrink: 0,
      }}>
        {/* Main tabs */}
        {[
          { id: 'clusters', label: '🔥 Cluster Buys' },
          { id: 'trades',   label: '📋 All Trades' },
        ].map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '4px 12px', borderRadius: t.radius, fontSize: 10, cursor: 'pointer',
            fontFamily: t.fontUI, fontWeight: tab === id ? 600 : 400,
            border: `1px solid ${tab === id ? t.accent : t.border}`,
            background: tab === id ? `${t.accent}18` : 'transparent',
            color: tab === id ? t.accent : t.textMuted,
            transition: 'all 0.12s',
          }}>
            {label}
          </button>
        ))}

        {/* Trade-specific filters */}
        {tab === 'trades' && (
          <>
            <div style={{ width: 1, height: 14, background: t.border, margin: '0 2px' }} />

            {/* BUY / SELL toggle */}
            {[
              { id: 'BUY',  label: '▲ Buy',  color: t.bull },
              { id: 'SELL', label: '▼ Sell', color: t.bear },
            ].map(({ id, label, color }) => (
              <button key={id} onClick={() => setTradeType(id)} style={{
                padding: '3px 10px', borderRadius: t.radiusSm, fontSize: 10, cursor: 'pointer',
                fontFamily: t.fontUI, fontWeight: tradeType === id ? 700 : 400,
                border: `1px solid ${tradeType === id ? color : t.border}`,
                background: tradeType === id ? `${color}18` : 'transparent',
                color: tradeType === id ? color : t.textMuted,
              }}>
                {label}
              </button>
            ))}

            <div style={{ width: 1, height: 14, background: t.border, margin: '0 2px' }} />

            {/* Role filter */}
            {ROLES.map(r => (
              <button key={r.id} onClick={() => setRole(r.id)} style={{
                padding: '3px 9px', borderRadius: t.radiusSm, fontSize: 10, cursor: 'pointer',
                fontFamily: t.fontUI, fontWeight: role === r.id ? 600 : 400,
                border: `1px solid ${role === r.id ? t.accent : t.border}`,
                background: role === r.id ? `${t.accent}18` : 'transparent',
                color: role === r.id ? t.accent : t.textMuted,
              }}>
                {r.label}
              </button>
            ))}

            <div style={{ width: 1, height: 14, background: t.border, margin: '0 2px' }} />

            <label style={{
              display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 10, color: t.textMuted, cursor: 'pointer', fontFamily: t.fontUI,
            }}>
              <input type="checkbox" checked={watchOnly}
                onChange={e => setWatchOnly(e.target.checked)}
                style={{ accentColor: t.accent }}
              />
              Watchlist
            </label>
          </>
        )}
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ── Clusters tab ── */}
        {tab === 'clusters' && (
          clustersQ.isLoading ? (
            <div style={{ padding: 48, textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI }}>
              <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.4 }}>👥</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim }}>Loading clusters…</div>
            </div>
          ) : clusters.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI }}>
              <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.3 }}>🔥</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim, marginBottom: 4 }}>
                No cluster-buy signals in the last {days} days.
              </div>
              <div style={{ fontSize: 9, color: t.textMuted }}>
                Trigger: ≥3 distinct insiders buying the same stock within 5 days
              </div>
            </div>
          ) : (
            <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
              {clusters.map((cl, i) => <ClusterCard key={i} cl={cl} t={t} />)}
            </div>
          )
        )}

        {/* ── Trades tab ── */}
        {tab === 'trades' && (
          tradesQ.isLoading ? (
            <div style={{ padding: 48, textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI }}>
              <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.4 }}>📋</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim }}>Loading trades…</div>
            </div>
          ) : trades.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI }}>
              <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.3 }}>📋</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim }}>No insider trades found for selected filters.</div>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{
                  borderBottom: `1px solid ${t.border}`,
                  position: 'sticky', top: 0, background: t.bg,
                  color: t.textMuted,
                }}>
                  {['Symbol', 'Insider', 'Role', 'Type', 'Qty', 'Value', 'Date'].map(h => (
                    <th key={h} style={{
                      padding: '7px 10px', textAlign: 'left',
                      fontSize: 9, fontWeight: 600, letterSpacing: 0.5,
                      textTransform: 'uppercase', fontFamily: t.fontUI,
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map((tr, i) => <TradeRow key={i} tr={tr} t={t} />)}
              </tbody>
            </table>
          )
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{
        padding: '5px 16px', borderTop: `1px solid ${t.border}`,
        fontSize: 9, color: t.textDim, fontFamily: t.fontUI, flexShrink: 0,
      }}>
        Source: SEBI PIT Disclosures via NSE · Updated daily at 7:00 PM IST
      </div>
    </div>
  )
}

function TradeRow({ tr, t }) {
  const [hov, setHov] = useState(false)
  const isBuy   = tr.trade_type === 'BUY'
  const dirColor = isBuy ? t.bull : t.bear
  const rc       = roleColor(t, tr.insider_role)

  return (
    <tr
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        borderBottom: `1px solid ${t.border}`,
        background: hov
          ? `${dirColor}08`
          : tr.on_watchlist
          ? t.bgCard
          : 'transparent',
        transition: 'background 0.12s',
      }}
    >
      {/* Symbol */}
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SymAvatar symbol={tr.symbol} color={dirColor} />
          <span style={{ fontSize: 12, fontWeight: tr.on_watchlist ? 700 : 600, color: t.text, fontFamily: t.fontUI }}>
            {tr.symbol}
            {tr.on_watchlist && <span style={{ marginLeft: 4, fontSize: 10, color: t.amber }}>★</span>}
          </span>
        </div>
      </td>
      {/* Insider name */}
      <td style={{
        padding: '8px 10px', fontSize: 11, color: t.textMuted, fontFamily: t.fontUI,
        maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {tr.insider_name}
      </td>
      {/* Role badge */}
      <td style={{ padding: '8px 10px' }}>
        <span style={{
          fontSize: 9, padding: '2px 7px', borderRadius: t.radiusSm,
          background: `${rc}20`, color: rc, border: `1px solid ${rc}40`,
          fontWeight: 600, textTransform: 'uppercase', fontFamily: t.fontUI, letterSpacing: 0.2,
        }}>
          {tr.insider_role}
        </span>
      </td>
      {/* Trade type */}
      <td style={{ padding: '8px 10px' }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: t.radiusSm,
          background: `${dirColor}20`, color: dirColor, border: `1px solid ${dirColor}40`,
          fontFamily: t.fontUI,
        }}>
          {tr.trade_type}
        </span>
      </td>
      {/* Qty */}
      <td style={{ padding: '8px 10px', fontSize: 11, color: t.textMuted, fontFamily: t.fontUI }}>
        {Number(tr.quantity || 0).toLocaleString('en-IN')}
      </td>
      {/* Value */}
      <td style={{ padding: '8px 10px', fontSize: 12, fontWeight: 700, color: t.text, fontFamily: t.fontUI, whiteSpace: 'nowrap' }}>
        ₹{Number(tr.value_lakh || 0).toFixed(1)}L
      </td>
      {/* Date */}
      <td style={{ padding: '8px 10px', fontSize: 10, color: t.textDim, fontFamily: t.fontUI, whiteSpace: 'nowrap' }}>
        {tr.trade_date}
      </td>
    </tr>
  )
}
