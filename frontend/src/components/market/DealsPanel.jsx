// src/components/market/DealsPanel.jsx
// Block & Bulk Deals panel — NSE institutional deals with watchlist highlights.

import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { getDeals, getDealsWatchlist, triggerDealsRefresh } from '../../lib/api'
import { useTheme } from '../../store'

const DEAL_TYPES = [
  { id: 'all',   label: 'All Deals' },
  { id: 'block', label: 'Block' },
  { id: 'bulk',  label: 'Bulk' },
]

// ── Symbol avatar ──────────────────────────────────────────────────
function SymAvatar({ symbol, color, t }) {
  const abbr = symbol.replace(/[^A-Z]/g, '').slice(0, 2) || symbol.slice(0, 2)
  return (
    <div style={{
      width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
      background: `${color}18`, border: `1.5px solid ${color}40`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <span style={{ fontSize: 9, fontWeight: 800, color, letterSpacing: -0.5 }}>{abbr}</span>
    </div>
  )
}

// ── Table header cell ──────────────────────────────────────────────
function TH({ children, right }) {
  return (
    <th style={{
      padding: '7px 10px', textAlign: right ? 'right' : 'left',
      fontSize: 9, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  )
}

export default function DealsPanel() {
  const t = useTheme()
  const [dealType,  setDealType]  = useState('all')
  const [watchOnly, setWatchOnly] = useState(false)
  const [tab,       setTab]       = useState('today')

  const todayQ = useQuery({
    queryKey: ['deals', dealType, watchOnly],
    queryFn:  () => getDeals({ deal_type: dealType, watchlist_only: watchOnly }),
    refetchInterval: 300_000,
    enabled:  tab === 'today',
  })
  const watchQ = useQuery({
    queryKey: ['deals-watchlist'],
    queryFn:  () => getDealsWatchlist(5),
    refetchInterval: 300_000,
    enabled:  tab === 'watchlist',
  })

  const { mutate: triggerFetch, isPending: triggering } = useMutation({
    mutationFn: triggerDealsRefresh,
    onSuccess:  () => setTimeout(() => { todayQ.refetch(); watchQ.refetch() }, 3000),
  })

  const deals   = tab === 'today' ? (todayQ.data?.deals || []) : (watchQ.data?.deals || [])
  const loading = tab === 'today' ? todayQ.isLoading : watchQ.isLoading

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: t.bg }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Header strip ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 16px', borderBottom: `1px solid ${t.border}`,
        background: t.headerGrad, flexShrink: 0,
      }}>
        {/* Icon + title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 30, height: 30, borderRadius: t.radius,
            background: `${t.accent}18`, border: `1px solid ${t.accent}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <span style={{ fontSize: 14 }}>🏦</span>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: t.text, fontFamily: t.fontUI, letterSpacing: 0.2 }}>
              BLOCK & BULK DEALS
            </div>
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>NSE · 8:45–9:00 AM & 2:05–2:20 PM · Min ₹25 Cr</div>
          </div>
        </div>

        {deals.length > 0 && (
          <>
            <div style={{ width: 1, height: 16, background: t.border }} />
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: t.radius,
              background: `${t.accent}10`, border: `1px solid ${t.accent}25`,
            }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: t.accent }} />
              <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>Deals</span>
              <span style={{ fontSize: 14, fontWeight: 800, color: t.accent, fontFamily: t.fontUI }}>{deals.length}</span>
            </div>
          </>
        )}

        {/* Tab switcher + refresh — right side */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          {[{ id: 'today', label: 'Today' }, { id: 'watchlist', label: 'Watchlist (5d)' }].map(({ id, label }) => (
            <button key={id} onClick={() => setTab(id)} style={{
              padding: '5px 12px', borderRadius: t.radius, fontSize: 10, cursor: 'pointer',
              fontFamily: t.fontUI, fontWeight: tab === id ? 600 : 400,
              background: tab === id ? `${t.accent}18` : 'transparent',
              border: `1px solid ${tab === id ? t.accent : t.border}`,
              color: tab === id ? t.accent : t.textMuted,
              transition: 'all 0.12s',
            }}>
              {label}
            </button>
          ))}
          <div style={{ width: 1, height: 14, background: t.border }} />
          <button
            onClick={() => triggerFetch()}
            disabled={triggering || loading}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 11px', borderRadius: t.radius, fontSize: 10,
              cursor: (triggering || loading) ? 'default' : 'pointer',
              fontFamily: t.fontUI, fontWeight: 600,
              background: (triggering || loading) ? `${t.border}30` : `${t.accent}18`,
              border: `1px solid ${(triggering || loading) ? t.border : t.accent}`,
              color: (triggering || loading) ? t.textDim : t.accent,
              transition: 'all 0.15s',
            }}
          >
            <span style={{ display: 'inline-block', animation: (triggering || loading) ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            {triggering ? 'Fetching…' : '↻ Fetch'}
          </button>
        </div>
      </div>

      {/* ── Filters (Today tab only) ── */}
      {tab === 'today' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          padding: '7px 16px', borderBottom: `1px solid ${t.border}`, flexShrink: 0,
        }}>
          {DEAL_TYPES.map(dt => (
            <button key={dt.id} onClick={() => setDealType(dt.id)} style={{
              padding: '3px 10px', borderRadius: t.radiusSm, fontSize: 10, cursor: 'pointer',
              fontFamily: t.fontUI,
              border: `1px solid ${dealType === dt.id ? t.accent : t.border}`,
              background: dealType === dt.id ? `${t.accent}18` : 'transparent',
              color: dealType === dt.id ? t.accent : t.textMuted,
              fontWeight: dealType === dt.id ? 600 : 400,
            }}>
              {dt.label}
            </button>
          ))}
          <div style={{ width: 1, height: 14, background: t.border }} />
          <label style={{
            display: 'flex', alignItems: 'center', gap: 5,
            fontSize: 10, color: t.textMuted, cursor: 'pointer', fontFamily: t.fontUI,
          }}>
            <input type="checkbox" checked={watchOnly}
              onChange={e => setWatchOnly(e.target.checked)}
              style={{ accentColor: t.accent }}
            />
            Watchlist only
          </label>
        </div>
      )}

      {/* ── Table ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI, fontSize: 12 }}>
            <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.4 }}>🏦</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim }}>Loading deals…</div>
          </div>
        ) : deals.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI }}>
            <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.3 }}>🏦</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim, marginBottom: 4 }}>No deals found.</div>
            <div style={{ fontSize: 9, color: t.textMuted }}>Block windows: 8:45–9:00 AM and 2:05–2:20 PM IST</div>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{
                borderBottom: `1px solid ${t.border}`,
                position: 'sticky', top: 0,
                background: t.bg, color: t.textMuted,
              }}>
                <TH>Symbol</TH>
                <TH>Client</TH>
                <TH>Direction</TH>
                <TH right>Qty</TH>
                <TH right>Price</TH>
                <TH right>Value</TH>
                <TH>Type</TH>
                <TH>Date</TH>
              </tr>
            </thead>
            <tbody>
              {deals.map((d, i) => {
                const isBuy  = d.direction === 'BUY'
                const isSell = d.direction === 'SELL'
                const isWL   = d.on_watchlist
                const dirColor = isBuy ? t.bull : isSell ? t.bear : t.textMuted
                const typeColor = d.deal_type === 'block' ? t.purple : t.cyan

                return (
                  <DealRow key={i} d={d} isBuy={isBuy} isWL={isWL}
                    dirColor={dirColor} typeColor={typeColor} t={t} />
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{
        padding: '5px 16px', borderTop: `1px solid ${t.border}`,
        fontSize: 9, color: t.textDim, fontFamily: t.fontUI, flexShrink: 0,
      }}>
        Block deal windows: 8:45–9:00 AM & 2:05–2:20 PM IST · Min size ₹25 Cr · Source: NSE
      </div>
    </div>
  )
}

function DealRow({ d, isBuy, isWL, dirColor, typeColor, t }) {
  const [hov, setHov] = useState(false)
  return (
    <tr
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        borderBottom: `1px solid ${t.border}`,
        background: hov
          ? `${dirColor}08`
          : isWL
          ? `${dirColor}05`
          : 'transparent',
        transition: 'background 0.12s',
      }}
    >
      {/* Symbol */}
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SymAvatar symbol={d.symbol} color={dirColor} t={t} />
          <div>
            <div style={{ fontSize: 12, fontWeight: isWL ? 700 : 600, color: t.text, fontFamily: t.fontUI }}>
              {d.symbol}
              {isWL && <span style={{ marginLeft: 5, fontSize: 10, color: t.amber }}>★</span>}
            </div>
          </div>
        </div>
      </td>
      {/* Client */}
      <td style={{
        padding: '8px 10px', fontSize: 11, color: t.textMuted, fontFamily: t.fontUI,
        maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {d.client_name}
      </td>
      {/* Direction */}
      <td style={{ padding: '8px 10px' }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: t.radiusSm,
          background: `${dirColor}20`, color: dirColor, border: `1px solid ${dirColor}40`,
          fontFamily: t.fontUI,
        }}>
          {d.direction}
        </span>
      </td>
      {/* Qty */}
      <td style={{ padding: '8px 10px', fontSize: 11, color: t.textMuted, fontFamily: t.fontUI, textAlign: 'right' }}>
        {Number(d.quantity || 0).toLocaleString('en-IN')}
      </td>
      {/* Price */}
      <td style={{ padding: '8px 10px', fontSize: 12, fontWeight: 600, color: t.text, fontFamily: t.fontUI, textAlign: 'right', whiteSpace: 'nowrap' }}>
        ₹{Number(d.price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </td>
      {/* Value */}
      <td style={{ padding: '8px 10px', fontSize: 12, fontWeight: 700, color: t.text, fontFamily: t.fontUI, textAlign: 'right', whiteSpace: 'nowrap' }}>
        ₹{Number(d.value_crore || 0).toFixed(2)} Cr
      </td>
      {/* Type badge */}
      <td style={{ padding: '8px 10px' }}>
        <span style={{
          fontSize: 9, padding: '2px 7px', borderRadius: t.radiusSm,
          background: `${typeColor}20`, color: typeColor, border: `1px solid ${typeColor}40`,
          fontWeight: 600, textTransform: 'uppercase', fontFamily: t.fontUI,
        }}>
          {d.deal_type}
        </span>
      </td>
      {/* Date */}
      <td style={{ padding: '8px 10px', fontSize: 10, color: t.textDim, fontFamily: t.fontUI, whiteSpace: 'nowrap' }}>
        {d.trade_date}
      </td>
    </tr>
  )
}
