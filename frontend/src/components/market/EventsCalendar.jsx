// src/components/market/EventsCalendar.jsx
// Corporate Events Calendar — results, dividends, splits, AGMs, bonus

import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { getEvents, triggerEventsRefresh } from '../../lib/api'
import { useTheme } from '../../store'

const EVENT_TYPES = [
  { id: 'all',           label: 'All',       colorKey: 'textMuted' },
  { id: 'results',       label: 'Results',   colorKey: 'accent' },
  { id: 'dividend',      label: 'Dividend',  colorKey: 'bull' },
  { id: 'board_meeting', label: 'Board Mtg', colorKey: 'amber' },
  { id: 'bonus',         label: 'Bonus',     colorKey: 'purple' },
  { id: 'split',         label: 'Split',     colorKey: 'cyan' },
  { id: 'agm',           label: 'AGM',       colorKey: 'bear' },
]

const EVENT_EMOJI = {
  results:       '📊',
  dividend:      '💰',
  board_meeting: '🏛',
  bonus:         '🎁',
  split:         '✂',
  rights:        '📜',
  agm:           '🏢',
  egm:           '🏢',
  other:         '📅',
}

function resolveColor(t, key) {
  const map = {
    accent: t.accent, bull: t.bull, bear: t.bear,
    amber: t.amber, purple: t.purple, cyan: t.cyan, textMuted: t.textMuted,
  }
  return map[key] || t.textMuted
}

// ── Event type badge ───────────────────────────────────────────────
function EventBadge({ type, t }) {
  const cfg = EVENT_TYPES.find(e => e.id === type) || { label: type, colorKey: 'textMuted' }
  const color = resolveColor(t, cfg.colorKey)
  return (
    <span style={{
      fontSize: 9, padding: '2px 8px', borderRadius: t.radiusSm,
      background: `${color}20`, color, border: `1px solid ${color}40`,
      fontWeight: 600, whiteSpace: 'nowrap', fontFamily: t.fontUI,
      textTransform: 'uppercase', letterSpacing: 0.3,
    }}>
      {EVENT_EMOJI[type] || '📅'} {cfg.label || type}
    </span>
  )
}

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

export default function EventsCalendar() {
  const t = useTheme()
  const [typeFilter, setTypeFilter] = useState('all')
  const [watchOnly,  setWatchOnly]  = useState(false)
  const [lookahead,  setLookahead]  = useState(14)

  const today  = new Date().toISOString().split('T')[0]
  const toDate = new Date(Date.now() + lookahead * 86400_000).toISOString().split('T')[0]

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['events', typeFilter, watchOnly, lookahead],
    queryFn: () => getEvents({
      from_date:      today,
      to_date:        toDate,
      event_type:     typeFilter !== 'all' ? typeFilter : undefined,
      watchlist_only: watchOnly,
    }),
    refetchInterval: 300_000,
  })

  const { mutate: triggerFetch, isPending: triggering } = useMutation({
    mutationFn: triggerEventsRefresh,
    onSuccess:  () => setTimeout(() => refetch(), 3000),
  })

  const events      = data?.events       || []
  const todayEvents = data?.today_events || []

  // Group by date
  const grouped = {}
  for (const ev of events) {
    const d = ev.event_date || 'unknown'
    if (!grouped[d]) grouped[d] = []
    grouped[d].push(ev)
  }
  const sortedDates = Object.keys(grouped).sort()

  const tomorrow = new Date(Date.now() + 86400_000).toISOString().split('T')[0]
  const fmtDate = (dateStr) => {
    try {
      const isToday    = dateStr === today
      const isTomorrow = dateStr === tomorrow
      const label = isToday    ? 'TODAY'
                  : isTomorrow ? 'TOMORROW'
                  : new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', {
                      day: 'numeric', month: 'short', weekday: 'short',
                    })
      return { label, isToday, isTomorrow }
    } catch {
      return { label: dateStr, isToday: false, isTomorrow: false }
    }
  }

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
            background: `${t.accent}18`, border: `1px solid ${t.accent}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <span style={{ fontSize: 14 }}>📅</span>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: t.text, fontFamily: t.fontUI, letterSpacing: 0.2 }}>
              EVENTS CALENDAR
            </div>
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>
              Results · Dividends · Splits · AGMs · NSE
            </div>
          </div>
        </div>

        {todayEvents.length > 0 && (
          <>
            <div style={{ width: 1, height: 16, background: t.border }} />
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: t.radius,
              background: `${t.bear}10`, border: `1px solid ${t.bear}25`,
            }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: t.bear }} />
              <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>Today</span>
              <span style={{ fontSize: 14, fontWeight: 800, color: t.bear, fontFamily: t.fontUI }}>{todayEvents.length}</span>
            </div>
          </>
        )}

        {events.length > 0 && (
          <span style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI }}>
            {events.length} event{events.length !== 1 ? 's' : ''}
          </span>
        )}

        {/* Lookahead selector + refresh */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <select value={lookahead} onChange={e => setLookahead(Number(e.target.value))} style={{
            background: t.bgCard, color: t.text, border: `1px solid ${t.border}`,
            borderRadius: t.radiusSm, padding: '4px 8px', fontSize: 10,
            cursor: 'pointer', fontFamily: t.fontUI,
          }}>
            {[7, 14, 30].map(d => <option key={d} value={d}>Next {d} days</option>)}
          </select>
          <button
            onClick={() => triggerFetch()}
            disabled={triggering || isLoading}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 11px', borderRadius: t.radius, fontSize: 10,
              cursor: (triggering || isLoading) ? 'default' : 'pointer',
              fontFamily: t.fontUI, fontWeight: 600,
              background: (triggering || isLoading) ? `${t.border}30` : `${t.accent}18`,
              border: `1px solid ${(triggering || isLoading) ? t.border : t.accent}`,
              color: (triggering || isLoading) ? t.textDim : t.accent,
              transition: 'all 0.15s',
            }}
          >
            <span style={{ display: 'inline-block', animation: (triggering || isLoading) ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            {triggering ? 'Fetching…' : '↻ Fetch'}
          </button>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap',
        padding: '7px 16px', borderBottom: `1px solid ${t.border}`, flexShrink: 0,
      }}>
        {EVENT_TYPES.map(et => {
          const color = resolveColor(t, et.colorKey)
          const active = typeFilter === et.id
          return (
            <button key={et.id} onClick={() => setTypeFilter(et.id)} style={{
              padding: '3px 10px', borderRadius: t.radiusSm, fontSize: 10,
              cursor: 'pointer', fontFamily: t.fontUI, fontWeight: active ? 600 : 400,
              border: `1px solid ${active ? color : t.border}`,
              background: active ? `${color}18` : 'transparent',
              color: active ? color : t.textMuted,
            }}>
              {et.label}
            </button>
          )
        })}
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

      {/* ── Content ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {isLoading ? (
          <div style={{ padding: 48, textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI }}>
            <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.4 }}>📅</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim }}>Loading events…</div>
          </div>
        ) : sortedDates.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: t.textMuted, fontFamily: t.fontUI }}>
            <div style={{ fontSize: 22, marginBottom: 8, opacity: 0.3 }}>📅</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim, marginBottom: 4 }}>No events in this range.</div>
            <div style={{ fontSize: 9, color: t.textMuted }}>Try extending the date range or unchecking watchlist filter.</div>
          </div>
        ) : (
          sortedDates.map(dateStr => {
            const { label, isToday, isTomorrow } = fmtDate(dateStr)
            const dayEvents = grouped[dateStr]
            const headColor = isToday ? t.bear : isTomorrow ? t.amber : t.textMuted

            return (
              <div key={dateStr} style={{ marginBottom: 20 }}>
                {/* Date group header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginBottom: 8, paddingBottom: 5,
                  borderBottom: `1px solid ${headColor}30`,
                }}>
                  <div style={{ width: 4, height: 14, borderRadius: 2, background: headColor, flexShrink: 0 }} />
                  <span style={{
                    fontSize: 10, fontWeight: 800, color: headColor,
                    fontFamily: t.fontUI, textTransform: 'uppercase', letterSpacing: 0.8,
                  }}>
                    {label}
                  </span>
                  <span style={{
                    fontSize: 9, padding: '1px 7px', borderRadius: 10,
                    background: `${headColor}18`, color: headColor, border: `1px solid ${headColor}30`,
                    fontFamily: t.fontUI, fontWeight: 600,
                  }}>
                    {dayEvents.length}
                  </span>
                </div>

                {/* Event rows */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dayEvents.map((ev, i) => {
                    const evTypeCfg  = EVENT_TYPES.find(e => e.id === ev.event_type) || { colorKey: 'textMuted' }
                    const evColor    = resolveColor(t, evTypeCfg.colorKey)
                    return (
                      <EventRow key={i} ev={ev} evColor={evColor} t={t} />
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{
        padding: '5px 16px', borderTop: `1px solid ${t.border}`,
        fontSize: 9, color: t.textDim, fontFamily: t.fontUI, flexShrink: 0,
      }}>
        Source: NSE Event Calendar · Updated daily at 8:30 AM IST
      </div>
    </div>
  )
}

function EventRow({ ev, evColor, t }) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px', borderRadius: t.radius,
        background: hov
          ? `${evColor}08`
          : ev.on_watchlist
          ? t.bgCard
          : 'transparent',
        border: ev.on_watchlist ? `1px solid ${t.border}` : '1px solid transparent',
        transition: 'background 0.12s', cursor: 'default',
      }}
    >
      <SymAvatar symbol={ev.symbol} color={evColor} t={t} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>
            {ev.symbol}
          </span>
          {ev.on_watchlist && (
            <span style={{ fontSize: 10, color: t.amber }}>★</span>
          )}
          {ev.company_name && (
            <span style={{
              fontSize: 10, color: t.textMuted, fontFamily: t.fontUI,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {ev.company_name}
            </span>
          )}
        </div>
        {ev.details && (
          <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>{ev.details}</div>
        )}
      </div>
      <EventBadge type={ev.event_type} t={t} />
    </div>
  )
}
